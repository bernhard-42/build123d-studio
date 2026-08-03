// node --test src/editor/tabs.test.mjs
//
// Tab labels, and the hint that tells two files of the same name apart. A CAD
// project has parts/bracket.py and fixtures/bracket.py in it as a matter of
// course, so this is the case that decides whether the strip is usable, not an
// edge one.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { labelsFor } from "./tabs.js";

const buffers = (...paths) => paths.map((path, index) => ({ key: index + 1, path }));
const labels = (...paths) => labelsFor(buffers(...paths)).map((t) => t.label);
const hints = (...paths) => labelsFor(buffers(...paths)).map((t) => t.hint);

// --- the ordinary case ---

test("a tab is called after its file, and knows its path", () => {
  const [tab] = labelsFor(buffers("/home/b/cad/bracket.py"));
  assert.equal(tab.label, "bracket.py");
  assert.equal(tab.hint, "");
  assert.equal(tab.title, "/home/b/cad/bracket.py");
});

test("distinct names need no hint, however deep they sit", () => {
  assert.deepEqual(hints("/a/b/c/bracket.py", "/x/y/z/hinge.py"), ["", ""]);
});

// --- telling two of the same name apart ---

test("two files of one name are told apart by their folders", () => {
  assert.deepEqual(
    hints("/p/parts/bracket.py", "/p/fixtures/bracket.py"),
    ["parts", "fixtures"],
  );
  // The label itself stays the filename - the hint is additional, not a
  // replacement, so the eye still lands on the name it is looking for.
  assert.deepEqual(
    labels("/p/parts/bracket.py", "/p/fixtures/bracket.py"),
    ["bracket.py", "bracket.py"],
  );
});

test("one segment is not enough when the parents match too", () => {
  assert.deepEqual(
    hints("/p/v1/parts/bracket.py", "/p/v2/parts/bracket.py"),
    ["v1/parts", "v2/parts"],
  );
});

test("the hint grows only as far as it must", () => {
  // Three deep and identical until the very top, so the whole parent path is
  // the only thing that separates them - and that is what comes back.
  assert.deepEqual(
    hints("/alpha/a/b/c/part.py", "/beta/a/b/c/part.py"),
    ["alpha/a/b/c", "beta/a/b/c"],
  );
});

test("only the tabs that clash pay for a hint", () => {
  assert.deepEqual(
    hints("/p/parts/bracket.py", "/p/fixtures/bracket.py", "/p/parts/hinge.py"),
    ["parts", "fixtures", ""],
  );
});

test("three of a name are each separated from both others", () => {
  assert.deepEqual(
    hints("/p/a/part.py", "/p/b/part.py", "/p/c/part.py"),
    ["a", "b", "c"],
  );
});

test("a clash is by filename, not by folder", () => {
  // Same folder, different names: nothing to disambiguate.
  assert.deepEqual(hints("/p/parts/a.py", "/p/parts/b.py"), ["", ""]);
});

// --- unsaved buffers ---

test("a single unsaved buffer is just Untitled", () => {
  const [tab] = labelsFor([{ key: 1, path: null }]);
  assert.equal(tab.label, "Untitled");
  assert.equal(tab.hint, "");
  assert.equal(tab.title, "Not saved to a file yet");
});

test("several unsaved buffers are numbered, and only then", () => {
  // "Untitled-1" on its own invites the question of where Untitled-2 is.
  assert.deepEqual(
    labelsFor([{ key: 1, path: null }, { key: 2, path: null }]).map((t) => t.label),
    ["Untitled-1", "Untitled-2"],
  );
});

test("unsaved buffers are numbered among themselves, not among all tabs", () => {
  const tabs = labelsFor([
    { key: 1, path: "/p/a.py" },
    { key: 2, path: null },
    { key: 3, path: "/p/b.py" },
    { key: 4, path: null },
  ]);
  assert.deepEqual(tabs.map((t) => t.label), ["a.py", "Untitled-1", "b.py", "Untitled-2"]);
});

// --- shapes that should not throw ---

test("a bare filename has no parent to hint with", () => {
  assert.deepEqual(hints("bracket.py", "parts/bracket.py"), ["", "parts"]);
});

test("Windows paths split on their own separator", () => {
  const tabs = labelsFor(buffers("C:\\cad\\parts\\bracket.py", "C:\\cad\\jigs\\bracket.py"));
  assert.deepEqual(tabs.map((t) => t.label), ["bracket.py", "bracket.py"]);
  assert.deepEqual(tabs.map((t) => t.hint), ["parts", "jigs"]);
});

test("the same path twice is not separable, and says so rather than throwing", () => {
  // Reachable through Save As onto an open file. Nothing can tell the two
  // apart, so both get the same hint - and it is the short one rather than the
  // whole parent path, because lengthening it would not separate them either.
  assert.deepEqual(hints("/p/parts/a.py", "/p/parts/a.py"), ["parts", "parts"]);
});

test("no tabs is no labels", () => {
  assert.deepEqual(labelsFor([]), []);
});

test("keys are carried through untouched", () => {
  const tabs = labelsFor([{ key: 7, path: "/p/a.py" }, { key: 12, path: null }]);
  assert.deepEqual(tabs.map((t) => t.key), [7, 12]);
});
