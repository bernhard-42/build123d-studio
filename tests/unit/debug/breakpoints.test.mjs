// node --test tests/unit/debug/breakpoints.test.mjs

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { clear, forget, has, linesOf, replace, toggle } from "../../../src/debug/breakpoints.js";

test("a line goes on and comes off again", () => {
  clear();
  assert.deepEqual(toggle("a", 5), [5]);
  assert.equal(has("a", 5), true);
  assert.deepEqual(toggle("a", 5), []);
  assert.equal(has("a", 5), false);
});

test("lines come back in the order a person reads them", () => {
  // The order the setBreakpoints request is built in, and the order the gutter
  // is drawn in. Insertion order would put them wherever they were clicked.
  clear();
  toggle("a", 12);
  toggle("a", 3);
  toggle("a", 40);
  assert.deepEqual(linesOf("a"), [3, 12, 40]);
});

test("two buffers keep their own", () => {
  clear();
  toggle("a", 5);
  toggle("b", 9);
  assert.deepEqual(linesOf("a"), [5]);
  assert.deepEqual(linesOf("b"), [9]);
});

test("a buffer with none is an empty list, not a missing one", () => {
  clear();
  assert.deepEqual(linesOf("never-touched"), []);
});

test("a line number that is not a line is refused", () => {
  // Monaco will not produce one; a mark the adapter silently rejects is worse
  // than no mark, because the gutter would still show it.
  clear();
  assert.deepEqual(toggle("a", 0), []);
  assert.deepEqual(toggle("a", -3), []);
  assert.deepEqual(toggle("a", 1.5), []);
});

test("an edit moves them wholesale, and duplicates collapse", () => {
  // Monaco moves the decorations when text is inserted above them, and this is
  // where the new positions are written back. Deleting the lines between two
  // marks pushes both onto one line, and two identical entries in a
  // setBreakpoints request describes a file nobody has.
  clear();
  toggle("a", 3);
  toggle("a", 7);
  assert.deepEqual(replace("a", [4, 8]), [4, 8]);
  assert.deepEqual(replace("a", [4, 4]), [4]);
});

test("replacing with nothing leaves nothing", () => {
  clear();
  toggle("a", 3);
  assert.deepEqual(replace("a", []), []);
  assert.equal(has("a", 3), false);
});

test("closing a tab forgets its marks, and only its own", () => {
  clear();
  toggle("a", 5);
  toggle("b", 9);
  forget("a");
  assert.deepEqual(linesOf("a"), []);
  assert.deepEqual(linesOf("b"), [9]);
});
