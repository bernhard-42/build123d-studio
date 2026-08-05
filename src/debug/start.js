// What Shift-F5 does, and what happens when the session says something.
//
// Split from session.js because that file owns the protocol and this one owns
// the application: saving before starting, refusing when there is nothing to
// debug, and moving the editor to the line execution stopped on. The protocol
// half is testable without a window and this half is not, which is the same
// split the rest of the frontend uses.

import {
  allBreakpoints,
  getCurrentFile,
  setBreakpointListener,
  showStoppedLine,
} from "../editor/monaco.js";
import {
  isDebugging,
  onDebugChange,
  state,
  resume,
  start,
  stepInto,
  stepOut,
  stepOver,
  stop,
  onDebugOutput,
  restart,
  updateBreakpoints,
} from "./session.js";
import {
  applyPanelState,
  clearDebugConsole,
  debugOutput,
  initDebugConsole,
  showConsolePanel,
} from "./console.js";
import { isRunningFile, onRunChange, toggleRunFile } from "../run/file.js";
import { justMyCode } from "./settings.js";
import { notifyFailure } from "../confirm.js";
import { refreshMenu } from "../menubar.js";
import { refreshDebugFrame } from "../vars/explorer.js";
import { openPath, saveFile } from "../editor/files.js";
import * as log from "../log.js";

/**
 * Start debugging the file on screen, or carry on a session that is paused.
 *
 * F5 does both, which is VS Code's arrangement and the reason the chords moved:
 * start it, then keep pressing the same key to get to the next breakpoint.
 * It used to stop a running session instead, because F5 meant Run File and
 * Shift-F5 had to serve as both the way in and the way out. Shift-F5 is Stop
 * now and does that job on its own.
 *
 * A session that is running and not paused is left alone. There is nothing to
 * start and nothing to resume, and killing it would make one key mean "go" and
 * "give up" depending on timing nobody can see.
 */
export async function toggleDebugging() {
  if (isDebugging()) {
    if (state().stoppedAt !== null) {
      await resume();
    }
    return;
  }

  // Saved first, always, as VS Code does. Debugging runs the *file*, which is
  // what makes a breakpoint land on the line it was put on with nothing to map
  // - so an unsaved buffer would debug the version on disk while the user reads
  // the version on screen, and every line number would be a lie.
  const saved = await saveFile();
  if (saved === null) {
    // saveFile has already said why on screen: cancelled, or a write that
    // failed. Either way there is no file to run.
    return;
  }

  const path = getCurrentFile();
  if (path === null) {
    await notifyFailure("Debugging", new Error("Save the file first; there is nothing to run."));
    return;
  }

  // Every marked file, not only this one: a breakpoint in a module the script
  // imports is how somebody follows execution into it.
  const files = allBreakpoints();
  log.info(`Debugging ${path}, ${files.length} file(s) with breakpoints`);
  await start(path, files, { justMyCode: justMyCode() });
}

/**
 * Run one stepping command by name.
 *
 * Named rather than passed as a function because the editor's actions are
 * registered from keys.js by id, and a table of four ids against four imports
 * is one place for the pairing to be wrong rather than four.
 */
export function stepAction(name) {
  const step = {
    continue: resume,
    stepOver,
    stepInto,
    stepOut,
    restart: () => restart(allBreakpoints()),
    stop,
  }[name];
  if (step === undefined) {
    log.error(`No debug step called ${name}`);
    return Promise.resolve();
  }
  return step();
}

/**
 * Show the line execution stopped on, opening its file if need be.
 *
 * Stepping into an imported module lands in a file that may have no tab, and a
 * debugger that stops somewhere it will not show you is a debugger you cannot
 * follow. Opening it is what VS Code does and what makes "debug into another
 * file" mean anything.
 */
async function reveal(frame) {
  if (frame === null || frame.path === null) {
    showStoppedLine(null, undefined);
    return;
  }
  if (getCurrentFile() !== frame.path) {
    // Quietly: a file that cannot be opened - one inside the standard library
    // that is not on disk, say - costs the highlight and nothing else.
    try {
      await openPath(frame.path);
    } catch (error) {
      log.warn(`Could not open ${frame.path} to show where execution stopped:`, error);
    }
  }
  showStoppedLine(frame.path, frame.line);
}

/** The step controls, which exist only while a session does. */
const CONTROLS = [
  ["debug-continue", resume],
  ["debug-step-over", stepOver],
  ["debug-step-into", stepInto],
  ["debug-step-out", stepOut],
  ["debug-restart", () => restart(allBreakpoints())],
  // Stop means whichever of the two is on. The bar is shared, so a button that
  // always stopped the debugger would do nothing during a plain run - and Stop
  // is the only control a run has.
  ["debug-stop", () => (isRunningFile() ? toggleRunFile() : stop())],
];

// Which controls need something paused. Restart and Stop do not: they are what
// somebody reaches for precisely while it is running away with them.
const NEEDS_PAUSE = new Set(["debug-continue", "debug-step-over", "debug-step-into",
                             "debug-step-out"]);

/**
 * Follow the session: the mark in the editor, and the controls in the tab row.
 *
 * The buttons are disabled rather than hidden between stops. A session that is
 * running but not paused has nothing to step, and a control that does nothing
 * when pressed is worse than one that says so - except Stop, which is exactly
 * what somebody wants while it runs away with them.
 */
export function initDebugUi() {
  const bar = document.getElementById("debug-bar");
  initDebugConsole();

  // A plain Run File raises the same bar with only Stop in it. There is nothing
  // to step, so the step controls are hidden rather than disabled - a row of
  // five greyed buttons would suggest the run is merely paused. Stop is the one
  // control that means something, and without it a script in a loop could only
  // be ended by quitting the application.
  onRunChange((isRunning) => {
    bar.hidden = !isRunning && !isDebugging();
    bar.classList.toggle("debug-bar-running", isRunning);
    for (const [id] of CONTROLS) {
      document.getElementById(id).hidden = isRunning && id !== "debug-stop";
    }
    document.getElementById("debug-stop").disabled = false;
  });

  // What the debugged process printed. Not the kernel's console, which is
  // hidden while this one is up.
  onDebugOutput(debugOutput);

  // A mark added or removed mid-session reaches the adapter, so the gutter and
  // the debugger cannot disagree about where execution should stop.
  setBreakpointListener((path, lines) => void updateBreakpoints(path, lines));
  for (const [id, action] of CONTROLS) {
    document.getElementById(id).addEventListener("click", () => void action());
  }

  let wasRunning = false;
  let wasStoppedAt = null;

  onDebugChange((state) => {
    if (isRunningFile()) {
      // A run owns the bar; a debug session cannot be starting while one is on.
      return;
    }
    bar.hidden = !state.running;
    for (const [id] of CONTROLS) {
      document.getElementById(id).hidden = false;
    }

    // The swap, both panes at once. Only on the edges: this fires on every
    // step, and rebuilding the console and the explorer per step would throw
    // away the transcript and whatever the user had opened.
    if (state.running !== wasRunning) {
      wasRunning = state.running;
      if (state.running) {
        clearDebugConsole();
      }
      if (state.running) {
        showConsolePanel("rundebug");
      }
      // And when it ends, the tab stays and the explorer empties rather than
      // reverting to the kernel: the pane still belongs to the session that has
      // just finished, and its transcript is still on screen above it.
      applyPanelState();
    }

    // A new stop is a new frame, and every reference the explorer holds belongs
    // to the one before it.
    const frameId = state.stoppedAt?.frame?.id ?? null;
    if (state.running && frameId !== null && frameId !== wasStoppedAt) {
      wasStoppedAt = frameId;
      // Re-read rather than rebuilt: every reference belongs to the stop that
      // issued it, but what the user opened is theirs and should survive a step.
      refreshDebugFrame();
    }
    if (state.stoppedAt === null) {
      wasStoppedAt = null;
    }
    const paused = state.stoppedAt !== null;
    for (const [id] of CONTROLS) {
      document.getElementById(id).disabled = NEEDS_PAUSE.has(id) && !paused;
    }

    // The Run menu greys the stepping items when nothing is paused, and it is
    // built once - so it has to be rebuilt when that changes, or the items stay
    // as they were when the window opened.
    void refreshMenu();

    const frame = state.stoppedAt?.frame ?? null;
    void reveal(frame);
  });
}
