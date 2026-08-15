"use strict";

/**
 * App preferences, kept separate from .env.
 *
 * .env is yours - hand-written, holding secrets, never touched by the app.
 * This file is the app's own state (does it start at login, has the setup
 * screen been dismissed) and is safe to rewrite.
 *
 *   ~/.njyn/settings.json
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS_DIR = path.join(os.homedir(), ".njyn");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

const DEFAULTS = {
  startAtLogin: false,
  setupComplete: false,
};

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

module.exports = { read, write, SETTINGS_FILE, SETTINGS_DIR };
