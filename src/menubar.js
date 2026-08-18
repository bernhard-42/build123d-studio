// Install the native menu and route what it sends back.
//
// menu.js decides the shape; this is the half that reaches Neutralino and the
// application's own commands. Split for the same reason keys.js and
// keybindings.js are: the shape is worth testing and Neutralino cannot be loaded
// under `node --test`.
//
// ## Three things the documentation does not answer
//
// It defines the menu item fields, the native roles and the mainMenuItemClicked
// event, and it stops there. It does not say what that event carries, whether
// the roles exist off macOS, or whether an item with a role *also* raises the
// event. Guessing at any of them would decide the design on a theory, so:
//
// * nothing depends on the payload's shape - the id is read out of whatever
//   arrives, in the two forms it could plausibly take, and an unrecognised
//   payload is logged in full rather than swallowed
// * an item never has both a role and a handler. On macOS the clipboard items
//   are roles and nothing here answers for them; everywhere else they are
//   handled here and carry no role. If the event did fire for a role as well,
//   the worst case is a log line, not a double paste
// * whether that is right on each platform is a question for a build, and the
//   log line is what will answer it
//
// ## What the menu is not
//
// It is not what makes the run shortcuts work - Monaco binds those, and on macOS
// the menu could not express them anyway. The Run items are there so the
// commands are discoverable and reachable with a mouse.

import { isDebugging } from "./debug/session.js";
import { events, window as neuWindow } from "@neutralinojs/lib";

import { COMMANDS, describeChord, parseChord } from "./keys.js";
import { MENU, buildMenu } from "./menu.js";
import { chordsFor } from "./keybindings.js";
import { initTitleBar, setMenus, usesOwnTitleBar } from "./titlebar/titlebar.js";
import * as log from "./log.js";

// Items that need something open to act on. This was a fixed set of things
// group 2 had not built yet; every one of them is built now, so what is greyed
// depends on the session instead - Close needs a tab, Close Folder needs a
// project - and the menu is rebuilt whenever either changes.
const NEEDS_TABS = new Set([MENU.SAVE_ALL, MENU.CLOSE, MENU.CLOSE_ALL]);
const NEEDS_FOLDER = new Set([MENU.CLOSE_FOLDER, MENU.TOGGLE_SIDEBAR]);

// Stepping means nothing without something stopped to step. Greyed rather than
// hidden, so the Run menu keeps one shape and somebody can see what debugging
// will offer before they start it.
const NEEDS_SESSION = new Set([
  "debug.continue", "debug.stepOver", "debug.stepInto", "debug.stepOut",
  "debug.restart", "debug.stop",
]);

// Chords the menu shows for the File items. Only macOS binds them, and only as
// Command plus a letter; elsewhere they are a label. They are not registered
// anywhere else, so on Windows and Linux these read as documentation until the
// keymap covers file commands too.
const FILE_CHORDS = {
  [MENU.SETTINGS]: "mod+comma",
  [MENU.NEW]: "mod+n",
  [MENU.OPEN]: "mod+o",
  [MENU.SAVE]: "mod+s",
  [MENU.CLOSE]: "mod+w",
  [MENU.TOGGLE_SIDEBAR]: "mod+b",
  // VS Code's Toggle Debug Console, which is the panel this row is: ⇧⌘Y on
  // macOS, Ctrl+Shift+Y elsewhere. `mod` is what makes that one entry.
  //
  // It shows as text beside the label rather than as a grey right-aligned
  // accelerator, unlike the Command-plus-a-letter entries around it. That is
  // Neutralino's documented limit, not a mistake: on macOS its `shortcut`
  // field binds and displays only Command plus one character.
  [MENU.TOGGLE_BOTTOM]: "mod+shift+y",
  [MENU.CUT]: "mod+x",
  [MENU.COPY]: "mod+c",
  [MENU.PASTE]: "mod+v",
};

let handlers = {};
let clipboardIsNative = false;
// Asked at rebuild time rather than stored, so the menu cannot disagree with
// the application about whether a folder is open. Injected to keep this file
// from importing the editor.
let hasFolder = () => false;
let hasTabs = () => false;

/**
 * Whether the platform's own clipboard roles are used.
 *
 * macOS has them documented, and they are strictly better than anything this
 * application could do: the role goes through the responder chain, so Cut, Copy
 * and Paste land on whatever actually has focus - Monaco, the terminal, a
 * dialog's input - without this module having to know which.
 */
function useNativeClipboard(platform) {
  return platform === "Darwin";
}

function chordFor(commandId) {
  const configured = chordsFor(commandId);
  if (configured.length > 0) {
    return parseChord(configured[0]);
  }
  const fixed = FILE_CHORDS[commandId];
  return fixed === undefined ? null : parseChord(fixed);
}

/**
 * How a menu item's chord is written, for a tooltip on the button beside it.
 *
 * Exported so the toolbar can ask rather than keep its own copy. New, Open,
 * Save, the sidebar toggle and Settings have chords that live here rather than
 * in the keymap - they are the menu's, not the editor's - and a second table
 * for the buttons is how the two come to disagree about Cmd-S.
 */
export function menuChordLabel(commandId) {
  const chord = chordFor(commandId);
  return chord === null ? "" : describeChord(NL_OS, chord);
}

/** The id out of whatever mainMenuItemClicked turns out to deliver. */
function idFrom(detail) {
  if (typeof detail === "string") {
    return detail;
  }
  if (detail !== null && typeof detail === "object" && typeof detail.id === "string") {
    return detail.id;
  }
  return null;
}

function onMenuItemClicked(event) {
  const id = idFrom(event?.detail);
  if (id === null) {
    // Not a failure of the menu so much as of this function's assumptions about
    // the payload, which the documentation does not describe. Print it whole,
    // because that is the one thing that turns this into a one-line fix.
    log.warn("Menu click with an unrecognised payload:", event?.detail);
    return;
  }

  const handler = handlers[id];
  if (handler === undefined) {
    // Reached on macOS if a native role raises the event as well as acting on
    // it. Harmless, and worth saying once so the question stops being open.
    log.info(`Menu item ${id} has no handler here`);
    return;
  }

  Promise.resolve()
    .then(handler)
    .catch((error) => log.error(`Menu item ${id} failed:`, error));
}

/**
 * Put the menu up.
 *
 * @param {object} commands handlers by menu id; the clipboard ones are ignored
 *   where the platform's own roles are used instead
 */
export function watchSession({ folder, tabs }) {
  hasFolder = folder;
  hasTabs = tabs;
}

export async function initMenu(commands) {
  clipboardIsNative = useNativeClipboard(NL_OS);
  handlers = { ...commands };
  if (clipboardIsNative) {
    // The role does the work, so nothing here answers for these.
    for (const id of [MENU.CUT, MENU.COPY, MENU.PASTE]) {
      delete handlers[id];
    }
  }

  events.on("mainMenuItemClicked", onMenuItemClicked);

  // The in-window bar reports a pick as an id, which is the same thing the
  // native event carries - so both ends of the menu run the same handlers.
  await initTitleBar({ platform: NL_OS, onPick: runMenuItem });
  await refreshMenu();
}

/** Run what a menu item asks for, whichever menu it came from. */
function runMenuItem(id) {
  const handler = handlers[id];
  if (handler === undefined) {
    log.info(`Menu item ${id} has no handler here`);
    return;
  }
  Promise.resolve()
    .then(handler)
    .catch((error) => log.error(`Menu item ${id} failed:`, error));
}

/**
 * Rebuild and re-install the menu.
 *
 * Whole rather than mutated, because there is no documented way to change one
 * item, and because a menu built from the current keymap has to be rebuilt when
 * that keymap changes - which is what group 5's dialog will do.
 */
export async function refreshMenu() {
  const menu = buildMenu({
    platform: NL_OS,
    chordFor,
    isEnabled: (id) => {
      if (NEEDS_TABS.has(id)) {
        return hasTabs();
      }
      if (NEEDS_FOLDER.has(id)) {
        return hasFolder();
      }
      if (NEEDS_SESSION.has(id)) {
        return isDebugging();
      }
      return true;
    },
    nativeClipboard: clipboardIsNative,
    runCommands: COMMANDS,
  });

  // Where the menu goes depends on who draws the window's frame. macOS keeps
  // its system menu; everywhere else the frame is ours and so is the bar, and
  // both are built from this same structure so they cannot drift.
  if (usesOwnTitleBar(NL_OS)) {
    setMenus(menu);
    return;
  }

  try {
    await neuWindow.setMainMenu(menu);
  } catch (error) {
    // A menu that will not install is a usability loss, not a broken session:
    // every command it offers is reachable from the toolbar or a keystroke.
    log.error("Could not install the menu:", error);
  }
}
