"use strict";

/**
 * One-click offline mode.
 *
 * Going fully offline needs two things: the whisper.cpp binary and a ggml
 * model. Building the first from source and hand-downloading 1.5 GB for the
 * second is a high gate for something the app can just do. This module fetches
 * both into ~/.njyn, where config.js already looks for them.
 *
 * Nothing here runs on its own - it is only ever triggered by a click, and the
 * two hosts it reaches are named in the constants below.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const NJYN_DIR = path.join(os.homedir(), ".njyn");
const MODELS_DIR = path.join(NJYN_DIR, "models");
const WHISPER_DIR = path.join(NJYN_DIR, "whisper.cpp");

/** Official model weights, published by the whisper.cpp author. */
const MODEL_HOST = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** Prebuilt binaries, from the whisper.cpp releases. */
const RELEASES_API = "https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest";

/** whisper.cpp ggml files start with this magic, read as a little-endian u32. */
const GGML_MAGIC = 0x67676d6c;

/** Anything smaller than this is an error page, not a model. */
const MIN_MODEL_BYTES = 50 * 1024 * 1024;

/* ----------------------------------------------------------------- download */

/**
 * Stream a URL to disk, reporting progress. Downloads to a .part file and only
 * moves it into place once complete, so an interrupted download can never look
 * like a working install.
 */
async function downloadTo(url, destination, onProgress, { headers = {} } = {}) {
  const partial = `${destination}.part`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;

  const handle = fs.createWriteStream(partial);
  try {
    for await (const chunk of response.body) {
      handle.write(chunk);
      received += chunk.length;
      if (total) onProgress(Math.round((received / total) * 100), received, total);
      else onProgress(null, received, 0);
    }
  } finally {
    await new Promise((resolve) => handle.end(resolve));
  }

  fs.renameSync(partial, destination);
  return { path: destination, bytes: received };
}

/* -------------------------------------------------------------------- model */

function modelPath(size) {
  return path.join(MODELS_DIR, `ggml-${size}.bin`);
}

/** True when a usable model is already on disk. */
function hasModel(size) {
  try {
    return fs.statSync(modelPath(size)).size >= MIN_MODEL_BYTES;
  } catch {
    return false;
  }
}

/**
 * Check the file really is a ggml model rather than an HTML error page that
 * happened to be large. Cheap, and catches the failure mode that would
 * otherwise surface as a cryptic whisper.cpp crash mid-meeting.
 */
function verifyModel(file) {
  const buffer = Buffer.alloc(4);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (buffer.readUInt32LE(0) !== GGML_MAGIC) {
    fs.unlinkSync(file);
    throw new Error(
      "The downloaded file is not a ggml model - it has been deleted. " +
        "Check your network, or download it by hand from huggingface.co/ggerganov/whisper.cpp",
    );
  }
}

async function downloadModel(size, onProgress) {
  const destination = modelPath(size);
  if (hasModel(size)) return { path: destination, alreadyPresent: true };

  const { path: file, bytes } = await downloadTo(
    `${MODEL_HOST}/ggml-${size}.bin`,
    destination,
    (percent, received, total) => onProgress({ stage: "model", percent, received, total }),
  );

  if (bytes < MIN_MODEL_BYTES) {
    fs.unlinkSync(file);
    throw new Error(`The model download was only ${bytes} bytes - that is not the model.`);
  }
  verifyModel(file);

  return { path: file, alreadyPresent: false };
}

/* ------------------------------------------------------------------ binary */

/**
 * Find a prebuilt Windows binary in the latest whisper.cpp release.
 *
 * The asset is matched by pattern rather than pinned by name so a rename
 * upstream does not silently break this - and if nothing matches, we say so
 * instead of downloading the wrong file.
 */
async function findWindowsAsset() {
  const response = await fetch(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "njyn-meeting-notes" },
  });
  if (!response.ok) {
    throw new Error(`Could not reach the whisper.cpp releases (HTTP ${response.status}).`);
  }

  const release = await response.json();
  const assets = release.assets || [];

  // Prefer a plain x64 CPU build; the CUDA and BLAS variants need extra runtimes.
  const candidates = assets
    .filter((asset) => /\.zip$/i.test(asset.name))
    .filter((asset) => /bin-x64|win.*x64|x64.*win/i.test(asset.name))
    .filter((asset) => !/cuda|blas|clblast|vulkan|arm/i.test(asset.name));

  if (!candidates.length) {
    throw new Error(
      `No prebuilt Windows binary in whisper.cpp ${release.tag_name || "latest"}. ` +
        "Build it from source - see the README - or install it yourself into ~/.njyn/whisper.cpp.",
    );
  }
  return { asset: candidates[0], tag: release.tag_name };
}

/** Unzip using what the OS already has, rather than taking on a dependency. */
function unzip(archive, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destination, { recursive: true });

    const [command, args] =
      process.platform === "win32"
        ? [
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`,
            ],
          ]
        : ["unzip", ["-o", archive, "-d", destination]];

    execFile(command, args, { windowsHide: true }, (err) =>
      err ? reject(new Error(`Could not extract ${path.basename(archive)}: ${err.message}`)) : resolve(),
    );
  });
}

/** Locate the CLI inside an extracted release, wherever it nested itself. */
function findBinary(root) {
  const wanted = process.platform === "win32"
    ? ["whisper-cli.exe", "main.exe"]
    : ["whisper-cli", "main"];

  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const name of wanted) {
      if (entries.some((entry) => entry.isFile() && entry.name === name)) {
        return path.join(dir, name);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  return null;
}

/**
 * Install a prebuilt whisper.cpp. Windows only - there is no official prebuilt
 * CLI for macOS or Linux, and shipping an unofficial binary from an unnamed
 * source is not something this app should do quietly.
 */
async function downloadWhisperBinary(onProgress) {
  if (process.platform !== "win32") {
    throw new Error(
      "There is no official prebuilt whisper.cpp for this platform. " +
        "Build it from source - the README has the four commands - and it will be picked up automatically.",
    );
  }

  const { asset, tag } = await findWindowsAsset();
  const archive = path.join(os.tmpdir(), `njyn-${asset.name}`);

  await downloadTo(asset.browser_download_url, archive, (percent, received, total) =>
    onProgress({ stage: "binary", percent, received, total }),
  );

  onProgress({ stage: "extracting", percent: null });
  const extractDir = path.join(WHISPER_DIR, "build", "bin");
  fs.rmSync(extractDir, { recursive: true, force: true });
  await unzip(archive, extractDir);

  try {
    fs.unlinkSync(archive);
  } catch {
    /* leave it in temp */
  }

  const binary = findBinary(extractDir);
  if (!binary) {
    throw new Error(`Downloaded whisper.cpp ${tag} but found no CLI inside the archive.`);
  }
  fs.chmodSync(binary, 0o755);

  return { path: binary, tag };
}

/** Whether one-click install is available here at all. */
function canInstallBinary() {
  return process.platform === "win32";
}

module.exports = {
  downloadModel,
  downloadWhisperBinary,
  hasModel,
  modelPath,
  canInstallBinary,
  MODELS_DIR,
  WHISPER_DIR,
};
