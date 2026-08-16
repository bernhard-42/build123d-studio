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
import { isDebugging } from "./session.js";
import { setVariableSource, showVariablePane } from "../vars/explorer.js";

// Lines kept in the transcript. A script in a loop can print faster than anyone
// reads, and an unbounded pane is a memory leak with a scrollbar.
const MAX_LINES = 2000;

let output = null;
let input = null;

// What has been asked, oldest first, and where the up/down keys are in it.
// Cleared with the transcript, because a session's questions belong to that
// session - the frame they were about is gone with the process.
let history = [];
// Which panel is showing. The console until something else runs.
// Backend, because that is what starting up looks like: the model channel, the
// measurement backend, the kernel and the language server each saying how they
// went. A start that works ends by switching to Console and giving the editor
// focus; a start that does not leaves the reason on screen, which is the whole
// point of beginning here.
let current = "backend";
// The last source the explorer was actually put on, so a tab click that changes
// nothing does not throw away what the user had opened.
let appliedSource = "kernel";
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
 * Show one of the two panels, and remember which.
 *
 * This replaces a swap: the two panels used to take turns being hidden, so a
 * finished run's output disappeared with the process that wrote it and a
 * traceback could only be read while the thing that raised it was still alive.
 * The Run/Debug panel keeps its transcript now, and is cleared at the *start*
 * of the next run rather than at the end of this one.
 *
 * What the swap was protecting is kept: the Console tab is the kernel and the
 * Run/Debug tab is the other process, and neither ever describes the other.
 * Choosing between them is the user's now rather than the application's, which
 * is the whole difference.
 *
 * @param {"console"|"rundebug"} panel
 */
export function showConsolePanel(panel) {
  const wanted = ["rundebug", "backend"].includes(panel) ? panel : "console";
  current = wanted;
  document.getElementById("pane-console").hidden = wanted !== "console";
  document.getElementById("pane-debug").hidden = wanted !== "rundebug";
  document.getElementById("pane-backend").hidden = wanted !== "backend";
  for (const tab of document.querySelectorAll(".console-tab")) {
    const active = tab.dataset.consolePanel === wanted;
    tab.classList.toggle("console-tab-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  applyPanelState();
  if (wanted === "rundebug") {
    return;
  }
  // Back to the console, which has been unmeasurable for as long as it was
  // hidden: xterm sizes itself from its container and a hidden one is zero.
  refit();
}

/** Which panel is on show. */
export function currentConsolePanel() {
  return current;
}

/**
 * What the tab on show means for the panes beside it.
 *
 * One rule, in one place, because the alternative was three: the run set some
 * of this, the debugger set some of it, and the end of either set it back - so
 * finishing a Run File put the kernel's explorer and an evaluate line beside a
 * Run/Debug tab that was still showing the run's output, describing three
 * different things at once.
 *
 * The tab decides. Console is the kernel. Run/Debug is the debugged process
 * when there is one, and empty when there is not - after a run ends, after a
 * session ends, and when somebody simply clicks the tab. Nothing switches back
 * on its own, because the output is still there and still worth reading.
 *
 * The source is only reset when it actually changes: setVariableSource clears
 * what the user had expanded, and clicking between tabs must not cost them that
 * every time.
 */
export function applyPanelState() {
  const debugging = isDebugging();
  // Backend is neither the kernel nor the debugged process - it is a third
  // process talking about geometry - so the panes beside it describe nothing,
  // by the same rule that empties them for a Run/Debug tab with no session.
  const wanted =
    current === "console" ? "kernel" : (current === "rundebug" && debugging ? "debug" : "none");
  // The evaluate line is debugging's: it needs a frame to evaluate in.
  showEvaluateInput(current === "rundebug" && debugging);
  // And the explorer goes altogether when there is nothing for it to be about -
  // which is the Run/Debug tab with no session behind it, whether that is a
  // plain run, a finished session, or simply having clicked the tab.
  showVariablePane(wanted !== "none");
  if (wanted !== appliedSource) {
    appliedSource = wanted;
    setVariableSource(wanted);
  }
}

/**
 * Whether the evaluate line is offered.
 *
 * A plain run has no frame to evaluate in, so the field would be a prompt that
 * answers nothing. Debugging keeps it - it is the whole of the debug console.
 */
export function showEvaluateInput(visible) {
  document.getElementById("debug-prompt").hidden = !visible;
  if (visible) {
    input.focus();
  }
}

// How many lines the Backend tab keeps. It is a running account rather than a
// transcript to be searched - the file beside it is that - and an unbounded
// node list in a pane nobody is looking at is a leak with a scrollbar.
const BACKEND_LINES = 2000;

/**
 * One line from the measurement backend, as it printed it.
 *
 * Appended rather than replacing, and the pane follows the end only when it was
 * already there: a user who has scrolled up to read something is reading it,
 * and yanking them back to the bottom on the next line is the behaviour that
 * makes a log pane useless while anything is happening.
 */
let lastBackendKey = null;

export function appendBackendLine(text, key = text) {
  const pane = document.getElementById("backend-output");
  if (pane === null) {
    return;
  }
  // The same rule the files use: one line per distinct message, a dot per
  // repeat. A viewer notifying the same value or a retry loop otherwise fills
  // the pane with one sentence, and what matters is always the line above it.
  if (key === lastBackendKey && pane.lastElementChild !== null) {
    pane.lastElementChild.textContent += ".";
    pane.scrollTop = pane.scrollHeight;
    return;
  }
  lastBackendKey = key;
  const line = document.createElement("div");
  line.textContent = text;
  pane.appendChild(line);
  while (pane.childElementCount > BACKEND_LINES) {
    pane.removeChild(pane.firstElementChild);
  }
  // Always the end, rather than only when the view was already there.
  //
  // "Follow unless the reader has scrolled up" is the polite behaviour and it
  // was wrong here twice over: this pane is what the application starts on, so
  // the interesting line is always the newest, and the pane is hidden for most
  // of a session - a hidden element measures zero, so "was it at the bottom"
  // answered no and the tab kept showing its first ten lines for ever.
  pane.scrollTop = pane.scrollHeight;
}

export function initDebugConsole() {
  output = document.getElementById("debug-output");
  input = document.getElementById("debug-input");

  for (const tab of document.querySelectorAll(".console-tab")) {
    tab.addEventListener("click", () => showConsolePanel(tab.dataset.consolePanel));
  }
  // Whatever the module says it starts on, which is the Backend tab: the
  // startup is the thing worth looking at while the window fills, and a good
  // start switches to the console at the end of `main`.
  showConsolePanel(current);

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
