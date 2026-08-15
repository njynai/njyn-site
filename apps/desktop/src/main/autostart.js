"use strict";

/**
 * Start at login.
 *
 * A recorder you have to remember to open is a recorder you forget to use, so
 * the app can put itself in the tray at login - started hidden, doing nothing
 * until you click Start.
 *
 * Windows and macOS have a first-class API for this. Linux has no such API, so
 * we write the freedesktop autostart entry ourselves.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");

const LINUX_AUTOSTART_DIR = path.join(os.homedir(), ".config", "autostart");
const LINUX_DESKTOP_FILE = path.join(LINUX_AUTOSTART_DIR, "njyn-meeting-notes.desktop");

/**
 * `--hidden` is how Windows and Linux tell us the launch came from the login
 * item; macOS reports it through the API instead. In development the
 * executable is Electron itself, so the app directory has to be passed too or
 * the login item would start a bare Electron.
 */
function launchArgs() {
  const args = ["--hidden"];
  if (!app.isPackaged) args.unshift(path.resolve(app.getAppPath()));
  return args;
}

function setLinux(enabled) {
  if (!enabled) {
    try {
      fs.unlinkSync(LINUX_DESKTOP_FILE);
    } catch {
      /* nothing to remove */
    }
    return;
  }

  const exec = [app.getPath("exe"), ...launchArgs()]
    .map((part) => (part.includes(" ") ? `"${part}"` : part))
    .join(" ");

  fs.mkdirSync(LINUX_AUTOSTART_DIR, { recursive: true });
  fs.writeFileSync(
    LINUX_DESKTOP_FILE,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=njyn Meeting Notes",
      "Comment=Local-first meeting notes",
      `Exec=${exec}`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
    "utf8",
  );
}

function isEnabled() {
  if (process.platform === "linux") return fs.existsSync(LINUX_DESKTOP_FILE);
  return app.getLoginItemSettings({ args: launchArgs() }).openAtLogin;
}

/**
 * @returns {boolean} whether it is enabled afterwards, which is the truth the
 *   UI should render - a failed write must not leave the toggle lying.
 */
function setEnabled(enabled) {
  try {
    if (process.platform === "linux") {
      setLinux(enabled);
    } else {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        // macOS honours this directly; elsewhere the --hidden argument does it.
        openAsHidden: true,
        args: launchArgs(),
      });
    }
  } catch (err) {
    console.warn(`Could not change the login item: ${err.message}`);
  }
  return isEnabled();
}

/** True when this launch came from the login item rather than the user. */
function launchedAtLogin() {
  if (process.platform === "darwin") {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  }
  // Windows and Linux pass the flag we register with the login entry.
  return process.argv.includes("--hidden");
}

module.exports = { isEnabled, setEnabled, launchedAtLogin };
