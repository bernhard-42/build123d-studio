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

import { events, window as neuWindow } from "@neutralinojs/lib";

import { COMMANDS, parseChord } from "./keys.js";
import { MENU, buildMenu } from "./menu.js";
import { chordsFor } from "./keybindings.js";
import * as log from "./log.js";

// Items that need multi-file support. Built now so the menu's shape is settled,
// disabled until group 2 gives them something to do - a greyed-out Close Tab
// says "not yet" where a missing one says nothing at all.
const NEEDS_TABS = new Set([
  MENU.OPEN_FOLDER,
  MENU.SAVE_ALL,
  MENU.CLOSE,
  MENU.CLOSE_ALL,
  MENU.CLOSE_TAB,
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
  [MENU.CUT]: "mod+x",
  [MENU.COPY]: "mod+c",
  [MENU.PASTE]: "mod+v",
};

let handlers = {};
let clipboardIsNative = false;

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
  await refreshMenu();
}

/**
 * Rebuild and re-install the menu.
 *
 * Whole rather than mutated, because there is no documented way to change one
 * item, and because a menu built from the current keymap has to be rebuilt when
 * that keymap changes - which is what group 4's dialog will do.
 */
export async function refreshMenu() {
  const menu = buildMenu({
    platform: NL_OS,
    chordFor,
    isEnabled: (id) => !NEEDS_TABS.has(id),
    nativeClipboard: clipboardIsNative,
    runCommands: COMMANDS,
  });

  try {
    await neuWindow.setMainMenu(menu);
  } catch (error) {
    // A menu that will not install is a usability loss, not a broken session:
    // every command it offers is reachable from the toolbar or a keystroke.
    log.error("Could not install the menu:", error);
  }
}
