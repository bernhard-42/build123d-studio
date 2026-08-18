// Getting the keyboard back after a native dialog.
//
// A file chooser, a folder chooser or a save panel is a window of the operating
// system's, and opening one takes the keyboard away. What comes back is the
// window - measured on Windows: after Open File, typing goes straight into the
// editor with no click - so the view keeps its focus and this is only about
// which element inside it has the caret.
//
// The case that hurts is a window with *nothing* focused. An editor with no
// model cannot take focus, so after a command that leaves no file open there is
// no focused element at all, and the host is handed keys the page never sees:
// on Windows that is a beep for every Alt, and the menu bar looks broken. See
// openFolder, which puts the keyboard in the tree instead.

import { events, window as neuWindow } from "@neutralinojs/lib";

import { focusAt } from "./editor/monaco.js";
import * as log from "./log.js";

/** Ours, and therefore the ones that must keep the keyboard when they are up. */
const OUR_DIALOGS = ".settings-overlay, .info-overlay, .confirm-overlay";

/**
 * Put the caret back whenever the window is told it has the focus.
 *
 * The native side emits `windowFocus` when the operating system activates the
 * window, which is the moment after a dialog closes - and the moment our own
 * attempts were guessing at. Reacting to it needs no timer and no retry.
 *
 * Only when nothing in the page holds the caret. A window returning to the
 * front with the console focused must keep the console focused; this is for the
 * case where the answer is "nothing", which is what leaves the host holding
 * keys the page never sees.
 */
export function followWindowFocus() {
  events.on("windowFocus", () => {
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) {
      return;
    }
    if (document.querySelector(OUR_DIALOGS) !== null) {
      return;
    }
    focusAt(null);
  }).catch((error) => log.warn("Could not watch the window's focus:", error));
}

/**
 * The window and the size of it, for the throwaway that bounces the activation.
 *
 * One pixel and far off-screen: it has to be a real, shown window, because a
 * hidden one is never made the foreground window and then nothing is taken to
 * be given back. `hidden` is spelled out because the configured window mode
 * says otherwise and a new window inherits it.
 */
const THROWAWAY = {
  width: 1,
  height: 1,
  x: -4000,
  y: -4000,
  center: false,
  borderless: true,
  hidden: false,
  alwaysOnTop: false,
  enableInspector: false,
  exitProcessOnClose: true,
};

/**
 * Make Windows deactivate and reactivate the window, so the WebView is given
 * the keyboard.
 *
 * Neutralino gives the WebView the keyboard when the window is activated - it
 * calls MoveFocus from its WM_ACTIVATE handler - and the folder chooser never
 * causes one. SHBrowseForFolderW is modal on our own thread, so the window
 * stays the active one throughout and only the focus *within* the thread moves;
 * when the chooser is destroyed that focus goes back to the top-level window
 * rather than to the WebView child, and every keystroke afterwards is the
 * frame's. On Windows that is a beep for every Alt.
 *
 * Doing by hand what a person does by clicking away and back: another window
 * takes the foreground and disappears, and Windows activates ours again. The
 * window is a second process of this binary showing reactivate.html, which
 * exits the moment it is up.
 *
 * Windows only. Every other platform restores the focus itself.
 */
export async function bounceActivation() {
  try {
    await neuWindow.create("/reactivate.html", THROWAWAY);
  } catch (error) {
    log.warn("Could not bounce the window's activation:", error);
  }
}

async function claimKeyboard() {
  if (document.querySelector(OUR_DIALOGS) !== null) {
    // A dialog of ours is up. It owns the keyboard, and taking it back would
    // empty the field somebody is typing in.
    return;
  }
  try {
    await neuWindow.focus();
  } catch (error) {
    log.warn("Could not bring the window to the front:", error);
  }
  focusAt(null);
}

/**
 * Give the keyboard back to the editor after a native dialog has closed.
 *
 * Call it after every one of them - the caller does not have to know which
 * platform loses focus, because the answer differs and the cost of asking is a
 * focus call nobody notices.
 */
export function afterNativeDialog() {
  claimKeyboard().catch((error) => log.warn("Could not take the keyboard back:", error));
}
