// node --test tests/unit/editor/format.test.mjs
//
// The line length, and what to do with what ruff sends back. Both are small
// and both have a way of being wrong that nothing else would catch: a stored
// value that is not a number reaches the sidecar and raises there instead of
// answering, and an edit that replaces the text with itself looks to Monaco
// exactly like a real change - cursor moved, buffer dirty, undo stop pushed.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_LINE_LENGTH,
  formatEdits,
  lineLengthProblem,
  usableLineLength,
} from "../../../src/editor/format.js";

const RANGE = { startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 1 };

// --- what ruff is asked for ---

test("a plain number is used as it stands", () => {
  assert.equal(usableLineLength(100), 100);
  assert.equal(usableLineLength(20), 20);
});

test("nothing stored means ruff's own default", () => {
  assert.equal(usableLineLength(undefined), DEFAULT_LINE_LENGTH);
  assert.equal(usableLineLength(null), DEFAULT_LINE_LENGTH);
  assert.equal(DEFAULT_LINE_LENGTH, 88);
});

test("a number written as a string is read, because settings.json is edited by hand", () => {
  assert.equal(usableLineLength("100"), 100);
  assert.equal(usableLineLength(" 79 "), 79);
});

test("anything that is not a usable number falls back rather than reaching the sidecar", () => {
  // The failure this prevents is not cosmetic: ruff is given this, and
  // Mode(line_length="wide") raises on the format lane instead of answering.
  for (const stored of ["wide", "", true, {}, [], Number.NaN, Infinity, -40, 0, 100000]) {
    assert.equal(usableLineLength(stored), DEFAULT_LINE_LENGTH, `for ${JSON.stringify(stored)}`);
  }
});

test("a fraction is rounded rather than refused", () => {
  // Nobody types this; a hand-edited file can hold it, and it has an obvious
  // meaning, so refusing would be pedantry rather than safety.
  assert.equal(usableLineLength(87.5), 88);
  assert.equal(usableLineLength(99.4), 99);
});

// --- what the dialog says about what was typed ---

test("a good value has no problem", () => {
  assert.equal(lineLengthProblem("88"), null);
  assert.equal(lineLengthProblem(" 120 "), null);
});

test("an empty field is refused rather than silently defaulted", () => {
  assert.match(lineLengthProblem(""), /Enter a line length/);
  assert.match(lineLengthProblem("   "), /Enter a line length/);
});

test("something that is not a whole number is refused, and says so", () => {
  assert.match(lineLengthProblem("88.5"), /whole number/);
  assert.match(lineLengthProblem("wide"), /whole number/);
  assert.match(lineLengthProblem("-40"), /whole number/);
});

test("a number outside the usable range names the range", () => {
  assert.match(lineLengthProblem("4"), /between 20 and 1000/);
  assert.match(lineLengthProblem("100000"), /between 20 and 1000/);
});

test("the dialog and the reader disagree on purpose", () => {
  // usableLineLength copes so the formatter always works; lineLengthProblem
  // refuses so the user can see what they typed. The same input answers
  // differently and that is the point of there being two.
  assert.equal(usableLineLength("88.5"), 89);
  assert.notEqual(lineLengthProblem("88.5"), null);
});

// --- what comes back ---

test("formatted text becomes one edit over the whole document", () => {
  const edits = formatEdits("b=Box(1,2,3)\n", "b = Box(1, 2, 3)\n", RANGE);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "b = Box(1, 2, 3)\n");
  assert.deepEqual(edits[0].range, RANGE);
});

test("an unchanged buffer produces no edit at all", () => {
  // Not an optimisation. Replacing the text with itself still moves the cursor,
  // still marks the tab dirty and still pushes an undo stop, so formatting an
  // already-formatted file would look like it had done something.
  assert.deepEqual(formatEdits("b = Box(1, 2, 3)\n", "b = Box(1, 2, 3)\n", RANGE), []);
});

test("no answer produces no edit", () => {
  // What the sidecar sends when ruff refused a buffer that does not parse, and
  // what a dropped reply looks like. Neither may touch the user's text.
  assert.deepEqual(formatEdits("b=Box(", null, RANGE), []);
  assert.deepEqual(formatEdits("b=Box(", undefined, RANGE), []);
  assert.deepEqual(formatEdits("b=Box(", 88, RANGE), []);
});

test("formatting to empty is a real edit", () => {
  // A file of only comments and blank lines legitimately formats to nothing
  // much, and "" is falsey - a check written as `if (!formatted)` would drop it.
  assert.equal(formatEdits("\n\n\n", "", RANGE).length, 1);
});
