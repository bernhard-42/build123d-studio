import { window as neuWindow } from "@neutralinojs/lib";

import { closeActiveTab, newFile, openFile, saveFile } from "./editor/files.js";
import { toggleSidebar } from "./editor/sidebar.js";
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
import * as ipc from "./ipc.js";
import { showInfo } from "./info.js";
import { showSettings } from "./settings.js";
import * as log from "./log.js";
import { toggleRunFile } from "./run/file.js";
import { labelFor } from "./keybindings.js";
import { menuChordLabel } from "./menubar.js";
import { MENU } from "./menu.js";
import { titleWithChord } from "./keys.js";

// Toolbar wiring and the kernel state indicator.

function setKernelState(state) {
  const container = document.getElementById("kernel-status");
  const label = document.getElementById("kernel-label");
  container.classList.remove("idle", "busy", "dead");
  container.classList.add(state);
  label.textContent = state;
}

// The buttons that put work on the kernel's shell channel. Debugging is not
// among them: it runs in a process of its own and needs no kernel at all.
const RUN_BUTTONS = ["btn-run-file", "btn-run-cell", "btn-run-sel"];

function setRunEnabled(enabled) {
  for (const id of RUN_BUTTONS) {
    const button = document.getElementById(id);
    if (button !== null) {
      button.disabled = !enabled;
    }
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
        // An empty buffer with no caret in it is not obviously ready to type in.
        focusAt(null);
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
    "btn-interrupt": () =>
      withErrorReporting("Interrupt", async () => ipc.send("kernel.interrupt")),
    "btn-restart": () => withErrorReporting("Restart", async () => ipc.send("kernel.restart")),
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
    setKernelState(frame.state === "busy" ? "busy" : "idle");
  });

  // Running is off until the console has finished its handshake.
  //
  // Not because a Run needs the console - it does not - but because until then
  // the kernel is still importing build123d, and the kernel serves shell
  // requests one at a time. A Run pressed in that window does nothing visible
  // for two seconds on this machine and rather longer on a cold one, which
  // reads as a button that did not work.
  setRunEnabled(false);
  ipc.on("console.ready", () => setRunEnabled(true));
  // A restart puts the kernel back through the same sequence, and the console
  // with it. Anything else that ends a session leaves the buttons alone: they
  // are about whether the kernel can take work promptly, not about whether it
  // is there at all.
  ipc.on("kernel.restarting", () => setRunEnabled(false));
  ipc.on("sidecar.restarting", () => setRunEnabled(false));
  ipc.on("sidecar.disconnected", () => setKernelState("dead"));
  // The kernel dying without the sidecar is the case that used to leave this
  // reading "busy" for the rest of the session, because nothing was watching
  // the process and a dead ZMQ peer says nothing.
  ipc.on("kernel.died", () => setKernelState("dead"));
  ipc.on("sidecar.exit", () => setKernelState("dead"));
  ipc.on("kernel.restarting", () => setKernelState("busy"));
  ipc.on("kernel.restarted", () => setKernelState("idle"));
  // The replacement reports its own state once its kernel is up; until then
  // this is neither dead nor idle.
  ipc.on("sidecar.restarting", () => setKernelState("busy"));
  ipc.on("kernel.restart_failed", () => setKernelState("dead"));

  // Ctrl/Cmd+N, +O and +S have to work from anywhere, not only when Monaco
  // has focus - the console pane takes most of the typing in practice.
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) {
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
