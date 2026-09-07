// Ctrl-F5: run the file on disk, in a process of its own, with no debugger.
//
// The sibling of Shift-F5 rather than of F5's old meaning, and that is the
// distinction this module exists to make. Run All sends the *buffer's text* to
// the kernel, where its names stay in the namespace the console shares. Run File
// saves and runs the *file*, in a process that is gone when it ends - so what
// ran is what is on disk, and nothing is left behind.
//
// The panes swap exactly as they do for debugging, because the rule is the same
// one: while something else is running, every pane in the window describes that
// something else. The only difference is that there are no step controls, since
// there is nothing to step - which is also the only difference in VS Code.
//
// The viewer is the deliberate exception, as it is for debugging: a picture is
// not state, and a show() from the run reaches the viewer already on screen
// because the process is given the kernel's environment.

import { os } from "@neutralinojs/lib";

import {
  applyPanelState,
  clearDebugConsole,
  debugOutput,
  showConsolePanel,
} from "../debug/console.js";
import { isDebugging } from "../debug/session.js";
import { afterNativeDialog, bounceActivation } from "../nativedialog.js";
import { currentFolder, saveAll, saveFile } from "../editor/files.js";
import { getCurrentFile } from "../editor/monaco.js";
import { ignoreWarnings } from "./settings.js";
import { notifyFailure } from "../confirm.js";
import { refreshMenu } from "../menubar.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";

let running = false;
const listeners = new Set();

/** Whether a file is running outside the kernel right now. */
export function isRunningFile() {
  return running;
}

export function onRunChange(listener) {
  listeners.add(listener);
  listener(running);
}

function announce(next) {
  if (next === running) {
    return;
  }
  running = next;
  if (running) {
    // Shown rather than swapped to: the tab stays reachable afterwards, which
    // is the point - a traceback outlives the process that raised it.
    showConsolePanel("rundebug");
  }
  // And nothing is put back when it ends. The tab is still the run's output, so
  // the panes beside it still describe the run - which is now nothing running,
  // rather than the kernel. Restoring the kernel's explorer and an evaluate
  // line under a Run/Debug tab was three panes describing three different
  // things, which is what he saw.
  applyPanelState();
  for (const listener of listeners) {
    listener(running);
  }
  // The Run menu greys what cannot be done, and it is built once.
  void refreshMenu();
}

/**
 * Start the file on screen, or stop the one that is running.
 *
 * One chord for both, as debugging has: there is nothing to start while
 * something is running, and the alternative is a second binding that does
 * nothing most of the time.
 */
export async function toggleRunFile() {
  if (running) {
    ipc.send("run.stop");
    announce(false);
    return;
  }
  if (isDebugging()) {
    // Two processes both claiming the console and the explorer is exactly the
    // confusion the swap exists to prevent.
    await notifyFailure("Run File", new Error("Stop the debug session first."));
    return;
  }

  // Saved first, as debugging does and for the same reason: this runs the file,
  // so an unsaved buffer would run yesterday's code while the user reads
  // today's. saveFile has already said why on screen if it comes back null.
  const saved = await saveFile();
  if (saved === null) {
    return;
  }
  const path = getCurrentFile();
  if (path === null) {
    await notifyFailure("Run File", new Error("Save the file first; there is nothing to run."));
    return;
  }

  clearDebugConsole();
  announce(true);
  log.info("Running", path);
  ipc.send("run.start", { path });
}

// Where the chooser starts next time, so a second run does not begin at the
// project root again. Not remembered across sessions: a test path belongs to
// the project that is open, and one from yesterday's project is a worse
// starting point than the folder this one is in.
let lastTested = null;

/**
 * Shared by both Test items: everything except which chooser is raised.
 *
 * The run itself is Run File's - the same `running` state, so the Stop in the
 * tab row means this too; the same output pane; the same swap of the panes
 * around it. What differs is the command the supervisor is given, and that it
 * is a path somebody picked rather than the buffer on screen.
 */
async function runPytestOn(what, choose) {
  if (running) {
    // Deliberately not a toggle, unlike Run File. "Test File" that sometimes
    // means Stop, over a run that may not be a test run at all, is a menu item
    // nobody can predict - and Stop is in the tab row, where it says so.
    await notifyFailure(what, new Error("Something is already running. Stop it first."));
    return;
  }
  if (isDebugging()) {
    await notifyFailure(what, new Error("Stop the debug session first."));
    return;
  }

  // Everything, not just the file on screen: pytest reads from disk, and the
  // test somebody just edited is the one they mean to run. Run File saves one
  // buffer because it runs one file.
  if (!(await saveAll())) {
    return;
  }

  const chosen = await choose();
  afterNativeDialog();
  if (NL_OS === "Windows") {
    // The folder chooser is the one that leaves the keyboard at the frame -
    // see bounceActivation. Harmless after the file chooser, which does not.
    await bounceActivation();
  }
  if (typeof chosen !== "string" || chosen === "") {
    return;
  }
  lastTested = chosen;

  clearDebugConsole();
  announce(true);
  log.info("Testing", chosen);
  ipc.send("run.tests", { path: chosen, ignoreWarnings: ignoreWarnings() });
}

/** Run pytest over one file. */
export async function testFile() {
  await runPytestOn("Test File", async () => {
    const entries = await os.showOpenDialog("Select the file to test", {
      defaultPath: lastTested ?? currentFolder() ?? undefined,
      filters: [{ name: "Python", extensions: ["py"] }],
      multiSelections: false,
    });
    return entries.length === 1 ? entries[0] : "";
  });
}

/** Run pytest over one folder. */
export async function testFolder() {
  await runPytestOn("Test Folder", () =>
    os.showFolderDialog("Select the folder to test", {
      defaultPath: lastTested ?? currentFolder() ?? undefined,
    }));
}

/** Subscribe to what the sidecar says about the run. */
export function initRunFile() {
  ipc.on("run.output", (frame) => debugOutput(frame.text ?? ""));

  ipc.on("run.exited", (frame) => {
    // Said in the output rather than in a dialog. A non-zero exit is an
    // ordinary outcome of running a script - it means the traceback above it is
    // the answer - and a modal over the top of the traceback would be in the
    // way of the thing worth reading.
    const code = frame.code ?? 0;
    debugOutput(code === 0 ? "\n[finished]\n" : `\n[exited with code ${code}]\n`);
    announce(false);
  });

  ipc.on("run.failed", (frame) => {
    log.warn("Could not run the file:", frame.message);
    debugOutput(`\n[could not start: ${frame.message ?? "unknown reason"}]\n`);
    announce(false);
  });

  // A sidecar that goes takes the process with it, so the UI must not be left
  // claiming something is running.
  ipc.on("sidecar.restarting", () => announce(false));
  ipc.on("sidecar.disconnected", () => announce(false));
}
