// The debug console: what the debugged process printed, and a line to ask it
// things.
//
// Not the Jupyter console and never talking to the kernel. It takes the same
// pane, and only one of the two is ever visible - so while a session runs every
// pane in the window describes the debugged process, and otherwise every pane
// describes the kernel. That is the whole of the rule, and it means nobody has
// to remember which pane is talking about what.
//
// Built from nodes rather than from an HTML string, for the reason the variable
// explorer is: every line here is text from somebody else's process, and this
// webview can reach the filesystem through Neutralino.

import { evaluate } from "./session.js";
import { refit } from "../console/terminal.js";
import * as log from "../log.js";

// Lines kept in the transcript. A script in a loop can print faster than anyone
// reads, and an unbounded pane is a memory leak with a scrollbar.
const MAX_LINES = 2000;

let output = null;
let input = null;

// What has been asked, oldest first, and where the up/down keys are in it.
// Cleared with the transcript, because a session's questions belong to that
// session - the frame they were about is gone with the process.
let history = [];
let atHistory = 0;
// What was typed before the user started walking back, so coming forward again
// returns it rather than an empty line.
let draft = "";

/** Add one line to the transcript, and stay at the bottom if we were there. */
function append(text, kind) {
  if (output === null || text === "") {
    return;
  }
  // Within a few pixels, because a fractional scroll height is normal and an
  // exact comparison would decide the user had scrolled away when they had not.
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 4;

  const line = document.createElement("div");
  line.className = `debug-line-${kind}`;
  line.textContent = text.replace(/\n$/, "");
  output.append(line);

  while (output.childElementCount > MAX_LINES) {
    output.firstElementChild.remove();
  }
  if (atBottom) {
    output.scrollTop = output.scrollHeight;
  }
}

/** Whatever the process wrote to stdout or stderr. */
export function debugOutput(text) {
  append(text, "output");
}

/** Start a transcript, because a session's output belongs to that session. */
export function clearDebugConsole() {
  if (output !== null) {
    output.replaceChildren();
  }
  history = [];
  atHistory = 0;
  draft = "";
}

/**
 * Walk the history. -1 is back in time, +1 forward.
 *
 * Past the newest entry the field returns whatever was being typed when the
 * walk started, which is what every shell does and what makes the up key safe
 * to press out of curiosity.
 */
function recall(direction) {
  if (history.length === 0) {
    return;
  }
  if (atHistory === history.length) {
    draft = input.value;
  }
  const next = Math.min(history.length, Math.max(0, atHistory + direction));
  if (next === atHistory) {
    return;
  }
  atHistory = next;
  input.value = next === history.length ? draft : history[next];
  // The caret goes to the end, so up-up-edit works without a click.
  input.setSelectionRange(input.value.length, input.value.length);
}

async function submit() {
  const expression = input.value.trim();
  if (expression === "") {
    return;
  }
  input.value = "";
  // Consecutive repeats collapse: pressing Enter twice on one expression should
  // not cost two presses of the up key to get back past.
  if (history.at(-1) !== expression) {
    history.push(expression);
  }
  atHistory = history.length;
  draft = "";
  append(`> ${expression}`, "echo");

  try {
    const { success, output: result } = await evaluate(expression);
    append(result, success ? "result" : "error");
  } catch (error) {
    log.error("Debug evaluate failed:", error);
    append(String(error), "error");
  }
}

/**
 * Show or hide the pane, and take the console with it.
 *
 * Focus follows: a debug console nobody can type into without clicking first is
 * a debug console that gets used once.
 */
export function showDebugConsole(visible) {
  const debugPane = document.getElementById("pane-debug");
  const consolePane = document.getElementById("pane-console");
  debugPane.hidden = !visible;
  consolePane.hidden = visible;
  if (visible) {
    input.focus();
    return;
  }
  // Back to the console, which has been unmeasurable for the length of the
  // session: xterm sizes itself from its container and a hidden one is zero.
  refit();
}

export function initDebugConsole() {
  output = document.getElementById("debug-output");
  input = document.getElementById("debug-input");

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }
    // The arrows would otherwise move the caret, which in a one-line field is
    // never what the key was pressed for.
    if (event.key === "ArrowUp") {
      event.preventDefault();
      recall(-1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      recall(1);
    }
  });
}
