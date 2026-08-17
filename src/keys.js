// Keyboard shortcuts, as data rather than as literals at the call site.
//
// Shortcuts are subjective, so the bindings below are defaults and not verdicts:
// they are merged with whatever is in settings.json, and group 5 puts a dialog
// over the same map. Registering actions from a map rather than from constants
// is the part that would be expensive to retrofit - the dialog is then a form
// over data that already exists.
//
// The other reason this is a module and not a handful of constants is the menu.
// Menu items carry their own shortcut strings, so a binding the user changed has
// to reach both Monaco and the native menu. One map, read by both, is the only
// arrangement where those cannot drift apart.
//
// ## Chord strings
//
// VS Code's format, lowercase and "+"-separated: "shift+enter", "ctrl+shift+f5".
// Order does not matter when parsing and is canonical when formatting.
//
// Two modifier tokens mean different things, and the distinction is the whole
// reason this file can express what Phase 4 asked for:
//
//   mod    the platform's command modifier - Cmd on macOS, Ctrl everywhere else
//   ctrl   the Control key, literally, on every platform
//
// Off macOS they are the same key, and a command bound to both collapses to one
// registration. On macOS they are different, which is how "Ctrl-Enter, and
// Cmd-Enter as well on macOS" is written once and is correct on all three
// platforms - see RUN_CELL_STAY below.
//
// ## Monaco's modifiers do not match their names
//
// This is the trap this module exists to contain, and it is the reason the
// bindings are computed here rather than written out at each addAction:
//
//   KeyMod.CtrlCmd   Ctrl on Windows and Linux, *Cmd* on macOS
//   KeyMod.WinCtrl   the Super key on Windows and Linux, *Ctrl* on macOS
//
// So "literally Ctrl" is CtrlCmd off macOS and WinCtrl on it. Writing WinCtrl
// off macOS would bind a Super chord the window manager takes, which is why the
// platform is a parameter everywhere below rather than something read from a
// global - the same shape as quoteFor in quoting.js, and for the same reason:
// the interesting half cannot be exercised on the machine it is written on.

// Nothing is imported here on purpose. Reaching store.js would reach Neutralino
// through it, and this file would stop loading under `node --test` - which is
// where the platform mapping above is actually checked, because two of the three
// platforms are somebody else's machine. The settings-backed half lives in
// keybindings.js for exactly that reason; quoting.js and proc.js are split the
// same way.

/** Modifier tokens, in canonical order. */
const MODIFIERS = ["mod", "ctrl", "shift", "alt"];

/**
 * Key tokens this application uses, mapped to Monaco's KeyCode names.
 *
 * Deliberately a small list rather than everything Monaco knows. An unknown key
 * in settings.json is a typo, and a typo should be reported and ignored rather
 * than silently bound to nothing - which is indistinguishable from the feature
 * being broken. Letters and digits are added programmatically below.
 */
const NAMED_KEYS = {
  enter: "Enter",
  escape: "Escape",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "UpArrow",
  down: "DownArrow",
  left: "LeftArrow",
  right: "RightArrow",
  // Spelt out because "," is the chord separator's neighbour and a bare comma
  // in a chord string would be ambiguous to read even where it parses.
  comma: "Comma",
};

/** Key tokens that are one character to a person, whatever they are called here. */
export const KEY_CHARS = { comma: "," };

for (let n = 1; n <= 12; n += 1) {
  NAMED_KEYS[`f${n}`] = `F${n}`;
}
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  NAMED_KEYS[letter] = `Key${letter.toUpperCase()}`;
}
for (const digit of "0123456789") {
  NAMED_KEYS[digit] = `Digit${digit}`;
}

/** How each key is written for a person, where the token is not the label. */
const KEY_LABELS = {
  enter: { mac: "↩", other: "Enter" },
  escape: { mac: "⎋", other: "Esc" },
  space: { mac: "Space", other: "Space" },
  up: { mac: "↑", other: "Up" },
  down: { mac: "↓", other: "Down" },
  left: { mac: "←", other: "Left" },
  right: { mac: "→", other: "Right" },
};

const MODIFIER_LABELS = {
  mod: { mac: "⌘", other: "Ctrl" },
  ctrl: { mac: "⌃", other: "Ctrl" },
  shift: { mac: "⇧", other: "Shift" },
  alt: { mac: "⌥", other: "Alt" },
};

/**
 * The commands that can be bound, with their default chords.
 *
 * A command's default is a *list*, because one action can legitimately answer to
 * more than one chord. See the module comment for what mod and ctrl mean.
 *
 * The run bindings are Jupyter's where Jupyter has an opinion: Shift-Enter runs
 * the cell and advances, Ctrl-Enter runs it and stays. That pair is the muscle
 * memory most of this application's users already have, so it is worth matching
 * exactly rather than improving on. Jupyter has no "run line", and the chord
 * left over - Ctrl-Shift-Enter - takes it.
 */
export const COMMANDS = [
  {
    id: "run.cell",
    label: "Run Cell",
    chords: ["shift+enter"],
  },
  {
    id: "run.cell.stay",
    label: "Run Cell (Keep Cursor)",
    // Ctrl everywhere; macOS additionally accepts Cmd, as Jupyter does there.
    // Off macOS the two collapse to a single registration.
    chords: ["ctrl+enter", "mod+enter"],
  },
  {
    id: "run.selectionOrLine",
    label: "Run Selection or Line",
    chords: ["ctrl+shift+enter", "mod+shift+enter"],
  },
  {
    id: "run.all",
    label: "Run All",
    // Every cell, on the kernel, from the buffer - which is what "Run File" was
    // called and never was: it sends the text on screen and never touches disk.
    //
    // Alt-Enter keeps it in the Enter family with the other three, which is a
    // better story than an F-key orphaned from them. One collision, and it is
    // narrow: findController binds Alt-Enter to Select All Matches under
    // `precondition: CONTEXT_FIND_WIDGET_VISIBLE`, so the two compete only
    // while the find widget is open, where that action also has a button.
    // Jupyter spends Alt-Enter on "run cell and insert below", which has no
    // meaning in a .py file - there are `# %%` markers here, not cells to
    // insert - so the reflex costs a surprise rather than a wrong result.
    chords: ["alt+enter"],
  },
  {
    id: "run.file",
    label: "Run File",
    // The file on disk, saved first, in a process of its own - the debugger
    // without the debugger. Ctrl-F5 literally, on every platform, because that
    // is what VS Code binds Run Without Debugging to including on macOS, where
    // it is Control and not Command.
    chords: ["ctrl+f5"],
  },
  {
    id: "debug.start",
    label: "Debug File",
    // F5, which is VS Code's and is the whole point of the realignment. It used
    // to be Shift-F5 because F5 meant "run the buffer on the kernel"; that is
    // Run All now and lives on Alt-Enter, which frees the key its convention
    // wants. The handler continues a paused session rather than refusing, as
    // VS Code's F5 does, so one chord covers start and resume.
    chords: ["f5"],
  },
  {
    id: "debug.restart",
    label: "Restart Debugging",
    // Ctrl-Shift-F5 as VS Code has it, and the one place literal Ctrl is worth
    // spelling out on macOS: Cmd-Shift-F5 is not free there.
    chords: ["ctrl+shift+f5"],
  },
  {
    id: "debug.stop",
    label: "Stop Debugging",
    // Shift-F5, VS Code's, now that F5 no longer has to double as the way out.
    chords: ["shift+f5"],
  },
  {
    id: "debug.continue",
    label: "Continue",
    // No chord of its own: F5 resumes a paused session, which is what VS Code
    // does and what makes one key cover the whole start-and-carry-on gesture.
    // F8 used to be here because F5 was taken, and it collided with the
    // gotoError contribution - which binds F8 to "next problem", as VS Code
    // does. Giving it back is part of the same realignment.
    chords: [],
  },
  {
    id: "debug.stepOver",
    label: "Step Over",
    chords: ["f10"],
  },
  {
    id: "debug.stepInto",
    label: "Step Into",
    chords: ["f11"],
  },
  {
    id: "debug.stepOut",
    label: "Step Out",
    chords: ["shift+f11"],
  },
];

const DEFAULTS = Object.fromEntries(COMMANDS.map((command) => [command.id, command.chords]));

/**
 * Parse a chord string into a descriptor, or return null if it is not one.
 *
 * Null rather than a throw: these strings come from a file a user can edit, and
 * one bad line must cost that one binding rather than the editor's whole keymap.
 *
 * @param {string} chord e.g. "ctrl+shift+enter"
 */
export function parseChord(chord) {
  if (typeof chord !== "string") {
    return null;
  }
  const parts = chord.toLowerCase().split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    return null;
  }

  const descriptor = { mod: false, ctrl: false, shift: false, alt: false, key: null };
  for (const part of parts) {
    if (MODIFIERS.includes(part)) {
      if (descriptor[part]) {
        // "shift+shift+enter" is a typo, not a chord.
        return null;
      }
      descriptor[part] = true;
      continue;
    }
    if (descriptor.key !== null) {
      // Two keys, which no chord has: "enter+f5".
      return null;
    }
    if (!Object.hasOwn(NAMED_KEYS, part)) {
      return null;
    }
    descriptor.key = part;
  }

  return descriptor.key === null ? null : descriptor;
}

/** Write a descriptor back out in canonical form, for round-tripping. */
export function formatChord(descriptor) {
  const parts = MODIFIERS.filter((modifier) => descriptor[modifier]);
  parts.push(descriptor.key);
  return parts.join("+");
}

/**
 * Write a chord the way a person on this platform reads it.
 *
 * macOS uses the symbols and no separator, which is what every other Mac
 * application does; everywhere else it is words joined by "+".
 *
 * @param {string} platform NL_OS: "Windows", "Darwin" or "Linux"
 */
export function describeChord(platform, chord) {
  const descriptor = typeof chord === "string" ? parseChord(chord) : chord;
  if (descriptor === null) {
    return "";
  }
  const mac = platform === "Darwin";
  const parts = MODIFIERS
    .filter((modifier) => descriptor[modifier])
    .map((modifier) => (mac ? MODIFIER_LABELS[modifier].mac : MODIFIER_LABELS[modifier].other));

  const label = KEY_LABELS[descriptor.key];
  if (label !== undefined) {
    parts.push(mac ? label.mac : label.other);
  } else if (Object.hasOwn(KEY_CHARS, descriptor.key)) {
    parts.push(KEY_CHARS[descriptor.key]);
  } else if (descriptor.key.length === 1) {
    parts.push(descriptor.key.toUpperCase());
  } else {
    parts.push(descriptor.key.charAt(0).toUpperCase() + descriptor.key.slice(1));
  }

  return mac ? parts.join("") : parts.join("+");
}

/**
 * A tooltip that names its shortcut, or just the label when it has none.
 *
 * Here rather than in the toolbar because it is the one place that decides how
 * a chord is written beside a name, and the toolbar had been spelling its own -
 * literal "(Alt+Enter)" and "(Shift+F5)" strings in the markup, which said
 * "Enter" where the menu beside them said "↩", went on claiming Shift+F5 after
 * the chords were realigned, and appeared on three buttons out of five.
 */
export function titleWithChord(label, chord) {
  return chord === "" || chord === undefined || chord === null ? label : `${label} (${chord})`;
}

/**
 * Turn one chord into a Monaco keybinding number.
 *
 * KeyMod and KeyCode are passed in rather than imported, so this is exercisable
 * without loading nine megabytes of editor - and so the platform mapping, which
 * is the only part that can be wrong, is tested rather than trusted.
 *
 * @param {string} platform NL_OS: "Windows", "Darwin" or "Linux"
 * @param {object} monaco {KeyMod, KeyCode}
 */
export function monacoBinding(platform, monaco, chord) {
  const descriptor = typeof chord === "string" ? parseChord(chord) : chord;
  if (descriptor === null) {
    return null;
  }
  const code = monaco.KeyCode[NAMED_KEYS[descriptor.key]];
  if (code === undefined) {
    return null;
  }

  const mac = platform === "Darwin";
  let binding = 0;
  if (descriptor.mod) {
    binding |= monaco.KeyMod.CtrlCmd;
  }
  if (descriptor.ctrl) {
    // The line this module exists for. See the module comment.
    binding |= mac ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
  }
  if (descriptor.shift) {
    binding |= monaco.KeyMod.Shift;
  }
  if (descriptor.alt) {
    binding |= monaco.KeyMod.Alt;
  }
  return binding | code;
}

/**
 * Every Monaco keybinding for one command, deduplicated.
 *
 * The dedup is not tidiness. "ctrl+enter" and "mod+enter" are the same chord off
 * macOS, so a command carrying both would register the same keybinding twice -
 * which Monaco tolerates but which would show the shortcut twice in any list
 * built from this.
 */
export function monacoBindings(platform, monaco, chords) {
  const bindings = [];
  for (const chord of chords) {
    const binding = monacoBinding(platform, monaco, chord);
    if (binding !== null && !bindings.includes(binding)) {
      bindings.push(binding);
    }
  }
  return bindings;
}

/** The shipped chords for one command. See keybindings.js for the user's. */
export function defaultChordsFor(commandId) {
  return DEFAULTS[commandId] ?? [];
}

/**
 * Keep only the chords that can actually be bound, and say which were dropped.
 *
 * Split from the settings lookup so that the rule - one bad line costs that one
 * binding and nothing else - is testable without a settings file. A user editing
 * the file by hand must not be able to lock themselves out of the editor with a
 * typo.
 */
export function usableChords(commandId, configured) {
  if (!Array.isArray(configured)) {
    return { chords: defaultChordsFor(commandId), rejected: [] };
  }
  const chords = configured.filter((chord) => parseChord(chord) !== null);
  const rejected = configured.filter((chord) => parseChord(chord) === null);
  if (chords.length === 0) {
    return { chords: defaultChordsFor(commandId), rejected };
  }
  return { chords, rejected };
}

// --- recording a chord, and checking the result ----------------------------

/**
 * DOM `KeyboardEvent.code` values, mapped to the tokens above.
 *
 * `code` rather than `key` for everything that is not a letter, because `key`
 * carries the *result* of the modifiers: Shift-2 reports "@" on a US layout and
 * `"` on a German one, and Alt-something reports whatever character the layout
 * produces. `code` names the physical key, which is what those chords mean.
 *
 * **Letters are the exception, and it took a bug report to see it.** `code`
 * names the physical key by its position on a US keyboard, so on a German one
 * the keycap printed Y arrives as `KeyZ` - and recording ⇧⌘Y there stored
 * `mod+shift+z`. That is wrong twice over: it is not the chord the user
 * pressed, and it is not what fires afterwards either, because Monaco
 * dispatches on the legacy `keyCode`, which follows the layout for letters
 * (`node_modules/monaco-editor/esm/vs/base/browser/keyboardEvent.js`, where
 * `extractKeyCode` reads `e.keyCode`). So a letter chord is the letter on the
 * keycap, and `chordFromEvent` takes it from `key`.
 *
 * Built rather than listed for the ranges, so it cannot drift from NAMED_KEYS.
 */
const CODES = {
  Enter: "enter",
  NumpadEnter: "enter",
  Escape: "escape",
  Space: "space",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Comma: "comma",
};
for (let n = 1; n <= 12; n += 1) {
  CODES[`F${n}`] = `f${n}`;
}
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  CODES[`Key${letter.toUpperCase()}`] = letter;
}
for (const digit of "0123456789") {
  CODES[`Digit${digit}`] = digit;
}

/**
 * The token for the key that was pressed: the keycap for a letter, the physical
 * key for everything else.
 *
 * A letter is taken from `event.key` so that an international layout records
 * what is printed on the key - see the CODES comment for why the two disagree
 * and which one fires. `key` is uppercased while Shift is held, hence the fold.
 *
 * With Alt held on macOS a letter key produces a symbol rather than a letter
 * (Alt-D is "∂"), so that falls through to the physical key. It is the best
 * available answer: the browser offers no way to ask what the unmodified key
 * would have produced, and WebKit has no `navigator.keyboard.getLayoutMap`.
 */
function keyToken(event) {
  const character = typeof event.key === "string" ? event.key.toLowerCase() : "";
  if (/^[a-z]$/.test(character)) {
    return character;
  }
  return CODES[event.code];
}

/**
 * The chord a keydown represents, or null if it is not one yet.
 *
 * Null covers the two cases a recorder meets constantly and must not treat as
 * input: a modifier pressed on its own, which is what happens while somebody is
 * still assembling a chord, and a key this application has no token for.
 *
 * The platform split is the whole reason `mod` and `ctrl` are separate tokens.
 * On macOS Command is `mod` and Control is `ctrl`; everywhere else Control is
 * `mod`, and Meta is the Super key, which the window manager owns - so a chord
 * recorded with it is refused rather than bound to something that will never
 * arrive.
 *
 * @param {string} platform NL_OS: "Windows", "Darwin" or "Linux"
 * @param {KeyboardEvent} event
 */
export function chordFromEvent(platform, event) {
  const key = keyToken(event);
  if (key === undefined) {
    return null;
  }

  const mac = platform === "Darwin";
  if (!mac && event.metaKey) {
    return null;
  }

  const descriptor = {
    mod: mac ? event.metaKey : event.ctrlKey,
    ctrl: mac ? event.ctrlKey : false,
    shift: event.shiftKey,
    alt: event.altKey,
    key,
  };
  return formatChord(descriptor);
}

/**
 * Why this chord should not be bound, or null if it is fine.
 *
 * Only the rule that a person would otherwise discover by losing the ability to
 * type: a bare letter, digit or Enter swallows that key everywhere the action is
 * registered. Function keys are exempt because they are not typing - F5 is a
 * shipped default.
 */
export function chordProblem(chord) {
  const descriptor = parseChord(chord);
  if (descriptor === null) {
    return "not a chord";
  }
  const bare = !MODIFIERS.some((modifier) => descriptor[modifier]);
  if (bare && /^f\d+$/.test(descriptor.key) === false) {
    return "needs a modifier, or it would swallow that key while typing";
  }
  return null;
}

/**
 * Chords bound to more than one command.
 *
 * Reported rather than prevented: which of two commands a user meant to keep is
 * theirs to decide, and refusing the second one silently would look like the
 * dialog had ignored them.
 *
 * @param {object} bindings {commandId: [chord]}
 * @returns {Array<{chord: string, commands: string[]}>}
 */
export function findChordConflicts(bindings) {
  const owners = new Map();
  for (const [commandId, chords] of Object.entries(bindings)) {
    for (const chord of chords ?? []) {
      const descriptor = parseChord(chord);
      if (descriptor === null) {
        continue;
      }
      // Canonical, so "shift+enter" and "enter+shift" are seen as one chord.
      const canonical = formatChord(descriptor);
      const existing = owners.get(canonical);
      if (existing === undefined) {
        owners.set(canonical, [commandId]);
      } else if (!existing.includes(commandId)) {
        existing.push(commandId);
      }
    }
  }
  return [...owners.entries()]
    .filter(([, commands]) => commands.length > 1)
    .map(([chord, commands]) => ({ chord, commands }));
}
