"use strict";

/**
 * Audio -> text.
 *
 * Two paths, chosen in config.js:
 *   local  - whisper.cpp on this machine, no network at all
 *   hosted - Groq or OpenAI Whisper, only if a key is in .env
 *
 * The audio file itself never leaves the machine on the local path, and on the
 * hosted path it goes to exactly one endpoint - the one whose key you supplied.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { splitWav, readWavInfo } = require("./wav");

// Hosted Whisper endpoints reject uploads over 25 MB. Stay under it with room
// to spare for the multipart envelope.
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const CHUNK_SECONDS = 600;

const ENDPOINTS = {
  groq: {
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "whisper-large-v3",
    keyName: "groq",
  },
  openai: {
    url: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    keyName: "openai",
  },
};

/* ------------------------------------------------------------------ local */

function runWhisperCpp(config, wavPath, onProgress) {
  return new Promise((resolve, reject) => {
    const outBase = path.join(
      os.tmpdir(),
      `njyn-whisper-${process.pid}-${path.basename(wavPath, ".wav")}`,
    );

    const args = [
      "-m", config.whisperModel,
      "-f", wavPath,
      "-otxt",              // write <outBase>.txt
      "-of", outBase,
      "-nt",                // no timestamps in the transcript body
      "-pp",                // print progress so the UI can show it
    ];
    if (config.whisperLanguage && config.whisperLanguage !== "auto") {
      args.push("-l", config.whisperLanguage);
    }
    if (config.whisperThreads > 0) {
      args.push("-t", String(config.whisperThreads));
    }

    const child = spawn(config.whisperBin, args, { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (buf) => {
      const text = buf.toString();
      stderr += text;
      // whisper.cpp reports "progress = 42%" on stderr with -pp.
      const matches = text.match(/progress\s*=\s*(\d+)%/g);
      if (matches && onProgress) {
        const last = matches[matches.length - 1].match(/(\d+)%/);
        if (last) onProgress(Number(last[1]));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Could not run whisper.cpp at ${config.whisperBin}: ${err.message}`));
    });

    child.on("close", (code) => {
      const txtPath = `${outBase}.txt`;
      if (code !== 0) {
        reject(
          new Error(
            `whisper.cpp exited with code ${code}.\n${stderr.trim().split("\n").slice(-8).join("\n")}`,
          ),
        );
        return;
      }
      try {
        const text = fs.readFileSync(txtPath, "utf8");
        fs.unlinkSync(txtPath);
        resolve(text.trim());
      } catch (err) {
        reject(new Error(`whisper.cpp finished but produced no transcript: ${err.message}`));
      }
    });
  });
}

/* ----------------------------------------------------------------- hosted */

async function postTranscription(provider, key, wavPath) {
  const endpoint = ENDPOINTS[provider];
  const audio = fs.readFileSync(wavPath);

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), path.basename(wavPath));
  form.append("model", endpoint.model);
  form.append("response_format", "text");

  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`${provider} transcription failed (HTTP ${res.status}): ${detail}`);
  }
  return (await res.text()).trim();
}

async function runHostedWhisper(config, wavPath, onProgress) {
  const provider = config.transcribeMode;
  const key = config.keys[ENDPOINTS[provider].keyName];
  if (!key) throw new Error(`No API key configured for ${provider}.`);

  const size = fs.statSync(wavPath).size;
  if (size <= MAX_UPLOAD_BYTES) {
    if (onProgress) onProgress(10);
    const text = await postTranscription(provider, key, wavPath);
    if (onProgress) onProgress(100);
    return text;
  }

  // Long meeting: split, upload each piece, stitch.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "njyn-chunks-"));
  try {
    const parts = splitWav(wavPath, workDir, { chunkSeconds: CHUNK_SECONDS });
    const pieces = [];
    for (let i = 0; i < parts.length; i++) {
      pieces.push(await postTranscription(provider, key, parts[i]));
      if (onProgress) onProgress(Math.round(((i + 1) / parts.length) * 100));
    }
    return stitch(pieces);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Join chunk transcripts, dropping the duplicated tail that the chunk overlap
 * produces. Compares the last words of one piece against the first words of the
 * next and trims the longest run that matches.
 */
function stitch(pieces) {
  const clean = pieces.map((p) => p.trim()).filter(Boolean);
  if (clean.length <= 1) return clean.join(" ");

  let out = clean[0];
  for (let i = 1; i < clean.length; i++) {
    const prevWords = out.split(/\s+/);
    const nextWords = clean[i].split(/\s+/);
    const window = Math.min(20, prevWords.length, nextWords.length);

    let overlap = 0;
    for (let n = window; n > 2; n--) {
      const tail = prevWords.slice(-n).join(" ").toLowerCase();
      const head = nextWords.slice(0, n).join(" ").toLowerCase();
      if (tail === head) {
        overlap = n;
        break;
      }
    }
    out = `${out} ${nextWords.slice(overlap).join(" ")}`.trim();
  }
  return out;
}

/* ------------------------------------------------------------------ entry */

/**
 * @returns {Promise<{text: string, engine: string}>}
 */
async function transcribe(config, wavPath, onProgress) {
  const info = readWavInfo(wavPath);
  if (info.dataBytes === 0) {
    throw new Error("The recording is empty - no audio was captured.");
  }

  if (config.transcribeMode === "local") {
    if (!config.whisperBin || !config.whisperModel) {
      throw new Error(
        "whisper.cpp is not installed and no OPENAI_API_KEY or GROQ_API_KEY was found. " +
          "See the README for the two-command local setup, or add a key to .env.",
      );
    }
    const text = await runWhisperCpp(config, wavPath, onProgress);
    return { text, engine: `whisper.cpp (${path.basename(config.whisperModel)}), offline` };
  }

  const text = await runHostedWhisper(config, wavPath, onProgress);
  return { text, engine: `${config.transcribeMode} ${ENDPOINTS[config.transcribeMode].model}` };
}

module.exports = { transcribe, stitch };
