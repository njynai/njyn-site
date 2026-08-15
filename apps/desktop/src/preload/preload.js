"use strict";

/**
 * The only bridge between the renderer processes and Node. Context isolation is
 * on and node integration is off, so the renderers can do exactly these things
 * and nothing else.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("njyn", {
  /* ---- capture window ---- */
  onStart: (fn) => ipcRenderer.on("capture:start", () => fn()),
  onStop: (fn) => ipcRenderer.on("capture:stop", () => fn()),
  sendChunk: (int16Buffer) => ipcRenderer.send("audio:chunk", int16Buffer),
  sendLevel: (level) => ipcRenderer.send("audio:level", level),
  captureStarted: (sources) => ipcRenderer.send("capture:started", sources),
  captureStopped: () => ipcRenderer.send("capture:stopped"),
  captureFailed: (message) => ipcRenderer.send("capture:failed", message),

  /* ---- panel window ---- */
  onUiState: (fn) => ipcRenderer.on("ui:state", (_e, s) => fn(s)),
  getState: () => ipcRenderer.invoke("ui:get"),
  start: () => ipcRenderer.invoke("ui:start"),
  stop: () => ipcRenderer.invoke("ui:stop"),
  openNotesDir: () => ipcRenderer.invoke("ui:openNotesDir"),
  openLastNote: () => ipcRenderer.invoke("ui:openLastNote"),
  reloadConfig: () => ipcRenderer.invoke("ui:reloadConfig"),
  recentNotes: () => ipcRenderer.invoke("ui:recentNotes"),
  openPath: (p) => ipcRenderer.invoke("ui:openPath", p),
});
