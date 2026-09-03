import { clipboard } from "@neutralinojs/lib";

import * as log from "../log.js";
import { appVersion } from "../versions.js";

// The splash overlay is the only UI during first-run environment setup, which
// downloads roughly 500 MB and can take a couple of minutes. It shows uv's own
// output rather than a spinner, so a slow network looks like progress instead
// of a hang.

const MAX_LINES = 500;

const splashEl = () => document.getElementById("splash");
const statusEl = () => document.getElementById("splash-status");
const logEl = () => document.getElementById("splash-log");
const titleEl = () => document.querySelector(".splash-title");

let lines = [];

// Which build is on screen, said on the one screen that is up before anything
// else exists. A first-run report is "it stopped on the splash", and until now
// nothing on that screen answered "which version" - the About dialog is behind
// a window that has not been built yet. Carries the .devN counter on a local
// build, which is what tells two packages of one version apart.
titleEl().textContent = `build123d Studio ${appVersion}`;

// Copying out of the splash, which the native menu cannot do for us.
//
// On macOS the Edit menu's `copy:` role is what delivers Cmd-C to a web view,
// and the menu is installed after the environment is ready - so during the one
// screen where something has gone wrong and the text on it is the whole of the
// evidence, Cmd-C did nothing. Selecting worked; copying did not.
//
// Handled here rather than by installing a menu earlier, because the menu's
// items act on an editor that does not exist yet at this point in startup.
// Only while the splash is up, and only when something is selected, so it
// cannot take the keystroke from anything else later.
window.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c") {
    return;
  }
  if (!splashVisible()) {
    return;
  }
  const selected = String(window.getSelection() ?? "");
  if (selected === "") {
    return;
  }
  event.preventDefault();
  clipboard.writeText(selected).catch((error) => log.warn("Could not copy:", error));
});

export function setStatus(text) {
  statusEl().textContent = text;
}

export function appendLog(line) {
  lines.push(line);
  if (lines.length > MAX_LINES) {
    lines = lines.slice(-MAX_LINES);
  }
  const el = logEl();
  el.textContent = lines.join("\n");
  el.scrollTop = el.scrollHeight;
}

export function clearLog() {
  lines = [];
  logEl().textContent = "";
}

// The splash is a fixed overlay above the shell rather than an alternative to
// it, so the panes are laid out underneath the whole time. Monaco and xterm
// measure their containers when created, and a display:none ancestor would
// give both of them a zero-sized viewport.

export function showSplash() {
  splashEl().classList.remove("hidden");
}

/**
 * Whether the splash is covering the app.
 *
 * The settings dialog's own flows - upgrade, change package sources - raise the
 * splash and restart the kernel underneath it. It already says what is
 * happening and already blocks everything, so the restart modal would only
 * stack a second overlay on top of it.
 */
export function splashVisible() {
  return !splashEl().classList.contains("hidden");
}

export function hideSplash() {
  splashEl().classList.add("hidden");
}

/**
 * Show an error on the splash. Used when setup cannot continue.
 *
 * On its own this is terminal - there is no usable app behind it. Callers that
 * do have something to go back to follow it with acknowledge().
 */
export function fail(message, detail) {
  setStatus(message);
  statusEl().style.color = "#f48771";
  if (detail !== undefined && detail !== null) {
    appendLog("");
    appendLog(String(detail));
  }
}

/**
 * Hold the splash open until the user presses OK.
 *
 * An upgrade prints what it did - which packages moved, which versions - and
 * then used to dismiss itself the moment it finished, so the one thing worth
 * reading was on screen only while it was still scrolling. Waiting for an
 * acknowledgement is the difference between a progress display and a result.
 *
 * Offered after a failure too. The environment may be in an unknown state, but
 * a splash with no way out is worse than a possibly-degraded app: the log stays
 * on screen until it is dismissed, and the same text is in the log file.
 */
let waiting = false;

export function acknowledge() {
  // One waiter, and a second is answered rather than queued.
  //
  // There is a single button and a single set of listeners, so two callers
  // awaiting it both attach handlers to it and one Enter resolves both. That
  // is reachable: the settings dialog's environment actions and the
  // kernel.restart_failed handler can each be waiting here. confirm.js solved
  // exactly this for its own overlay and says so; this had the same shape and
  // not the same guard.
  if (waiting) {
    return Promise.resolve();
  }
  waiting = true;

  const button = document.getElementById("splash-ok");
  button.hidden = false;
  button.focus();

  return new Promise((resolve) => {
    const finish = () => {
      waiting = false;
      button.hidden = true;
      button.removeEventListener("click", finish);
      document.removeEventListener("keydown", onKey, true);
      // Reset for the next use: fail() leaves the status red.
      statusEl().style.color = "";
      resolve();
    };
    // Capture, so Monaco and xterm behind the splash never see it.
    const onKey = (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    button.addEventListener("click", finish);
    document.addEventListener("keydown", onKey, true);
  });
}
