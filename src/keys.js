// Keyboard shortcuts, as data rather than as literals at the call site.
//
// Shortcuts are subjective, so the bindings below are defaults and not verdicts:
// they are merged with whatever is in settings.json, and group 4 puts a dialog
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
    id: "run.file",
    label: "Run File",
    // F5 rather than Ctrl-R or Cmd-R: R is the reload key on every platform, so
    // binding it puts Run File one mistaken keystroke away from discarding the
    // buffer. F5 is a browser reload too, on Windows and Linux - which is why
    // the reload guard is a prerequisite for this and not a nicety.
    chords: ["f5"],
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
