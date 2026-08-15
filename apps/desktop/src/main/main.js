"use strict";

/**
 * njyn Meeting Notes - tray application.
 *
 * Lives in the system tray with one job: Start Recording / Stop Recording.
 * A hidden renderer window does the audio capture (Chromium owns the loopback
 * and microphone plumbing); this process owns the state machine, the WAV file,
 * transcription, summarising, and writing the note.
 *
 * Nothing is uploaded except the two API calls you configure in .env, and there
 * is no analytics, no account, and no background network activity at rest.
 */

const path = require("path");
const fs = require("fs");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  nativeImage,
  desktopCapturer,
  session,
  dialog,
  globalShortcut,
  Notification,
} = require("electron");

const { buildConfig } = require("./config");
const { WavWriter, readWavInfo } = require("./wav");
const { processAudio, scanRecordings } = require("./pipeline");
const { sessionPaths, parseStamp, formatDuration } = require("./notes");
const appSettings = require("./settings");
const autostart = require("./autostart");
const setup = require("./setup");

const APP_DIR = path.join(__dirname, "..", "..");
const ASSETS = path.join(APP_DIR, "assets");

/** Works from inside a call, where the tray is behind a full-screen window. */
const TOGGLE_SHORTCUT = "CommandOrControl+Shift+R";

/** Single instance only - two trays would fight over the microphone. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ------------------------------------------------------------------ state */

const state = {
  /** idle | recording | processing */
  phase: "idle",
  session: null, // { stamp, mdPath, wavPath, startedAt }
  writer: null,
  sources: { mic: false, system: false },
  startedAt: null,
  level: 0,
  progress: null, // { stage, percent }
  lastNote: null,
  lastError: null,
  /** Set while a whisper.cpp / model download is running. */
  install: null, // { stage, percent, received, total }
};

let tray = null;
let captureWin = null;
let panelWin = null;
let config = null;
let tickTimer = null;
let autostartEnabled = false;

/* ---------------------------------------------------------------- helpers */

function trayImage(name) {
  const img = nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
  // macOS wants a small template-sized image; Windows/Linux scale fine.
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function elapsedSeconds() {
  return state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({
    title,
    body,
    icon: path.join(ASSETS, "icon.png"),
    silent: true,
  }).show();
}

/** Everything the panel window needs to render itself. */
function uiState() {
  return {
    phase: state.phase,
    elapsed: elapsedSeconds(),
    level: state.level,
    sources: state.sources,
    progress: state.progress,
    lastNote: state.lastNote,
    lastError: state.lastError,
    install: state.install,
    startAtLogin: autostartEnabled,
    canInstallWhisper: setup.canInstallBinary(),
    needsAttention: needsAttention(),
    setupComplete: appSettings.read().setupComplete,
    config: config && {
      notesDir: config.notesDir,
      transcribeMode: config.transcribeMode,
      localReady: config.localReady,
      whisperBin: config.whisperBin,
      whisperModel: config.whisperModel,
      llmProvider: config.llmProvider,
      llmModel: config.llmModel,
      envPaths: config.envPaths,
      offlineCapable: config.localReady,
      hasAnyEngine: config.localReady || Boolean(config.keys.groq || config.keys.openai),
    },
  };
}

/** Recordings whose note is missing or was written after a failure. */
function needsAttention() {
  if (!config) return [];
  return scanRecordings(config.notesDir)
    .filter((entry) => entry.needsAttention)
    .slice(0, 5)
    .map(({ stamp, reason, durationSeconds }) => ({ stamp, reason, durationSeconds }));
}

function pushUi() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send("ui:state", uiState());
  }
}

function refreshTray() {
  if (!tray) return;

  const recording = state.phase === "recording";
  tray.setImage(trayImage(recording ? "tray-rec" : "tray-idle"));

  const statusLabel =
    state.phase === "recording"
      ? `Recording · ${formatDuration(elapsedSeconds())}`
      : state.phase === "processing"
        ? `${state.progress?.stage || "Working"}${
            state.progress?.percent != null ? ` · ${state.progress.percent}%` : ""
          }`
        : "Idle";

  const menu = Menu.buildFromTemplate([
    { label: `njyn Meeting Notes — ${statusLabel}`, enabled: false },
    { type: "separator" },
    {
      label: recording ? "Stop Recording" : "Start Recording",
      enabled: state.phase !== "processing",
      // Matches the global shortcut registered at startup.
      accelerator: TOGGLE_SHORTCUT,
      registerAccelerator: false,
      click: () => toggleRecording(),
    },
    { type: "separator" },
    { label: "Open panel", click: showPanel },
    {
      label: "Open notes folder",
      click: () => shell.openPath(config.notesDir),
    },
    {
      label: "Open last note",
      enabled: Boolean(state.lastNote?.mdPath),
      click: () => state.lastNote && shell.openPath(state.lastNote.mdPath),
    },
    { type: "separator" },
    {
      label: "Re-process a recording…",
      enabled: state.phase === "idle",
      click: () => reprocessFromDisk(),
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: autostartEnabled,
      click: (item) => setAutostart(item.checked),
    },
    { type: "separator" },
    {
      label: "Reload .env",
      click: () => {
        config = buildConfig(APP_DIR);
        pushUi();
        refreshTray();
        notify("njyn Meeting Notes", "Configuration reloaded.");
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => quit() },
  ]);

  tray.setToolTip(`njyn Meeting Notes — ${statusLabel}`);
  tray.setContextMenu(menu);
}

function setPhase(phase) {
  state.phase = phase;
  refreshTray();
  pushUi();
}

/** Writes the preference, then reports back what the OS actually did. */
function setAutostart(enabled) {
  autostartEnabled = autostart.setEnabled(enabled);
  appSettings.write({ startAtLogin: autostartEnabled });
  refreshTray();
  pushUi();
  return autostartEnabled;
}

/**
 * Fetch whisper.cpp and the medium model into ~/.njyn.
 *
 * @param {"model"|"all"} what
 */
async function installOffline(what) {
  if (state.install) return; // already running

  state.install = { stage: "starting", percent: null };
  state.lastError = null;
  pushUi();

  const onProgress = (progress) => {
    state.install = progress;
    pushUi();
  };

  try {
    if (what === "all" && setup.canInstallBinary()) {
      await setup.downloadWhisperBinary(onProgress);
    }
    await setup.downloadModel(config.whisperModelSize || "medium", onProgress);

    config = buildConfig(APP_DIR);
    state.install = null;
    notify(
      "Offline mode ready",
      config.localReady
        ? "whisper.cpp and the medium model are installed. Nothing leaves this machine now."
        : "The model is installed, but whisper.cpp was not found. See the README.",
    );
  } catch (err) {
    state.install = null;
    state.lastError = err.message;
    notify("Offline setup failed", err.message);
  }

  refreshTray();
  pushUi();
}

/* ---------------------------------------------------------------- windows */

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, "src", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window would otherwise be throttled, which stutters capture.
      backgroundThrottling: false,
    },
  });
  captureWin.loadFile(path.join(APP_DIR, "src", "renderer", "capture.html"));
}

function createPanelWindow() {
  panelWin = new BrowserWindow({
    width: 420,
    height: 620,
    show: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: "njyn Meeting Notes",
    backgroundColor: "#0B0E1A",
    icon: path.join(ASSETS, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, "src", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  panelWin.loadFile(path.join(APP_DIR, "src", "renderer", "panel.html"));
  panelWin.on("close", (e) => {
    // Closing the panel should not quit a tray app.
    if (!app.isQuitting) {
      e.preventDefault();
      panelWin.hide();
    }
  });
  panelWin.webContents.on("did-finish-load", pushUi);
}

function showPanel() {
  if (!panelWin || panelWin.isDestroyed()) createPanelWindow();
  panelWin.show();
  panelWin.focus();
  pushUi();
}

/* -------------------------------------------------------------- recording */

async function startRecording() {
  if (state.phase !== "idle") return;

  config = buildConfig(APP_DIR);

  let paths;
  try {
    paths = sessionPaths(config.notesDir);
  } catch (err) {
    dialog.showErrorBox("njyn Meeting Notes", `Cannot write to ${config.notesDir}: ${err.message}`);
    return;
  }

  state.session = paths;
  state.writer = new WavWriter(paths.wavPath, { sampleRate: 16000, channels: 1 });
  state.startedAt = Date.now();
  state.sources = { mic: false, system: false };
  state.lastError = null;
  state.progress = null;
  setPhase("recording");

  captureWin.webContents.send("capture:start");

  // Keep the tray clock and panel ticking while we record.
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    refreshTray();
    pushUi();
  }, 1000);
}

function toggleRecording() {
  if (state.phase === "recording") stopRecording();
  else if (state.phase === "idle") startRecording();
}

function stopRecording() {
  if (state.phase !== "recording") return;
  captureWin.webContents.send("capture:stop");
  // The pipeline continues in the capture:stopped handler, once the renderer
  // has flushed its final audio buffers.
}

/** Runs after capture has fully stopped: transcribe, summarise, write. */
async function processRecording() {
  clearInterval(tickTimer);
  tickTimer = null;

  const { writer, session: paths } = state;
  const durationSeconds = writer.durationSeconds;
  writer.close();
  state.writer = null;

  if (durationSeconds < 1) {
    // Nothing usable - clean up rather than leaving a stub note behind.
    try {
      fs.unlinkSync(paths.wavPath);
    } catch {
      /* already gone */
    }
    state.lastError = "Recording was under a second - nothing was saved.";
    setPhase("idle");
    notify("njyn Meeting Notes", state.lastError);
    return;
  }

  await runPipeline({
    wavPath: paths.wavPath,
    mdPath: paths.mdPath,
    stamp: paths.stamp,
    startedAt: paths.startedAt,
    durationSeconds,
  });

  state.session = null;
  state.startedAt = null;
}

/**
 * Transcribe, summarise and save. Shared by a meeting that just ended and by a
 * retry of one that failed, so recovering a recording is the same code path -
 * not a second, less-tested one.
 */
async function runPipeline({ wavPath, mdPath, stamp, startedAt, durationSeconds }) {
  setPhase("processing");
  state.lastError = null;

  let result;
  try {
    result = await processAudio({
      config,
      wavPath,
      mdPath,
      stamp,
      startedAt,
      durationSeconds,
      keepAudio: config.keepAudio,
      onProgress: (stage, percent) => {
        state.progress = { stage, percent };
        refreshTray();
        pushUi();
      },
    });
  } catch (err) {
    // processAudio handles its own failures; reaching here means the note
    // could not be written at all, which is the one case worth shouting about.
    state.lastError = `Could not write the note: ${err.message}`;
    state.progress = null;
    setPhase("idle");
    notify("njyn Meeting Notes", state.lastError);
    return;
  }

  if (result.summaryError) state.lastError = result.summaryError;

  state.lastNote = {
    mdPath: result.mdPath,
    wavPath: config.keepAudio ? wavPath : null,
    stamp,
    title: result.title,
    durationSeconds,
    hadError: Boolean(result.summaryError),
  };
  state.progress = null;
  setPhase("idle");

  notify(
    result.summaryError ? "Notes saved with a warning" : "Notes saved",
    result.summaryError ? `${stamp}.md — ${result.summaryError}` : `${stamp}.md`,
  );
}

/**
 * Run an existing recording through the pipeline again.
 *
 * This is the answer to a transcription that died on a bad key or a dropped
 * connection: the .wav is still there, so the note can simply be rebuilt.
 */
async function reprocess(stamp) {
  if (state.phase !== "idle") return;

  config = buildConfig(APP_DIR);
  const wavPath = path.join(config.notesDir, `${stamp}.wav`);

  if (!fs.existsSync(wavPath)) {
    state.lastError = `${stamp}.wav is no longer in ${config.notesDir}.`;
    pushUi();
    return;
  }

  let durationSeconds = 0;
  try {
    durationSeconds = readWavInfo(wavPath).durationSeconds;
  } catch (err) {
    state.lastError = `${stamp}.wav could not be read: ${err.message}`;
    pushUi();
    return;
  }

  await runPipeline({
    wavPath,
    mdPath: path.join(config.notesDir, `${stamp}.md`),
    stamp,
    // Fall back to the file's own timestamp if the name is not one of ours.
    startedAt: parseStamp(stamp) || fs.statSync(wavPath).mtime,
    durationSeconds,
  });
}

/** Pick any .wav from disk and run it through the pipeline. */
async function reprocessFromDisk() {
  if (state.phase !== "idle") return;

  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Re-process a recording",
    defaultPath: config.notesDir,
    filters: [{ name: "Recordings", extensions: ["wav"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return;

  const chosen = filePaths[0];
  const stamp = path.basename(chosen, ".wav");

  // Recordings kept elsewhere are copied in, so the note and its audio still
  // end up side by side in the notes folder.
  const target = path.join(config.notesDir, `${stamp}.wav`);
  if (path.resolve(chosen) !== path.resolve(target)) {
    fs.mkdirSync(config.notesDir, { recursive: true });
    fs.copyFileSync(chosen, target);
  }
  await reprocess(stamp);
}

/* -------------------------------------------------------------------- IPC */

// Audio arrives as Int16 PCM buffers straight from the capture renderer.
ipcMain.on("audio:chunk", (_event, chunk) => {
  if (state.writer && state.phase === "recording") {
    state.writer.write(Buffer.from(chunk));
  }
});

ipcMain.on("audio:level", (_event, level) => {
  state.level = level;
});

ipcMain.on("capture:started", (_event, sources) => {
  state.sources = sources;
  pushUi();
  if (!sources.system) {
    notify(
      "Microphone only",
      "System audio could not be captured, so only your side of the call is being recorded. See the README.",
    );
  }
});

ipcMain.on("capture:failed", (_event, message) => {
  state.lastError = message;
  if (state.writer) state.writer.abort();
  state.writer = null;
  state.session = null;
  state.startedAt = null;
  clearInterval(tickTimer);
  tickTimer = null;
  setPhase("idle");
  dialog.showErrorBox("njyn Meeting Notes — capture failed", message);
});

ipcMain.on("capture:stopped", () => {
  if (state.phase === "recording") processRecording();
});

ipcMain.handle("ui:get", () => uiState());
ipcMain.handle("ui:start", () => startRecording());
ipcMain.handle("ui:stop", () => stopRecording());
ipcMain.handle("ui:openNotesDir", () => shell.openPath(config.notesDir));
ipcMain.handle("ui:openLastNote", () =>
  state.lastNote ? shell.openPath(state.lastNote.mdPath) : null,
);
ipcMain.handle("ui:reloadConfig", () => {
  config = buildConfig(APP_DIR);
  refreshTray();
  return uiState();
});
ipcMain.handle("ui:recentNotes", () => {
  try {
    return fs
      .readdirSync(config.notesDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, 8)
      .map((f) => ({ name: f, path: path.join(config.notesDir, f) }));
  } catch {
    return [];
  }
});
ipcMain.handle("ui:reprocess", (_event, stamp) => reprocess(stamp));
ipcMain.handle("ui:reprocessFromDisk", () => reprocessFromDisk());
ipcMain.handle("ui:setAutostart", (_event, enabled) => setAutostart(Boolean(enabled)));
ipcMain.handle("ui:installOffline", (_event, what) => installOffline(what === "all" ? "all" : "model"));
ipcMain.handle("ui:completeSetup", () => {
  appSettings.write({ setupComplete: true });
  pushUi();
});
ipcMain.handle("ui:openExternal", (_event, url) => {
  // Only ever the two documented setup destinations.
  const allowed = ["https://console.anthropic.com/", "https://console.groq.com/keys"];
  if (allowed.includes(url)) return shell.openExternal(url);
  return null;
});
ipcMain.handle("ui:openPath", (_event, target) => {
  // Only ever open something inside the notes directory.
  const resolved = path.resolve(target);
  if (resolved.startsWith(path.resolve(config.notesDir))) return shell.openPath(resolved);
  return null;
});

/* ------------------------------------------------------------------ setup */

function quit() {
  app.isQuitting = true;
  if (state.phase === "recording") {
    // Do not lose the audio on the way out.
    if (state.writer) state.writer.close();
  }
  app.quit();
}

app.on("second-instance", showPanel);

app.whenReady().then(() => {
  config = buildConfig(APP_DIR);

  // A tray app has no business in the macOS dock.
  if (process.platform === "darwin" && app.dock) app.dock.hide();

  const ses = session.defaultSession;

  /**
   * Grant the capture window microphone and display access without prompting -
   * the user already asked for a recording by clicking Start, and the OS-level
   * permission dialog (macOS TCC, Windows privacy settings) still applies.
   */
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["media", "audioCapture", "display-capture"].includes(permission));
  });

  /**
   * getDisplayMedia in the capture window resolves here. `audio: 'loopback'`
   * is what gives us the other participants' voices, and it is supported on
   * Windows and on Linux under PipeWire. Where the platform declines, the
   * request simply fails and the renderer carries on with the microphone
   * alone rather than aborting the recording.
   *
   * The video source is requested only because system-audio capture is tied
   * to a screen-capture grant; no frame is ever read or written.
   */
  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        if (!sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: "loopback" });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  autostartEnabled = autostart.isEnabled();

  createCaptureWindow();
  createPanelWindow();

  tray = new Tray(trayImage("tray-idle"));
  refreshTray();
  tray.on("click", showPanel);
  tray.on("double-click", showPanel);

  // Not fatal if another app already owns the combination.
  if (!globalShortcut.register(TOGGLE_SHORTCUT, toggleRecording)) {
    console.warn(`Could not register ${TOGGLE_SHORTCUT}; use the tray menu instead.`);
  }

  // Show the setup screen on a first run that cannot record anything useful -
  // but never when the login item started us, since nobody is at the machine.
  const canWork = config.localReady || config.keys.groq || config.keys.openai;
  if (!canWork && !autostart.launchedAtLogin()) showPanel();
});

// Electron quits when the last window closes only if nothing is listening for
// this event. A tray app has to stay alive with no windows open, so the empty
// listener is the point.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  app.isQuitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
