// node --test tests/unit/editor/starters.test.mjs
//
// The two starter texts against the things they claim about the application.
//
// Both explain the run shortcuts, and prose does not move when keys.js does.
// That has already gone wrong: the New File draft named three of the four
// chords for the wrong actions and left F5 out altogether, and it was caught by
// a person reading it. Nothing here can tell whether a sentence is attached to
// the right chord - that still needs eyes - but "F5 is not mentioned at all"
// and "this text names a chord that is no longer the default" are exactly the
// shapes a test can hold, and they are the shapes that got through.
//
// The cell claims are checkable outright: the texts say what "# %%" does and
// are laid out so that one Run does something, and findCells is what decides
// both.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { COMMANDS, describeChord } from "../../../src/keys.js";
import { findCells } from "../../../src/editor/cells.js";
import { DEFAULT_NEW_FILE_TEMPLATE, SAMPLE_SOURCE } from "../../../src/editor/starters.js";

// Only the run bindings, and only the ones that ship with a chord. Group 5
// opens this map to editing and may well add commands to it that a starter file
// has no business explaining - and a command with no default has no chord to
// name, so requiring the text to mention one would be requiring it to invent
// one. The cell-marker commands are that case: they are buttons and menu items,
// and the Shortcuts tab binds them for anybody who wants a chord.
const RUN_COMMANDS = COMMANDS.filter(
  (command) => command.id.startsWith("run.") && command.chords.length > 0,
);

const TEXTS = [
  ["the New File template", DEFAULT_NEW_FILE_TEMPLATE],
  ["the first-run sample", SAMPLE_SOURCE],
];

/**
 * Whether a text names a chord in the form these texts write chords.
 *
 * They use the non-macOS spelling - words joined by "+" - because a comment
 * that is copied between machines cannot be written in ⌘⇧↵ and stay true. Where
 * macOS accepts Cmd as well the text says "Ctrl/Cmd+…", which is describeChord's
 * ordinary output with "/Cmd" inserted, so both spellings are accepted here.
 */
function mentions(text, chord) {
  const written = describeChord("Windows", chord);
  return text.includes(written) || text.includes(written.replace("Ctrl+", "Ctrl/Cmd+"));
}

// --- the chords ---

for (const [name, text] of TEXTS) {
  for (const command of RUN_COMMANDS) {
    test(`${name} names a default chord for ${command.id}`, () => {
      assert.ok(
        command.chords.some((chord) => mentions(text, chord)),
        `${name} explains the run shortcuts but names none of ` +
          `[${command.chords.join(", ")}] for ${command.id}. Either the default ` +
          `moved and the text still describes the old one, or the action was ` +
          `left out - F5 was, once.`,
      );
    });
  }
}

test("the texts name no chord that is not a default", () => {
  // The other direction: a chord written into the prose that no command
  // answers to any more. Enter-key chords only, which is what these texts are
  // about, and enough to have caught the draft that promised Cmd+Shift+Enter
  // would run the file.
  const defaults = new Set(
    RUN_COMMANDS.flatMap((command) => command.chords.map((chord) => describeChord("Windows", chord))),
  );
  for (const [name, text] of TEXTS) {
    const written = text.match(/\b(?:[A-Z][a-z]+(?:\/Cmd)?\+)+Enter\b/g) ?? [];
    for (const chord of written) {
      assert.ok(
        defaults.has(chord.replace("/Cmd", "")),
        `${name} names ${chord}, which is not a default binding of any run command`,
      );
    }
  }
});

// --- the cells ---

test("the New File template is laid out as the cells it describes", () => {
  const cells = findCells(DEFAULT_NEW_FILE_TEMPLATE);
  const marked = cells.filter((cell) => cell.marked);
  assert.equal(marked.length, 2, "two '# %%' markers, as the text says there are");

  // The explanation and the imports are one cell, so the first Run makes show
  // available; the model is the next one, so the second Run puts something in
  // the viewer. Two keystrokes from a new file to a shape on screen is the
  // whole point of shipping a template rather than an empty buffer.
  assert.match(cells[0].code, /from build123d import \*/);
  assert.match(cells[0].code, /from build123d_studio import show/);

  const body = cells.find((cell) => cell.code.includes("Box("));
  assert.ok(body !== undefined, "the template builds something");
  assert.match(body.code, /show\(/, "and shows it in the same cell, so one Run fills the viewer");
});

test("the template's prose is not itself a cell boundary", () => {
  // "# %%" appears inside the explanation, quoted. A marker regex that matched
  // it would split the header and make the first Run a no-op.
  const [first] = findCells(DEFAULT_NEW_FILE_TEMPLATE);
  assert.equal(first.marked, false);
  assert.match(first.code, /cell boundaries/);
});

test("the sample builds and shows in one cell too", () => {
  const cells = findCells(SAMPLE_SOURCE);
  const body = cells.find((cell) => cell.code.includes("Box("));
  assert.ok(body !== undefined);
  assert.match(body.code, /show\(part\)/);
});

// --- what the texts import ---

test("both texts import show from build123d_studio", () => {
  // The name of the shim is the one thing here that is ours rather than
  // build123d's, and a rename that missed these would leave every new file
  // starting with an ImportError.
  for (const [name, text] of TEXTS) {
    assert.match(text, /from build123d_studio import show/, name);
  }
});
