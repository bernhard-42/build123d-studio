// The native menu bar, as data.
//
// Its first job is copy and paste. There is no menu today, so on macOS the
// standard editing shortcuts are never bound to anything and Cmd-C in the
// console or a dialog simply does nothing - the keystroke is swallowed before
// the page sees it. A menu is the mechanism that gets it delivered.
//
// ## What the documentation guarantees, which is all this relies on
//
// From the Neutralino window API for setMainMenu:
//
//   text       the label; "-" is a separator
//   id         a unique identifier
//   action     a pre-defined native role, e.g. "copy:", "cut:", "paste:"
//   shortcut   binds on macOS as a single character with Command implied
//              ("c" is Cmd-C), and *only displays* on Windows and GNU/Linux
//   isDisabled greys the item out
//   menuItems  a submenu
//
// and a click emits mainMenuItemClicked.
//
// Two things follow, and they are limitations rather than choices:
//
// * Only a Cmd-plus-one-character chord can be shown on macOS. Shift-Enter and
//   F5 cannot be expressed at all there, so the Run items carry no shortcut on
//   macOS and carry a display string everywhere else. Monaco binds them in every
//   case - the menu is not what makes them work.
// * Off macOS the menu binds nothing. Its items still have to *work* when
//   clicked, which is what the ids and mainMenuItemClicked are for.
//
// ## What it deliberately does not rely on
//
// The documentation does not say what mainMenuItemClicked carries, whether the
// native roles exist off macOS, or whether an item with a role *also* raises the
// click event. That last one matters - a role and a handler both firing would
// paste twice - so nothing here has both, and the questions are settled by a
// build rather than by reading somebody's source.
//
// This module is pure so that the shape can be asserted without a window; the
// installing half is menubar.js. Same split as keys.js and keybindings.js.

import { KEY_CHARS, describeChord } from "./keys.js";

/** Every command the menu can raise. Ids are what come back on a click. */
export const MENU = {
  ABOUT: "app.about",
  SETTINGS: "app.settings",
  QUIT: "app.quit",
  NEW: "file.new",
  OPEN: "file.open",
  OPEN_FOLDER: "file.openFolder",
  CLOSE_FOLDER: "file.closeFolder",
  SAVE: "file.save",
  SAVE_AS: "file.saveAs",
  SAVE_ALL: "file.saveAll",
  CLOSE: "file.close",
  CLOSE_ALL: "file.closeAll",
  TOGGLE_SIDEBAR: "view.sidebar",
  CUT: "edit.cut",
  COPY: "edit.copy",
  PASTE: "edit.paste",
};

/** Native roles, which the documentation defines for the clipboard items. */
const ROLES = {
  [MENU.CUT]: "cut:",
  [MENU.COPY]: "copy:",
  [MENU.PASTE]: "paste:",
};

const SEPARATOR = { text: "-" };

/**
 * How a chord is written in a menu on this platform, or undefined.
 *
 * macOS takes a single character and supplies Command itself, so only a
 * mod-plus-letter chord can be expressed - anything else would set a key
 * equivalent that is wrong rather than absent. Everywhere else the field is
 * documented as display-only, so it takes the readable form.
 *
 * @param {string} platform NL_OS: "Windows", "Darwin" or "Linux"
 * @param {{mod: boolean, ctrl: boolean, shift: boolean, alt: boolean, key: string}} chord
 */
export function menuShortcut(platform, chord) {
  if (chord === null || chord === undefined) {
    return undefined;
  }
  const character = singleCharacter(chord.key);

  if (platform !== "Darwin") {
    const parts = [];
    if (chord.mod || chord.ctrl) {
      parts.push("Ctrl");
    }
    if (chord.shift) {
      parts.push("Shift");
    }
    if (chord.alt) {
      parts.push("Alt");
    }
    parts.push(character === undefined ? capitalise(chord.key) : character.toUpperCase());
    return parts.join(" + ");
  }

  // Command plus exactly one character, and nothing else, is the only thing
  // macOS can be told through this field.
  const onlyMod = chord.mod && !chord.ctrl && !chord.shift && !chord.alt;
  return onlyMod && character !== undefined ? character : undefined;
}

/** The one character a key token stands for, or undefined if it is not one. */
function singleCharacter(key) {
  if (Object.hasOwn(KEY_CHARS, key)) {
    return KEY_CHARS[key];
  }
  return key.length === 1 ? key : undefined;
}

function capitalise(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function item(id, text, { platform, shortcut, enabled = true, role = false }) {
  const built = { id, text };
  if (role && Object.hasOwn(ROLES, id)) {
    built.action = ROLES[id];
  }
  const accelerator = menuShortcut(platform, shortcut);
  if (accelerator !== undefined) {
    built.shortcut = accelerator;
  } else if (platform === "Darwin" && shortcut !== null && shortcut !== undefined) {
    // Written into the label, because macOS can be told nothing else.
    //
    // The shortcut field there is not a display string: it *binds*, as Command
    // plus one character, so Shift-Enter, F5 and Shift-F5 cannot be expressed
    // through it at all and a value chosen to look right would bind a chord
    // nobody asked for. The label is a plain string this application controls,
    // so the chord goes in it - after the text rather than in the right-aligned
    // column macOS would use, which is the whole of what is lost. Windows and
    // Linux get the real display shortcut above and never reach this.
    built.text = `${text}  (${describeChord(platform, shortcut)})`;
  }
  if (!enabled) {
    built.isDisabled = true;
  }
  return built;
}

/**
 * Build the whole menu.
 *
 * @param {object} options
 * @param {string} options.platform NL_OS
 * @param {(id: string) => object|null} options.chordFor parsed chord per command, or null
 * @param {(id: string) => boolean} options.isEnabled
 * @param {boolean} options.nativeClipboard whether the Edit items carry native
 *   roles rather than being handled by us. See menubar.js.
 * @param {Array<{id: string, label: string}>} options.runCommands from keys.js,
 *   so the menu cannot drift from what Monaco actually bound
 */

// The Run menu's shape, which is not the order the keymap happens to list its
// commands in. Three ideas, separated: run part of this file, run the whole of
// it, debug it. Grouping is the only thing a menu can say about which items
// belong together, and this one would otherwise be nine flat entries.
const RUN_GROUPS = [
  ["run.cell", "run.cell.stay", "run.selectionOrLine", "run.all"],
  ["run.file"],
  ["debug.start", "debug.stepOver", "debug.stepInto", "debug.stepOut", "debug.continue",
   "debug.restart", "debug.stop"],
];

/**
 * Build the Run menu from the keymap, in groups.
 *
 * A command the groups do not mention is appended rather than dropped: this
 * table and keys.js are two lists that have to agree, and the failure that
 * costs nothing to prevent is a new command that silently never appears.
 */
function runGroups(runCommands, at) {
  const byId = new Map(runCommands.map((command) => [command.id, command]));
  const items = [];
  for (const group of RUN_GROUPS) {
    const present = group.filter((id) => byId.has(id));
    if (present.length === 0) {
      continue;
    }
    if (items.length > 0) {
      items.push(SEPARATOR);
    }
    for (const id of present) {
      items.push(at(id, byId.get(id).label));
      byId.delete(id);
    }
  }
  for (const command of byId.values()) {
    items.push(at(command.id, command.label));
  }
  return items;
}

export function buildMenu({
  platform, chordFor, isEnabled, nativeClipboard, runCommands, appName = "build123d Studio",
}) {
  const at = (id, text, extra = {}) =>
    item(id, text, { platform, shortcut: chordFor(id), enabled: isEnabled(id), ...extra });
  const mac = platform === "Darwin";

  // On macOS the first entry becomes the application menu - it takes the app's
  // name whatever this says, and it swallows whatever items are in it. Observed
  // on a build: with File first, there was no File menu at all and New, Open and
  // Save had been absorbed into "build123d Studio". So the application menu has
  // to be the one that goes first, which is where About and Settings belong on
  // that platform anyway.
  // Quit is here rather than assumed: setting a main menu replaces the one macOS
  // would have provided, and the standard Quit item goes with it. Observed, not
  // deduced.
  const appMenu = {
    id: "menu.app",
    text: appName,
    menuItems: [
      at(MENU.ABOUT, `About ${appName}`),
      SEPARATOR,
      at(MENU.SETTINGS, "Settings…"),
      SEPARATOR,
      at(MENU.QUIT, `Quit ${appName}`),
    ],
  };

  // Elsewhere there is no application menu, so the same items go where those
  // platforms look for them: Quit at the foot of File, and About under Help.
  const helpMenu = {
    id: "menu.help",
    text: "Help",
    menuItems: [at(MENU.SETTINGS, "Settings…"), SEPARATOR, at(MENU.ABOUT, `About ${appName}`)],
  };

  return [
    ...(mac ? [appMenu] : []),
    {
      id: "menu.file",
      text: "File",
      menuItems: [
        at(MENU.NEW, "New"),
        at(MENU.OPEN, "Open File…"),
        at(MENU.OPEN_FOLDER, "Open Folder…"),
        SEPARATOR,
        at(MENU.SAVE, "Save"),
        at(MENU.SAVE_AS, "Save As…"),
        at(MENU.SAVE_ALL, "Save All"),
        SEPARATOR,
        at(MENU.CLOSE, "Close"),
        at(MENU.CLOSE_ALL, "Close All"),
        at(MENU.CLOSE_FOLDER, "Close Folder"),
        ...(mac ? [] : [SEPARATOR, at(MENU.QUIT, "Exit")]),
      ],
    },
    {
      id: "menu.view",
      text: "View",
      menuItems: [at(MENU.TOGGLE_SIDEBAR, "Toggle Sidebar")],
    },
    {
      id: "menu.edit",
      text: "Edit",
      menuItems: [
        at(MENU.CUT, "Cut", { role: nativeClipboard }),
        at(MENU.COPY, "Copy", { role: nativeClipboard }),
        at(MENU.PASTE, "Paste", { role: nativeClipboard }),
      ],
    },
    {
      id: "menu.run",
      text: "Run",
      menuItems: runGroups(runCommands, at),
    },
    ...(mac ? [] : [helpMenu]),
  ];
}
