// node --test src/editor/tree.newnames.test.mjs
//
// Where a new file or folder goes, and what may be called what. Both are
// decided before anything touches the disk, which is the only place they can be
// held: afterwards the answer is a directory that exists in the wrong place, or
// a file that has quietly replaced one that was already there.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { freeName, nameProblem, parentOf, targetFolder } from "./tree.js";

const ROOT = "/proj";

test("a folder row means inside it", () => {
  assert.equal(targetFolder(ROOT, "/proj/parts", true), "/proj/parts");
});

test("a file row means beside it", () => {
  assert.equal(targetFolder(ROOT, "/proj/parts/bracket.py", false), "/proj/parts");
});

test("nothing selected means the root", () => {
  assert.equal(targetFolder(ROOT, null, false), ROOT);
  assert.equal(targetFolder(ROOT, "", false), ROOT);
});

test("a selection outside the project means the root", () => {
  // A tab can be open on a file from anywhere; the tree cannot create there.
  assert.equal(targetFolder(ROOT, "/elsewhere/other.py", false), ROOT);
});

test("Windows paths work the same way", () => {
  assert.equal(targetFolder("C:\\proj", "C:\\proj\\parts\\a.py", false), "C:\\proj\\parts");
  assert.equal(targetFolder("C:\\proj", "C:\\proj\\parts", true), "C:\\proj\\parts");
});

test("parentOf stops at the top rather than inventing a root", () => {
  assert.equal(parentOf("/proj/a.py"), "/proj");
  assert.equal(parentOf("/a.py"), null);
  assert.equal(parentOf("/proj/parts/"), "/proj");
  assert.equal(parentOf(null), null);
});

test("a name has to be something", () => {
  assert.match(nameProblem(""), /Enter a name/);
  assert.match(nameProblem("   "), /Enter a name/);
});

test("a path is not a name", () => {
  // The dialog says which folder it will go in, so a slash would put it
  // somewhere other than what the user was told.
  assert.match(nameProblem("sub/thing.py"), /no slashes/);
  assert.match(nameProblem("sub\\thing.py"), /no slashes/);
  assert.match(nameProblem(".."), /means a folder/);
});

test("a name already there is refused, whatever its case", () => {
  // macOS and Windows are case-insensitive by default, so "Parts" beside
  // "parts" is the same directory - and for a file it would overwrite it.
  assert.match(nameProblem("bracket.py", ["bracket.py"]), /already there/);
  assert.match(nameProblem("Bracket.py", ["bracket.py"]), /already there/);
  assert.equal(nameProblem("plate.py", ["bracket.py"]), null);
});

test("an ordinary name is fine", () => {
  assert.equal(nameProblem("parts"), null);
  assert.equal(nameProblem(" bracket.py "), null);
});

test("the opening name avoids what is already there", () => {
  assert.equal(freeName("untitled", ".py", []), "untitled.py");
  assert.equal(freeName("untitled", ".py", ["untitled.py"]), "untitled(1).py");
  assert.equal(freeName("untitled", ".py", ["untitled.py", "untitled(1).py"]), "untitled(2).py");
});

test("and ignores case, because two of these volumes do", () => {
  assert.equal(freeName("untitled", ".py", ["Untitled.py"]), "untitled(1).py");
});

test("a folder has no extension and is numbered the same way", () => {
  assert.equal(freeName("untitled", "", ["untitled"]), "untitled(1)");
});
