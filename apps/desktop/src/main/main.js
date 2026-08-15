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
const { WavWriter } = require("./wav");
const { transcribe } = require("./transcribe");
const { summarize } = require("./summarize");
const { sessionPaths, buildMarkdown, writeNote, formatDuration } = require("./notes");

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
};

let tray = null;
let captureWin = null;
let panelWin = null;
let config = null;
let tickTimer = null;

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
    },
  };
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

  setPhase("processing");

  let transcript = "";
  let transcriptEngine = "unknown";
  let summaryMarkdown = "";
  let summaryError = null;
  let title = null;
  let llmModel = null;

  try {
    state.progress = { stage: "Transcribing", percent: 0 };
    pushUi();

    const result = await transcribe(config, paths.wavPath, (percent) => {
      state.progress = { stage: "Transcribing", percent };
      refreshTray();
      pushUi();
    });
    transcript = result.text;
    transcriptEngine = result.engine;
  } catch (err) {
    // Without a transcript there is nothing to summarise, but the audio is
    // still on disk and the note records why.
    state.lastError = err.message;
    transcriptEngine = "failed";
    summaryError = `transcription failed - ${err.message}`;
  }

  if (transcript) {
    try {
      state.progress = { stage: "Summarising", percent: null };
      refreshTray();
      pushUi();

      const summary = await summarize(config, transcript);
      summaryMarkdown = summary.markdown;
      title = summary.title;
      llmModel = summary.model;
    } catch (err) {
      summaryError = err.message;
      state.lastError = err.message;
    }
  }

  const markdown = buildMarkdown({
    stamp: paths.stamp,
    startedAt: paths.startedAt,
    durationSeconds,
    title,
    summaryMarkdown,
    summaryError,
    transcript,
    transcriptEngine,
    llmModel,
    audioFile: config.keepAudio ? path.basename(paths.wavPath) : null,
  });

  writeNote(paths.mdPath, markdown);

  if (!config.keepAudio) {
    try {
      fs.unlinkSync(paths.wavPath);
    } catch {
      /* already gone */
    }
  }

  state.lastNote = {
    mdPath: paths.mdPath,
    wavPath: config.keepAudio ? paths.wavPath : null,
    stamp: paths.stamp,
    title,
    durationSeconds,
    hadError: Boolean(summaryError),
  };
  state.progress = null;
  state.session = null;
  state.startedAt = null;
  setPhase("idle");

  notify(
    summaryError ? "Notes saved with a warning" : "Notes saved",
    summaryError ? `${paths.stamp}.md — ${summaryError}` : `${paths.stamp}.md`,
  );
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

  if (!config.localReady && !config.keys.groq && !config.keys.openai) {
    showPanel(); // First run with nothing configured: show the setup checklist.
  }
});

// Electron quits when the last window closes only if nothing is listening for
// this event. A tray app has to stay alive with no windows open, so the empty
// listener is the point.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  app.isQuitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
