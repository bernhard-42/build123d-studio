import { window as neuWindow } from "@neutralinojs/lib";

import { closeActiveTab, newFile, openFile, saveFile } from "./editor/files.js";
import { toggleSidebar } from "./editor/sidebar.js";
import { askTwoWay } from "./confirm.js";
import { toggleBottomRow } from "./layout/splitter.js";
import {
  focusAt,
  getCurrentFile,
  isDirty,
  onDirtyChange,
  openCommandPalette,
  runCell,
  runAll,
  runSelectionOrLine,
} from "./editor/monaco.js";
import { onDebugChange } from "./debug/session.js";
import { showConsolePanel } from "./debug/console.js";
import { anythingUnwell, onHealthChange, summary, worstState } from "./health.js";
import * as ipc from "./ipc.js";
import { showInfo } from "./info.js";
import { showSettings } from "./settings.js";
import * as log from "./log.js";
import { toggleRunFile } from "./run/file.js";
import { labelFor } from "./keybindings.js";
import { menuChordLabel } from "./menubar.js";
import { MENU } from "./menu.js";
import {
  abandonInterrupt,
  interruptPending,
  indicatorClass,
  label as kernelLabel,
  onKernelChange,
  report as reportKernel,
  requestInterrupt,
} from "./kernelstate.js";
import { titleWithChord } from "./keys.js";

// Toolbar wiring and the kernel state indicator.

// Drawing the kernel indicator. What it *means* is kernelstate.js, which owns
// the state, the pending interrupt and the word derived from both - see the
// note there for why those are not one value.
function renderKernelState() {
  const container = document.getElementById("kernel-status");
  const label = document.getElementById("kernel-label");
  if (container === null || label === null) {
    return;
  }
  container.classList.remove("idle", "busy", "dead", "starting");
  container.classList.add(indicatorClass());
  label.textContent = kernelLabel();
}

/**
 * The subsystem chip: the half of the health model the kernel indicator misses.
 *
 * The indicator beside it speaks for the kernel alone, so everything else could
 * die in silence - the model channel, the measurement backend, the language
 * server, the console. The Backend tab already covers a bad *start*, because the
 * application opens on it and only switches away when nothing is unwell. This is
 * for what dies afterwards, which nothing was watching at all.
 *
 * Hidden while all is well rather than shown in green: a toolbar that always
 * carries a status light teaches people not to look at it.
 */
function refreshHealthChip() {
  const chip = document.getElementById("health-chip");
  const label = document.getElementById("health-label");
  if (chip === null) {
    return;
  }
  const state = worstState();
  const unwell = anythingUnwell();
  chip.hidden = !unwell;
  chip.classList.remove("degraded", "failed");
  if (!unwell) {
    return;
  }
  chip.classList.add(state);
  label.textContent = state;
  // Every subsystem, not only the worst one: two things failing at once is a
  // different story from one, and the tooltip is where that fits.
  chip.title = `${summary()}\n\nClick to open the Backend tab.`;
}

// Which subsystems have already had their failure shown. Edge-triggered, not
// level-triggered: without this, every later report from any subsystem - and
// they arrive throughout a session - would pull the pane back to Backend while
// somebody was reading the console, for a failure they had already seen.
const revealed = new Set();

/**
 * Bring the Backend tab forward when something newly fails.
 *
 * Only for `failed`. A failure means something has stopped working and the
 * reason is already written in that pane, so putting it on screen is showing
 * what happened rather than interrupting - there is no dialog and nothing to
 * dismiss. `degraded` gets the chip and no more: it is still working, and taking
 * a pane the user chose is too much for "something is worth knowing".
 */
function revealBackendOnFailure(entries) {
  let fresh = false;
  for (const entry of entries) {
    if (entry.state === "failed" && !revealed.has(entry.name)) {
      revealed.add(entry.name);
      fresh = true;
    } else if (entry.state !== "failed") {
      // Recovered, so its next failure is news again - a measurement backend
      // that is killed and respawned is exactly this case.
      revealed.delete(entry.name);
    }
  }
  if (fresh) {
    showConsolePanel("backend");
  }
}

// The buttons that put work on the kernel's shell channel, all four of them.
const KERNEL_BUTTONS = ["btn-run-file", "btn-run-cell", "btn-run-sel", "btn-run-all"];

// Debugging is separate, and follows the sidecar rather than the kernel: the
// debuggee is a process of its own, so a wedged or restarting kernel is no
// reason to take the button away - it may be exactly what somebody reaches for.
// It still needs the sidecar that spawns it.
const DEBUG_BUTTONS = ["btn-debug"];

function setEnabled(ids, enabled) {
  for (const id of ids) {
    const button = document.getElementById(id);
    if (button !== null) {
      button.disabled = !enabled;
    }
  }
}

// How long an interrupt is given before it is treated as having missed.
//
// An interrupt reaches the kernel as SIGINT, and Python raises KeyboardInterrupt
// at the next bytecode boundary - which never comes while a single native call
// is running. A boolean on a large assembly is exactly that: OCCT holds the GIL
// for the whole operation and the signal waits behind it. So this is not a
// timeout on the kernel answering; it is how long somebody watches a button do
// nothing before they deserve to be told why.
const INTERRUPT_GRACE = 5000;

// One offer at a time. Pressing Interrupt three times must not queue three
// dialogs behind each other, each about a kernel that may have stopped since.
let offeringRestart = false;

/**
 * If the kernel is still running five seconds after an interrupt, offer to
 * restart it.
 *
 * Asked rather than done, because the two costs are not comparable: waiting
 * longer costs time, and restarting costs the namespace - every variable the
 * session has built, which for CAD work can be a model that took minutes.
 */
/**
 * Wait out the grace, or stop waiting the moment the kernel obeys.
 *
 * Cancelled rather than merely checked at the end, and that is not tidiness.
 * `offeringRestart` is held for as long as this is pending, so a timer left to
 * run its five seconds after the kernel has already stopped swallows the *next*
 * interrupt's grace entirely - and then fires against that newer request,
 * judging it after however much of the first grace was left. Interrupt, let it
 * stop, run again, interrupt again: the second press got no grace and the
 * dialog arrived early, about a kernel that had been given three seconds.
 *
 * @returns {Promise<boolean>} true if the grace elapsed with the interrupt
 *   still unanswered, false if the kernel stopped first
 */
function graceElapsed() {
  return new Promise((resolve) => {
    const settle = (elapsed) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(elapsed);
    };
    const timer = setTimeout(() => settle(true), INTERRUPT_GRACE);
    const unsubscribe = onKernelChange(() => {
      if (!interruptPending()) {
        settle(false);
      }
    });
  });
}

async function offerRestartIfItDidNotStop() {
  if (offeringRestart) {
    return;
  }
  offeringRestart = true;
  try {
    // The kernel stopping ends the wait; only a grace that ran out asks
    // anything. Either way the question is whether the interrupt was obeyed,
    // never whether the kernel is idle at this instant - somebody who
    // interrupts a cell and immediately runs two more has a busy kernel five
    // seconds later and nothing wrong with it.
    if (!(await graceElapsed())) {
      return;
    }
    abandonInterrupt();
    const answer = await askTwoWay({
      title: "The kernel did not stop",
      detail: "It is still running five seconds after the interrupt. Python can only "
        + "raise KeyboardInterrupt between operations, so a single long call - a "
        + "boolean on a large assembly - cannot be interrupted at all.\n\n"
        + "Restarting it stops that work, and empties the namespace with it: "
        + "everything the session has defined is lost.",
      confirm: "Restart the kernel",
      cancel: "Keep waiting",
    });
    if (answer === "confirm") {
      await ipc.send("kernel.restart");
    }
  } finally {
    offeringRestart = false;
  }
}

async function withErrorReporting(what, action) {
  try {
    await action();
  } catch (error) {
    log.error(`${what} failed:`, error);
  }
}

/**
 * Reflect the open file, and whether it is saved, in the window title.
 *
 * The bullet is the only place the application says a buffer differs from
 * disk. Without it a failed save left nothing on screen once the error dialog
 * was dismissed - the same window, the same everything, as a save that had
 * worked. That is the defect R2 is about, and it survived the first round of it
 * because the fix stopped at reporting the failure and never asked what the
 * window looked like afterwards.
 *
 * A bullet rather than an asterisk or the word "modified": it is what an editor
 * user reads without being told, it needs no translation, and it does not look
 * like part of a filename the way a trailing * can.
 */
export async function updateTitle() {
  const file = getCurrentFile();
  const marker = isDirty() ? " •" : "";
  const name = file === null ? "build123d Studio" : `build123d Studio — ${file}`;
  await neuWindow.setTitle(`${name}${marker}`);
}

// What the debug button does. Injected for the reason the editor's chord is:
// the action saves the buffer and starts a session, and both reach back through
// modules this one is imported by.
let onDebugToggle = () => {};

export function setDebugToggle(handler) {
  onDebugToggle = handler;
}

// Which button is which command, so a tooltip cannot claim a chord the keymap
// does not have. Every one of these is configurable in Settings, which is the
// other reason the titles are built rather than written: a rebound chord has to
// reach the tooltip too, or the button goes on advertising the old one.
//
// The buttons that are not here have no chord of their own - Interrupt,
// Restart, Theme, Info and Settings - and their titles stay as the markup has
// them. New, Open and Save do have chords, but from the native menu rather than
// from this keymap, and inventing a second source for them is how the two come
// to disagree.
// The buttons whose chord belongs to the menu rather than to the keymap. Asked
// of menubar.js for the same reason as above: one source, so the button and the
// menu item cannot end up claiming different keys for the same action.
const MENU_BUTTONS = {
  "btn-new": ["New File", MENU.NEW],
  "btn-open": ["Open File", MENU.OPEN],
  "btn-save": ["Save File", MENU.SAVE],
  "btn-sidebar": ["Toggle the file tree", MENU.TOGGLE_SIDEBAR],
  "btn-settings": ["Settings", MENU.SETTINGS],
};

const BUTTON_COMMANDS = {
  "btn-run-cell": ["Run Cell", "run.cell"],
  "btn-run-sel": ["Run Selection", "run.selectionOrLine"],
  "btn-run-all": ["Run All", "run.all"],
  "btn-run-file": ["Run File", "run.file"],
  // Its resting state. onDebugChange rewrites it while a session runs, to name
  // Stop and Stop's chord - but that listener does not fire on subscribe, so
  // without an entry here the button keeps whatever the markup said until the
  // first session starts.
  "btn-debug": ["Debug File", "debug.start"],
  "debug-continue": ["Continue", "debug.continue"],
  "debug-step-over": ["Step over", "debug.stepOver"],
  "debug-step-into": ["Step into", "debug.stepInto"],
  "debug-step-out": ["Step out", "debug.stepOut"],
  "debug-restart": ["Restart Debugging", "debug.restart"],
  "debug-stop": ["Stop", "debug.stop"],
};

/**
 * Put the current chord in every tooltip that has one.
 *
 * Called again after the shortcut editor saves, for the same reason the menu is
 * rebuilt there: a binding somebody has just changed must not leave the button
 * describing the old one. btn-debug is not in the table because its tooltip
 * says which of two things it will do, so this sets its resting state and the
 * session listener takes it from there.
 */
export function refreshToolbarTitles() {
  for (const [id, [label, command]] of Object.entries(BUTTON_COMMANDS)) {
    const button = document.getElementById(id);
    if (button !== null) {
      button.title = titleWithChord(label, labelFor(command));
    }
  }
  for (const [id, [label, command]] of Object.entries(MENU_BUTTONS)) {
    const button = document.getElementById(id);
    if (button !== null) {
      button.title = titleWithChord(label, menuChordLabel(command));
    }
  }
}

/**
 * Interrupt what the kernel is running, and offer a restart if it does not stop.
 *
 * Exported because three things do it now: the toolbar button, the button above
 * a cell marker, and the keymap. The offer is the part worth sharing - an
 * interrupt that misses is the case people need help with.
 */
export function interruptKernel() {
  return withErrorReporting("Interrupt", async () => {
    // Before the send, not after: the point of saying it is that the button
    // did something, and whether it worked is seconds away.
    requestInterrupt();
    await ipc.send("kernel.interrupt");
    await offerRestartIfItDidNotStop();
  });
}

/** Restart the kernel. The toolbar button and Shift-Alt-Mod-R are the same act. */
export function restartKernel() {
  return withErrorReporting("Restart", async () => ipc.send("kernel.restart"));
}

export function initToolbar() {
  // The title has to follow the buffer, not only the explicit actions below: a
  // keystroke makes it dirty and a successful save makes it clean again, and
  // neither goes through a button. Fired on the transition rather than on every
  // change - see onDirtyChange - and its failure is logged rather than left as
  // an unhandled rejection, because a title is not worth breaking typing over.
  onDirtyChange(() => {
    updateTitle().catch((error) => log.warn("Could not update the window title:", error));
  });

  const actions = {
    "btn-new": () => withErrorReporting("New", async () => {
      if (await newFile()) {
        await updateTitle();
        // The caret is newFile's to place, and placing one here would take it
        // away: the template is a snippet, and moving the selection outside its
        // stops is what tells Monaco the session is over. See insertSnippet.
      }
    }),
    "btn-open": () => withErrorReporting("Open", async () => {
      if ((await openFile()) !== null) {
        await updateTitle();
        // The open dialog took focus; give it back rather than leave the
        // freshly loaded file with no caret in it.
        focusAt(null);
      }
    }),
    "btn-save": () => withErrorReporting("Save", async () => {
      await saveFile();
      await updateTitle();
    }),
    "btn-sidebar": () => withErrorReporting("Toggle sidebar", toggleSidebar),
    "btn-run-all": runAll,
    "btn-run-file": () => void toggleRunFile(),
    "btn-run-cell": () => runCell(),
    "btn-run-sel": () => runSelectionOrLine(),
    // Wrapped like the rest: with the sidecar gone these throw out of a click
    // handler, where only the global rejection logger would ever see it.
    "btn-interrupt": interruptKernel,
    "btn-restart": restartKernel,
    "btn-palette": openCommandPalette,
    "btn-info": showInfo,
    "btn-settings": showSettings,
  };

  for (const [id, action] of Object.entries(actions)) {
    document.getElementById(id).addEventListener("click", action);
  }

  refreshToolbarTitles();

  // Debugging, which needs no kernel: the file runs in a process of its own.
  // The one button both starts and stops, like the chord, and says which it
  // will do - a button whose label does not change is a button somebody presses
  // twice to find out what it does.
  const debugButton = document.getElementById("btn-debug");
  debugButton.addEventListener("click", () =>
    withErrorReporting("Debugging", () => onDebugToggle()));
  onDebugChange((state) => {
    // Both halves from the keymap, and they are two different chords now: F5
    // starts, Shift-F5 stops. The literal string here said Shift+F5 for both
    // and went on saying it after the realignment.
    debugButton.title = state.running
      ? titleWithChord("Stop Debugging", labelFor("debug.stop"))
      : titleWithChord("Debug File", labelFor("debug.start"));
    debugButton.classList.toggle("btn-active", state.running);
  });

  ipc.on("kernel.status", (frame) => {
    reportKernel(frame.state === "busy" ? "busy" : "idle", frame.queued);
  });

  // The chip, and what it does when clicked. Subscribed before the sidecar is
  // started, so a subsystem that reports badly during startup is on screen the
  // moment it says so.
  document.getElementById("health-chip").addEventListener("click", () => {
    showConsolePanel("backend");
  });
  onHealthChange((entries) => {
    refreshHealthChip();
    revealBackendOnFailure(entries);
  });

  // The indicator is a subscriber like the chip beside it, so nothing that
  // changes the kernel's state has to remember to redraw. Once now as well,
  // because the state has a value before this runs.
  onKernelChange(renderKernelState);
  renderKernelState();
  // Once now as well, because subsystems report from the moment the sidecar
  // starts and this runs after some of them already have: a listener that only
  // fires on the *next* change would leave a failed start unmarked until
  // something unrelated happened to speak.
  refreshHealthChip();

  // Running is off until the console has finished its handshake.
  //
  // Not because a Run needs the console - it does not - but because until then
  // the kernel is still importing build123d, and the kernel serves shell
  // requests one at a time. A Run pressed in that window does nothing visible
  // for two seconds on this machine and rather longer on a cold one, which
  // reads as a button that did not work.
  setEnabled(KERNEL_BUTTONS, false);
  setEnabled(DEBUG_BUTTONS, false);
  ipc.on("console.ready", () => {
    setEnabled(KERNEL_BUTTONS, true);
    setEnabled(DEBUG_BUTTONS, true);
  });
  // A kernel restart puts the kernel back through the same sequence, and the
  // console with it. Debugging is untouched by it.
  ipc.on("kernel.restarting", () => setEnabled(KERNEL_BUTTONS, false));
  // Losing the sidecar takes both: it is what spawns a debuggee as well as what
  // holds the kernel.
  for (const gone of ["sidecar.restarting", "sidecar.disconnected", "sidecar.exit"]) {
    ipc.on(gone, () => {
      setEnabled(KERNEL_BUTTONS, false);
      setEnabled(DEBUG_BUTTONS, false);
    });
  }
  ipc.on("sidecar.disconnected", () => reportKernel("dead"));
  // The kernel dying without the sidecar is the case that used to leave this
  // reading "busy" for the rest of the session, because nothing was watching
  // the process and a dead ZMQ peer says nothing.
  ipc.on("kernel.died", () => reportKernel("dead"));
  ipc.on("sidecar.exit", () => reportKernel("dead"));
  ipc.on("kernel.restarting", () => reportKernel("busy"));
  ipc.on("kernel.restarted", () => reportKernel("idle"));
  // The replacement reports its own state once its kernel is up; until then
  // this is neither dead nor idle.
  ipc.on("sidecar.restarting", () => reportKernel("busy"));
  ipc.on("kernel.restart_failed", () => reportKernel("dead"));

  // Ctrl/Cmd+N, +O and +S have to work from anywhere, not only when Monaco
  // has focus - the console pane takes most of the typing in practice.
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    // Cmd/Ctrl-Shift-Y, VS Code's Toggle Debug Console, which is the panel
    // this row is. Before the "nothing else held" guard below, because this
    // one does hold Shift.
    //
    // `event.key`, not `event.code`, and that is a bug worth remembering:
    // `code` names the *physical* key by its US-QWERTY position, so on a
    // German keyboard the key printed Y arrives as `KeyZ`. Matching the code
    // meant the chord could not be pressed at all there - ⇧⌘Z worked instead,
    // which is the same physical key. A letter chord is the letter on the
    // keycap, whatever the layout. Shift uppercases it, hence the fold.
    if (event.shiftKey && !event.altKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      withErrorReporting("Toggle", async () => {
        await toggleBottomRow();
      });
      return;
    }
    // Exactly Cmd/Ctrl, nothing else held. Testing event.key alone meant
    // Cmd+Shift+N and Cmd+Alt+S triggered New and Save - shortcuts the user
    // was reaching for in another application, or on the way to something else
    // entirely.
    if (event.shiftKey || event.altKey) {
      return;
    }
    if (event.key === "w") {
      // Cmd-W / Ctrl-W, as every editor binds it. Prevented as well as handled:
      // in a webview it is the browser's own close-the-window chord. There is
      // no toolbar button for it - the tabs have their own crosses - so unlike
      // the others this does not go through `actions`.
      event.preventDefault();
      withErrorReporting("Close", async () => {
        await closeActiveTab();
        await updateTitle();
      });
    } else if (event.key === "b") {
      // Cmd-B / Ctrl-B, as VS Code binds it. Global rather than a Monaco
      // action, because showing the tree is worth doing from the console too.
      event.preventDefault();
      actions["btn-sidebar"]();
    } else if (event.key === "n") {
      event.preventDefault();
      actions["btn-new"]();
    } else if (event.key === "o") {
      event.preventDefault();
      actions["btn-open"]();
    } else if (event.key === "s") {
      event.preventDefault();
      actions["btn-save"]();
    }
  });
}
