"use strict";

/** Panel window. Pure view over the state the main process pushes down. */

const el = (id) => document.getElementById(id);

const ui = {
  setup: el("setup"),
  recorder: el("recorder"),
  envPath: el("env-path"),
  stepKey: el("step-key"),
  stepOffline: el("step-offline"),
  installProgress: el("install-progress"),
  installStage: el("install-stage"),
  installBar: el("install-bar"),
  installDetail: el("install-detail"),
  installButton: el("install-offline"),
  installNote: el("install-note"),
  setupNotice: el("setup-notice"),
  attentionSection: el("attention-section"),
  attention: el("attention"),
  autostart: el("autostart"),
  status: el("status"),
  clock: el("clock"),
  meter: el("meter"),
  action: el("action"),
  chipMic: el("chip-mic"),
  chipSys: el("chip-sys"),
  noticeSlot: el("notice-slot"),
  engineStt: el("engine-stt"),
  engineLlm: el("engine-llm"),
  engineOffline: el("engine-offline"),
  notes: el("notes"),
  notesEmpty: el("notes-empty"),
  notesDir: el("notes-dir"),
};

function bytes(n) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function duration(seconds) {
  const total = Math.round(seconds || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function clock(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** Small helper so notices are built from text nodes, never innerHTML. */
function notice(kind, lines) {
  const box = document.createElement("div");
  box.className = kind === "info" ? "notice info" : "notice";
  lines.forEach((line, i) => {
    if (i > 0) box.appendChild(document.createElement("br"));
    if (typeof line === "string") {
      box.appendChild(document.createTextNode(line));
    } else {
      const code = document.createElement("code");
      code.textContent = line.code;
      box.appendChild(code);
    }
  });
  return box;
}

function renderNotices(state) {
  const cfg = state.config;
  ui.noticeSlot.replaceChildren();
  if (!cfg) return;

  if (state.lastError) {
    ui.noticeSlot.appendChild(notice("error", [state.lastError]));
  }

  const noStt = !cfg.localReady && cfg.transcribeMode === "local";
  if (noStt) {
    ui.noticeSlot.appendChild(
      notice("error", [
        "No transcription engine available.",
        "Install whisper.cpp with the medium model for offline use, or add a key to:",
        { code: cfg.envPaths[1] },
      ]),
    );
  }

  if (!cfg.llmProvider) {
    ui.noticeSlot.appendChild(
      notice("info", [
        "No LLM key found, so notes will be transcript-only.",
        "Add ANTHROPIC_API_KEY, OPENAI_API_KEY or GROQ_API_KEY to:",
        { code: cfg.envPaths[1] },
      ]),
    );
  }
}

let wasInstalling = false;

/**
 * The setup screen replaces the recorder until there is something that can
 * transcribe - or until the user says they will deal with it later.
 */
function renderSetup(state) {
  const cfg = state.config;
  const showSetup = Boolean(cfg) && !cfg.hasAnyEngine && !state.setupComplete;

  ui.setup.hidden = !showSetup;
  ui.recorder.hidden = showSetup;
  if (!showSetup || !cfg) return;

  ui.envPath.textContent = cfg.envPaths[1];
  ui.stepKey.classList.toggle("done", Boolean(cfg.llmProvider));
  ui.stepOffline.classList.toggle("done", cfg.localReady);

  const installing = Boolean(state.install);
  ui.installProgress.hidden = !installing;

  // A 1.5 GB download is worth looking at, and the progress bar sits below the
  // fold. Scroll to it once, when it starts - not on every frame, which would
  // fight the user if they scroll away.
  if (installing && !wasInstalling) {
    ui.stepOffline.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  wasInstalling = installing;

  ui.installButton.disabled = installing || cfg.localReady;
  ui.installButton.textContent = cfg.localReady
    ? "Offline mode ready"
    : installing
      ? "Downloading…"
      : "Install offline mode";

  if (installing) {
    const { stage, percent, received, total } = state.install;
    ui.installStage.textContent =
      { model: "Downloading the medium model", binary: "Downloading whisper.cpp", extracting: "Extracting" }[
        stage
      ] || "Starting";
    ui.installBar.style.width = `${percent ?? 0}%`;
    ui.installDetail.textContent =
      total && received ? `${bytes(received)} of ${bytes(total)}` : received ? bytes(received) : "";
  }

  // On platforms with no official prebuilt binary, say so rather than
  // offering a button that can only fail.
  ui.installNote.textContent = state.canInstallWhisper
    ? ""
    : "On this platform the model downloads but whisper.cpp must be built from source — the README has the four commands.";

  ui.setupNotice.replaceChildren();
  if (state.lastError) ui.setupNotice.appendChild(notice("error", [state.lastError]));
}

/** Recordings whose note failed, each with a one-click retry. */
function renderAttention(state) {
  const entries = state.needsAttention || [];
  ui.attentionSection.hidden = entries.length === 0;
  ui.attention.replaceChildren();

  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "attention";

    const left = document.createElement("span");
    const name = document.createElement("span");
    name.textContent = entry.stamp;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = ` — ${entry.reason} · ${duration(entry.durationSeconds)}`;
    left.append(name, why);

    const button = document.createElement("button");
    button.className = "retry";
    button.textContent = "Retry";
    button.disabled = state.phase !== "idle";
    button.addEventListener("click", () => {
      button.disabled = true;
      window.njyn.reprocess(entry.stamp);
    });

    li.append(left, button);
    ui.attention.appendChild(li);
  }
}

function render(state) {
  renderSetup(state);
  renderAttention(state);
  ui.autostart.checked = Boolean(state.startAtLogin);

  const recording = state.phase === "recording";
  const processing = state.phase === "processing";

  // Status line
  ui.status.replaceChildren();
  if (recording) {
    const dot = document.createElement("i");
    dot.className = "rec-dot";
    ui.status.appendChild(dot);
    ui.status.appendChild(document.createTextNode("Recording"));
  } else if (processing) {
    const stage = state.progress?.stage || "Working";
    const pct = state.progress?.percent;
    ui.status.textContent = pct != null ? `${stage} · ${pct}%` : `${stage}…`;
  } else {
    ui.status.textContent = "Idle";
  }

  // Clock
  ui.clock.textContent = recording ? clock(state.elapsed) : processing ? "—" : "00:00";
  ui.clock.classList.toggle("idle", !recording);

  // Level meter, gently curved so quiet speech is still visible.
  const level = recording ? Math.min(1, Math.pow(state.level || 0, 0.6)) : 0;
  ui.meter.style.width = `${Math.round(level * 100)}%`;

  // Action button
  ui.action.textContent = processing
    ? "Working…"
    : recording
      ? "Stop Recording"
      : "Start Recording";
  ui.action.disabled = processing;
  ui.action.classList.toggle("recording", recording);

  // Source chips
  ui.chipMic.classList.toggle("on", Boolean(recording && state.sources.mic));
  ui.chipSys.classList.toggle("on", Boolean(recording && state.sources.system));

  // Engine block
  const cfg = state.config;
  if (cfg) {
    if (cfg.transcribeMode === "local") {
      const model = cfg.whisperModel ? cfg.whisperModel.split(/[\\/]/).pop() : "not installed";
      ui.engineStt.textContent = `whisper.cpp · ${model}`;
      ui.engineStt.className = cfg.localReady ? "v ok" : "v warn";
    } else {
      ui.engineStt.textContent = `${cfg.transcribeMode} whisper (hosted)`;
      ui.engineStt.className = "v ok";
    }

    ui.engineLlm.textContent = cfg.llmProvider ? `${cfg.llmProvider} · ${cfg.llmModel}` : "none";
    ui.engineLlm.className = cfg.llmProvider ? "v ok" : "v warn";

    ui.engineOffline.textContent = cfg.offlineCapable
      ? cfg.llmProvider
        ? "transcript yes · summary needs network"
        : "yes"
      : "no · needs network";
    ui.engineOffline.className = cfg.offlineCapable ? "v ok" : "v warn";

    ui.notesDir.textContent = cfg.notesDir;
    ui.notesDir.title = cfg.notesDir;
  }

  renderNotices(state);
}

async function refreshNotes() {
  const notes = await window.njyn.recentNotes();
  ui.notes.replaceChildren();
  ui.notesEmpty.style.display = notes.length ? "none" : "block";

  for (const note of notes) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = note.name.replace(/\.md$/, "");
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    li.append(name, arrow);
    li.addEventListener("click", () => window.njyn.openPath(note.path));
    ui.notes.appendChild(li);
  }
}

let lastPhase = null;

window.njyn.onUiState((state) => {
  render(state);
  // A finished recording means there is a new note to list.
  if (lastPhase === "processing" && state.phase === "idle") refreshNotes();
  lastPhase = state.phase;
});

ui.action.addEventListener("click", async () => {
  const state = await window.njyn.getState();
  if (state.phase === "recording") window.njyn.stop();
  else if (state.phase === "idle") window.njyn.start();
});

el("open-folder").addEventListener("click", () => window.njyn.openNotesDir());
el("reload").addEventListener("click", async () => {
  render(await window.njyn.reloadConfig());
  refreshNotes();
});

/* ---- setup screen ---- */

el("install-offline").addEventListener("click", () => window.njyn.installOffline("all"));
el("skip-setup").addEventListener("click", async () => {
  await window.njyn.completeSetup();
  render(await window.njyn.getState());
});
el("get-groq").addEventListener("click", () =>
  window.njyn.openExternal("https://console.groq.com/keys"),
);
el("get-anthropic").addEventListener("click", () =>
  window.njyn.openExternal("https://console.anthropic.com/"),
);

/* ---- preferences ---- */

ui.autostart.addEventListener("change", async (event) => {
  // The main process reports what the OS actually did, which may differ from
  // what was asked - so re-render from that rather than trusting the click.
  const enabled = await window.njyn.setAutostart(event.target.checked);
  ui.autostart.checked = enabled;
});

el("reprocess-file").addEventListener("click", () => window.njyn.reprocessFromDisk());

(async () => {
  render(await window.njyn.getState());
  refreshNotes();
})();
