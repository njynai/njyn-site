"use strict";

/**
 * Configuration for njyn Meeting Notes.
 *
 * Everything comes from a .env file that never leaves the machine. We look in
 * two places so a packaged build can be configured without touching app files:
 *
 *   1. <app>/.env            - next to the app, handy while developing
 *   2. ~/.njyn/.env          - the durable location, survives reinstalls
 *
 * Keys found in the app directory win. No key is ever written back out, and
 * nothing here is transmitted anywhere except to the provider you configured.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();

/** Minimal .env parser. No dependency, no shell evaluation, no surprises. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();

    // Strip matching quotes; leave inner content exactly as written.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Expand a leading ~ so users can write ~/whisper.cpp in .env. */
function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(HOME, p.slice(2));
  return p;
}

function loadEnv(appDir) {
  const userEnv = readEnvFile(path.join(HOME, ".njyn", ".env"));
  const appEnv = readEnvFile(path.join(appDir, ".env"));
  // process.env comes last as a base so real environment variables work too,
  // but an explicit .env entry always wins over an inherited one.
  return { ...process.env, ...userEnv, ...appEnv };
}

/**
 * Resolve the whisper.cpp binary. Honours WHISPER_CPP_PATH, otherwise probes
 * the layouts whisper.cpp actually produces (the CMake build puts binaries in
 * build/bin, older Makefile builds put `main` at the repo root).
 */
function findWhisperBinary(env) {
  const explicit = expandHome(env.WHISPER_CPP_PATH);
  if (explicit && fs.existsSync(explicit)) return explicit;

  const exe = process.platform === "win32" ? ".exe" : "";
  const roots = [
    path.join(HOME, ".njyn", "whisper.cpp"),
    path.join(HOME, "whisper.cpp"),
    path.join(HOME, "src", "whisper.cpp"),
    path.join(process.cwd(), "vendor", "whisper.cpp"),
  ];
  const relatives = [
    path.join("build", "bin", `whisper-cli${exe}`),
    path.join("build", "bin", `main${exe}`),
    path.join("build", "bin", "Release", `whisper-cli${exe}`),
    path.join("build", "bin", "Release", `main${exe}`),
    `whisper-cli${exe}`,
    `main${exe}`,
  ];

  for (const root of roots) {
    for (const rel of relatives) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Last resort: something on PATH.
  for (const name of [`whisper-cli${exe}`, `whisper${exe}`]) {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve the ggml model file. Defaults to the medium model per spec. */
function findWhisperModel(env) {
  const explicit = expandHome(env.WHISPER_MODEL_PATH);
  if (explicit && fs.existsSync(explicit)) return explicit;

  const preferred = env.WHISPER_MODEL || "medium";
  // Try the requested size first, then quantised and smaller fallbacks so a
  // partial install still works offline rather than silently going online.
  const names = [
    `ggml-${preferred}.bin`,
    `ggml-${preferred}.en.bin`,
    `ggml-${preferred}-q5_0.bin`,
    "ggml-medium.bin",
    "ggml-small.bin",
    "ggml-base.bin",
  ];
  const dirs = [
    path.join(HOME, ".njyn", "models"),
    path.join(HOME, "whisper.cpp", "models"),
    path.join(HOME, ".njyn", "whisper.cpp", "models"),
    path.join(process.cwd(), "vendor", "whisper.cpp", "models"),
  ];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Build the effective config.
 *
 * `transcribeMode` decides how audio becomes text:
 *   local  - whisper.cpp, fully offline
 *   groq   - Groq's hosted Whisper (fast, cheap)
 *   openai - OpenAI's hosted Whisper
 *
 * TRANSCRIBE_PROVIDER pins it explicitly. Left unset, whisper.cpp wins whenever
 * a binary and model are present, which is what "work fully offline if
 * whisper.cpp + a local model are available" asks for.
 */
function buildConfig(appDir) {
  const env = loadEnv(appDir);

  const whisperBin = findWhisperBinary(env);
  const whisperModel = findWhisperModel(env);
  const localReady = Boolean(whisperBin && whisperModel);

  const groqKey = env.GROQ_API_KEY || "";
  const openaiKey = env.OPENAI_API_KEY || "";
  const anthropicKey = env.ANTHROPIC_API_KEY || "";

  const pinned = (env.TRANSCRIBE_PROVIDER || "").toLowerCase();
  let transcribeMode;
  if (pinned === "local" || pinned === "whisper.cpp") transcribeMode = "local";
  else if (pinned === "groq" && groqKey) transcribeMode = "groq";
  else if (pinned === "openai" && openaiKey) transcribeMode = "openai";
  else if (localReady) transcribeMode = "local";
  else if (groqKey) transcribeMode = "groq";
  else if (openaiKey) transcribeMode = "openai";
  else transcribeMode = "local"; // will report a clear "not installed" error

  // Summarising always needs a hosted model. Prefer Anthropic, then OpenAI,
  // then Groq, unless LLM_PROVIDER pins one.
  const llmPinned = (env.LLM_PROVIDER || "").toLowerCase();
  let llmProvider = null;
  if (llmPinned === "anthropic" && anthropicKey) llmProvider = "anthropic";
  else if (llmPinned === "openai" && openaiKey) llmProvider = "openai";
  else if (llmPinned === "groq" && groqKey) llmProvider = "groq";
  else if (anthropicKey) llmProvider = "anthropic";
  else if (openaiKey) llmProvider = "openai";
  else if (groqKey) llmProvider = "groq";

  const notesDir = expandHome(env.NOTES_DIR) || path.join(HOME, "MeetingNotes");

  return {
    notesDir,
    keepAudio: (env.KEEP_AUDIO || "true").toLowerCase() !== "false",

    transcribeMode,
    localReady,
    whisperBin,
    whisperModel,
    /** Which size to fetch if the user asks the app to install one. */
    whisperModelSize: env.WHISPER_MODEL || "medium",
    whisperLanguage: env.WHISPER_LANGUAGE || "auto",
    whisperThreads: Number(env.WHISPER_THREADS) || 0, // 0 = let whisper decide

    llmProvider,
    llmModel:
      env.LLM_MODEL ||
      { anthropic: "claude-sonnet-5", openai: "gpt-4o-mini", groq: "llama-3.3-70b-versatile" }[
        llmProvider
      ] ||
      null,

    keys: { groq: groqKey, openai: openaiKey, anthropic: anthropicKey },

    // Where .env should live, surfaced in the UI so setup is discoverable.
    envPaths: [path.join(appDir, ".env"), path.join(HOME, ".njyn", ".env")],
  };
}

module.exports = { buildConfig, expandHome, parseEnv };
