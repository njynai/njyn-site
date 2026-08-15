"use strict";

/** Panel window. Pure view over the state the main process pushes down. */

const el = (id) => document.getElementById(id);

const ui = {
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

function render(state) {
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

(async () => {
  render(await window.njyn.getState());
  refreshNotes();
})();
