// node --test src/keys.test.mjs
//
// These exist for the same reason quoting.test.mjs does: the interesting half
// cannot be exercised on the machine it was written on. Two of the three
// platforms are somebody else's, and a shortcut that resolves to the wrong
// modifier does not announce itself - it silently does nothing, or worse, binds
// a chord the window manager was going to take.
//
// The values below are Monaco's real ones. They are written out rather than
// imported so that the test says what it is asserting, and so that a Monaco
// upgrade that changed them would fail here rather than in a keyboard nobody
// tries on Linux:
//
//   CtrlCmd 2048   Ctrl on Windows and Linux, Cmd on macOS
//   Shift   1024
//   Alt      512
//   WinCtrl  256   Super on Windows and Linux, Ctrl on macOS
//
// The whole point of this file is the second and fourth lines of that table.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  COMMANDS,
  chordFromEvent,
  chordProblem,
  describeChord,
  findChordConflicts,
  formatChord,
  monacoBinding,
  monacoBindings,
  parseChord,
  usableChords,
} from "./keys.js";

const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 };
const KeyCode = { Enter: 3, Escape: 9, Space: 10, KeyA: 31, KeyR: 48, Digit1: 22 };
// The function keys as a family rather than the ones that happen to be bound
// today: the check below walks every default chord, so a fake that knows only
// F5 reports a new F10 binding as broken when what is missing is the fake.
for (let n = 1; n <= 12; n += 1) {
  KeyCode[`F${n}`] = 60 + n;
}
const monaco = { KeyMod, KeyCode };

// --- parsing ---

test("parses a bare key", () => {
  assert.deepEqual(parseChord("f5"), {
    mod: false, ctrl: false, shift: false, alt: false, key: "f5",
  });
});

test("parses modifiers in any order and is case-insensitive", () => {
  const canonical = parseChord("ctrl+shift+enter");
  assert.deepEqual(parseChord("shift+ctrl+enter"), canonical);
  assert.deepEqual(parseChord("Shift+CTRL+Enter"), canonical);
});

test("formatting is canonical, so a chord round-trips", () => {
  assert.equal(formatChord(parseChord("shift+ctrl+enter")), "ctrl+shift+enter");
  assert.equal(formatChord(parseChord("alt+mod+a")), "mod+alt+a");
});

test("rejects what a hand-edited settings file gets wrong", () => {
  assert.equal(parseChord("ctrl+"), null, "trailing separator");
  assert.equal(parseChord("ctrl"), null, "modifier with no key");
  assert.equal(parseChord("enter+f5"), null, "two keys");
  assert.equal(parseChord("shift+shift+enter"), null, "repeated modifier");
  assert.equal(parseChord("meta+enter"), null, "unknown modifier");
  assert.equal(parseChord("ctrl+enterr"), null, "misspelt key");
  assert.equal(parseChord(""), null);
  assert.equal(parseChord(null), null);
  assert.equal(parseChord(42), null);
});

// --- the platform mapping, which is why this file exists ---

test("mod is Cmd on macOS and Ctrl elsewhere", () => {
  // Same token, same number - because CtrlCmd *is* both, which is exactly the
  // thing that makes the ctrl token below necessary.
  assert.equal(monacoBinding("Darwin", monaco, "mod+enter"), KeyMod.CtrlCmd | KeyCode.Enter);
  assert.equal(monacoBinding("Windows", monaco, "mod+enter"), KeyMod.CtrlCmd | KeyCode.Enter);
  assert.equal(monacoBinding("Linux", monaco, "mod+enter"), KeyMod.CtrlCmd | KeyCode.Enter);
});

test("ctrl is WinCtrl on macOS and CtrlCmd elsewhere", () => {
  // The one assertion this module exists to make. WinCtrl reads like a Windows
  // thing and is the macOS one; using it off macOS would bind a Super chord.
  assert.equal(monacoBinding("Darwin", monaco, "ctrl+enter"), KeyMod.WinCtrl | KeyCode.Enter);
  assert.equal(monacoBinding("Windows", monaco, "ctrl+enter"), KeyMod.CtrlCmd | KeyCode.Enter);
  assert.equal(monacoBinding("Linux", monaco, "ctrl+enter"), KeyMod.CtrlCmd | KeyCode.Enter);
});

test("mod and ctrl are the same chord off macOS and different on it", () => {
  // This is what lets "Ctrl-Enter, and Cmd-Enter as well on macOS" be written
  // once. Off macOS the two collapse; on macOS both are registered.
  assert.deepEqual(
    monacoBindings("Windows", monaco, ["ctrl+enter", "mod+enter"]),
    [KeyMod.CtrlCmd | KeyCode.Enter],
    "Windows must not register the same keybinding twice",
  );
  assert.deepEqual(
    monacoBindings("Linux", monaco, ["ctrl+enter", "mod+enter"]),
    [KeyMod.CtrlCmd | KeyCode.Enter],
  );
  assert.deepEqual(
    monacoBindings("Darwin", monaco, ["ctrl+enter", "mod+enter"]),
    [KeyMod.WinCtrl | KeyCode.Enter, KeyMod.CtrlCmd | KeyCode.Enter],
    "macOS accepts both Ctrl-Enter and Cmd-Enter",
  );
});

test("modifiers combine", () => {
  assert.equal(
    monacoBinding("Darwin", monaco, "ctrl+shift+enter"),
    KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Enter,
  );
  assert.equal(
    monacoBinding("Windows", monaco, "ctrl+shift+enter"),
    KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
  );
  assert.equal(
    monacoBinding("Linux", monaco, "mod+alt+a"),
    KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA,
  );
});

test("an unbindable chord is null rather than a wrong binding", () => {
  assert.equal(monacoBinding("Darwin", monaco, "ctrl+nonsense"), null);
  // A key this build of Monaco does not define must not silently become the
  // modifiers alone, which would bind Ctrl-nothing.
  assert.equal(monacoBinding("Darwin", { KeyMod, KeyCode: {} }, "ctrl+enter"), null);
});

test("unbindable chords are dropped, not allowed to sink the whole command", () => {
  assert.deepEqual(
    monacoBindings("Darwin", monaco, ["ctrl+nonsense", "f5"]),
    [KeyCode.F5],
  );
});

// --- the shipped defaults ---

test("every default chord parses and binds on every platform", () => {
  for (const command of COMMANDS) {
    // A command may deliberately have none: Stop Debugging is reached by the
    // menu and by the chord that starts it, and giving it a second chord of its
    // own would put two Monaco actions on one keystroke.
    if (command.chords.length === 0) {
      continue;
    }
    for (const platform of ["Darwin", "Windows", "Linux"]) {
      const bindings = monacoBindings(platform, monaco, command.chords);
      assert.ok(
        bindings.length > 0,
        `${command.id} has no binding on ${platform}`,
      );
      assert.ok(
        bindings.every((binding) => Number.isInteger(binding)),
        `${command.id} produced a non-numeric binding on ${platform}`,
      );
    }
  }
});

test("the defaults are the agreed keymap", () => {
  const chords = Object.fromEntries(COMMANDS.map((c) => [c.id, c.chords]));
  assert.deepEqual(chords["run.cell"], ["shift+enter"]);
  assert.deepEqual(chords["run.cell.stay"], ["ctrl+enter", "mod+enter"]);
  assert.deepEqual(chords["run.selectionOrLine"], ["ctrl+shift+enter", "mod+shift+enter"]);
  assert.deepEqual(chords["run.file"], ["f5"]);
});

test("no two commands claim the same chord on any platform", () => {
  // A conflict here is silent: Monaco takes the last registration and the other
  // command simply stops working, with nothing said.
  for (const platform of ["Darwin", "Windows", "Linux"]) {
    const claimed = new Map();
    for (const command of COMMANDS) {
      for (const binding of monacoBindings(platform, monaco, command.chords)) {
        assert.equal(
          claimed.get(binding),
          undefined,
          `${command.id} and ${claimed.get(binding)} both claim a chord on ${platform}`,
        );
        claimed.set(binding, command.id);
      }
    }
  }
});

test("run.file avoids the reload key on every platform", () => {
  // R is reload everywhere - Cmd-R on macOS, Ctrl-R on Windows and Linux - so
  // binding Run File to it puts discarding the buffer one keystroke away.
  const runFile = COMMANDS.find((command) => command.id === "run.file");
  assert.ok(runFile.chords.every((chord) => parseChord(chord).key !== "r"));
});

// --- what a hand-edited settings file is allowed to do ---

test("a configured chord replaces the default", () => {
  assert.deepEqual(
    usableChords("run.file", ["mod+shift+r"]),
    { chords: ["mod+shift+r"], rejected: [] },
  );
});

test("one bad chord costs itself and nothing else", () => {
  assert.deepEqual(
    usableChords("run.file", ["nonsense", "f9"]),
    { chords: ["f9"], rejected: ["nonsense"] },
  );
});

test("a command with nothing usable falls back to its default", () => {
  // The property that stops a typo locking someone out of their own editor.
  assert.deepEqual(
    usableChords("run.cell", ["nonsense"]),
    { chords: ["shift+enter"], rejected: ["nonsense"] },
  );
  assert.deepEqual(usableChords("run.cell", []).chords, ["shift+enter"]);
  assert.deepEqual(usableChords("run.cell", undefined).chords, ["shift+enter"]);
  assert.deepEqual(usableChords("run.cell", "shift+enter").chords, ["shift+enter"],
    "a bare string is not a list of chords");
});

test("an unknown command has no chords rather than throwing", () => {
  assert.deepEqual(usableChords("no.such.command", undefined).chords, []);
});

// --- how a person reads it ---

test("macOS uses symbols with no separator, everywhere else words with +", () => {
  assert.equal(describeChord("Darwin", "mod+shift+enter"), "⌘⇧↩");
  assert.equal(describeChord("Darwin", "ctrl+enter"), "⌃↩");
  assert.equal(describeChord("Windows", "ctrl+shift+enter"), "Ctrl+Shift+Enter");
  assert.equal(describeChord("Linux", "f5"), "F5");
  assert.equal(describeChord("Windows", "mod+a"), "Ctrl+A");
});

test("an unreadable chord describes as empty rather than throwing", () => {
  assert.equal(describeChord("Darwin", "ctrl+nonsense"), "");
});

test("a chord-less command is menu-only rather than a mistake", () => {
  // The distinction worth keeping: no chords is a decision, an *unparseable*
  // chord is a typo, and the two must not look alike.
  for (const command of COMMANDS) {
    for (const chord of command.chords) {
      assert.notEqual(parseChord(chord), null, `${command.id}: ${chord} does not parse`);
    }
  }
});

// --- recording a chord -----------------------------------------------------

const press = (code, modifiers = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

test("macOS: Command is mod, Control is ctrl", () => {
  assert.equal(chordFromEvent("Darwin", press("Enter", { metaKey: true })), "mod+enter");
  assert.equal(chordFromEvent("Darwin", press("Enter", { ctrlKey: true })), "ctrl+enter");
  assert.equal(
    chordFromEvent("Darwin", press("Enter", { metaKey: true, shiftKey: true })),
    "mod+shift+enter",
  );
});

test("elsewhere: Control is mod, and there is no ctrl token to reach", () => {
  for (const platform of ["Windows", "Linux"]) {
    assert.equal(chordFromEvent(platform, press("Enter", { ctrlKey: true })), "mod+enter");
  }
});

test("elsewhere: a Super chord is refused rather than bound to nothing", () => {
  // The window manager owns it, so a binding made with it would never fire.
  assert.equal(chordFromEvent("Windows", press("KeyS", { metaKey: true })), null);
});

test("a modifier on its own is not a chord yet", () => {
  // What a recorder sees constantly while somebody assembles a chord.
  for (const code of ["ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft"]) {
    assert.equal(chordFromEvent("Darwin", press(code, { shiftKey: true })), null);
  }
});

test("code is used rather than key, so the layout cannot change the meaning", () => {
  // Shift-2 reports "@" on a US layout and a quote on a German one; the chord
  // has to be the same either way, because that is what gets registered.
  assert.equal(chordFromEvent("Darwin", press("Digit2", { shiftKey: true })), "shift+2");
});

test("a key with no token is not recorded", () => {
  assert.equal(chordFromEvent("Darwin", press("IntlBackslash")), null);
});

test("every recorded chord parses back", () => {
  for (const code of ["KeyA", "Digit7", "F5", "Enter", "Comma", "ArrowUp", "Space"]) {
    const chord = chordFromEvent("Darwin", press(code, { metaKey: true }));
    assert.notEqual(parseChord(chord), null, `${code} produced ${chord}`);
  }
});

// --- what a chord may be ---------------------------------------------------

test("a bare letter is refused, because it would swallow that key", () => {
  assert.match(chordProblem("a"), /needs a modifier/);
  assert.match(chordProblem("enter"), /needs a modifier/);
});

test("a bare function key is fine - F5 is a shipped default", () => {
  assert.equal(chordProblem("f5"), null);
  assert.equal(chordProblem("shift+f5"), null);
});

test("a modified letter is fine", () => {
  assert.equal(chordProblem("mod+shift+p"), null);
});

// --- conflicts -------------------------------------------------------------

test("a chord on two commands is reported with both", () => {
  const found = findChordConflicts({ "run.cell": ["shift+enter"], "run.file": ["shift+enter"] });
  assert.equal(found.length, 1);
  assert.equal(found[0].chord, "shift+enter");
  assert.deepEqual(found[0].commands.sort(), ["run.cell", "run.file"]);
});

test("order within a chord does not hide a conflict", () => {
  const found = findChordConflicts({ a: ["shift+enter"], b: ["enter+shift"] });
  assert.equal(found.length, 1, "the two spellings are one chord");
});

test("one command with two chords is not a conflict with itself", () => {
  assert.deepEqual(findChordConflicts({ "run.cell.stay": ["ctrl+enter", "mod+enter"] }), []);
});

test("the shipped defaults do not conflict with each other", () => {
  // The one that would be embarrassing to ship broken.
  const defaults = Object.fromEntries(COMMANDS.map((c) => [c.id, c.chords]));
  assert.deepEqual(findChordConflicts(defaults), []);
});
