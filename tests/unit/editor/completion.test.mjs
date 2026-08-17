// node --test tests/unit/editor/completion.test.mjs
//
// Turning the sidecar's merged answer into a Monaco suggestion list.
//
// The entries below are recorded from the real thing against the pinned
// environment - ipykernel 7.3.0 and jedi 0.20.0 - with a namespace holding
// `from build123d import *` and `part = Box(1,2,3)`. Invented fixtures would
// agree with whatever this file assumed; these are what actually comes back,
// including the parts that are easy to get wrong: the kernel returns an
// attribute with its dot on, ".center" for "part.ce", because the span it
// replaces starts at the dot.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { completionItems, completionQuery, isIncomplete } from "../../../src/editor/completion.js";

// Stands in for monaco.languages.CompletionItemKind. The values are arbitrary;
// only which name each item is given matters here.
const KINDS = {
  Function: "kind:Function",
  Method: "kind:Method",
  Class: "kind:Class",
  Module: "kind:Module",
  Keyword: "kind:Keyword",
  Variable: "kind:Variable",
  File: "kind:File",
  Property: "kind:Property",
};

const reply = (entries, truncated = false) => ({
  matches: entries.map((entry) => entry.text),
  types: entries,
  truncated,
});

// "time.sl" from the kernel: the span is "sl", not "time.sl".
const DOTTED = reply([
  { text: "sleep", type: "function", signature: "(object, /)", start: 5, end: 7 },
]);

// "part.ce" from the kernel, with a build123d object in the namespace. The
// match carries the dot and the span starts at it.
const ATTRIBUTE = reply([
  { text: ".center", type: "function", signature: "", start: 4, end: 7 },
]);

// "b = Bo" - what jedi answers on a file that has never been run, which is the
// case the kernel cannot serve at all.
const STATIC = reply([
  { text: "BoundBox", type: "class", signature: "", start: 4, end: 6 },
  { text: "Box", type: "class", signature: "", start: 4, end: 6 },
]);

// "pa": a name, a keyword and two magics, all from the kernel.
const MIXED = reply([
  { text: "part", type: "instance", signature: "", start: 0, end: 2 },
  { text: "pass", type: "keyword", signature: "", start: 0, end: 2 },
  { text: "%page", type: "magic", signature: "", start: 0, end: 2 },
  { text: "%pastebin", type: "magic", signature: "", start: 0, end: 2 },
]);

const at = (lineNumber, column, wordStartColumn = column) => ({
  lineNumber,
  column,
  wordStartColumn,
});

// --- what gets asked ---

test("the whole buffer is sent, with a zero-based column", () => {
  const source = "import time\ntime.sl";
  assert.deepEqual(completionQuery(source, { lineNumber: 2, column: 8 }, "/tmp/a.py", "b1"), {
    source,
    line: 2,
    column: 7,
    path: "/tmp/a.py",
    key: "b1",
  });
});

test("an unsaved buffer has no path rather than an empty one", () => {
  assert.equal(completionQuery("x", { lineNumber: 1, column: 1 }, null).path, null);
  assert.equal(completionQuery("x", { lineNumber: 1, column: 1 }, undefined).path, null);
});

test("the buffer key travels, because the path does not identify a buffer", () => {
  // File > New twice gives two buffers with no path at all. Without the key
  // they are one document to the language server, and each one's squiggles are
  // published against the other.
  const first = completionQuery("x", { lineNumber: 1, column: 1 }, null, "buffer-1");
  const second = completionQuery("y", { lineNumber: 1, column: 1 }, null, "buffer-2");
  assert.equal(first.path, second.path);
  assert.notEqual(first.key, second.key);
  assert.equal(completionQuery("x", { lineNumber: 1, column: 1 }, null).key, null);
});

test("the column never goes negative", () => {
  assert.equal(completionQuery("", { lineNumber: 1, column: 0 }).column, 0);
});

// --- the replaced span ---

test("only the part after the dot is replaced", () => {
  // The bug this prevents: replacing "time.sl" with "sleep" and leaving the
  // user with "sleep" where they meant "time.sleep".
  const [item] = completionItems(DOTTED, at(3, 8), KINDS);
  assert.equal(item.insertText, "sleep");
  assert.deepEqual(item.range, {
    startLineNumber: 3,
    endLineNumber: 3,
    startColumn: 6,
    endColumn: 8,
  });
});

test("an attribute replaces its own dot, and is not shown wearing it", () => {
  // ".center" over "part.ce" gives "part.center". Inserting "center" over
  // "part.ce" would give "part.cecenter" - and showing ".center" in the list
  // reads as noise, so the label loses the dot and filterText keeps it,
  // because what Monaco filters against is the text in the range: ".ce".
  const [item] = completionItems(ATTRIBUTE, at(1, 8), KINDS);
  assert.equal(item.label, "center");
  assert.equal(item.filterText, ".center");
  assert.equal(item.insertText, ".center");
  assert.equal(item.range.startColumn, 5);
  assert.equal(item.range.endColumn, 8);
});

test("the range covers the word when the cursor sits inside one", () => {
  const items = completionItems(MIXED, at(2, 3), KINDS);
  assert.equal(items[0].range.startColumn, 1);
  assert.equal(items[0].range.endColumn, 3);
});

test("an entry with no span falls back to the word Monaco has", () => {
  // Nothing this sidecar sends gets here - every entry leaves it with integers
  // - so this is the branch that must not corrupt the line if one ever does.
  const noSpan = reply([{ text: "Box", type: "class", signature: "" }]);
  const [item] = completionItems(noSpan, at(1, 7, 5), KINDS);
  assert.equal(item.range.startColumn, 5);
  assert.equal(item.range.endColumn, 7);
});

// --- icons and detail ---

test("each match gets the kind its type maps to", () => {
  const items = completionItems(MIXED, at(1, 3), KINDS);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["kind:Variable", "kind:Keyword", "kind:Function", "kind:Function"],
  );
});

test("jedi's classes and the kernel's functions both find an icon", () => {
  const statik = completionItems(STATIC, at(1, 7), KINDS);
  assert.deepEqual(statik.map((item) => item.kind), ["kind:Class", "kind:Class"]);
  assert.equal(completionItems(DOTTED, at(1, 8), KINDS)[0].kind, "kind:Function");
});

test("a signature becomes the item's detail, and an empty one is left off", () => {
  assert.equal(completionItems(DOTTED, at(1, 8), KINDS)[0].detail, "(object, /)");
  assert.equal(completionItems(MIXED, at(1, 3), KINDS)[0].detail, undefined);
});

test("a reply with no type list at all still produces a usable list", () => {
  const items = completionItems({ matches: ["Box"], types: null }, at(1, 7, 5), KINDS);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "Box");
  assert.equal(items[0].kind, "kind:Variable");
});

test("a type list that does not line up with the matches is not trusted", () => {
  // Paired by index alone, "sleep" would be given the other entry's span - and
  // a wrong span is worse than a wrong icon, because it decides what the
  // accepted completion overwrites.
  const shuffled = {
    matches: ["sleep", "sleep_ms"],
    types: [
      { text: "sleep_ms", type: "function", signature: "()", start: 0, end: 1 },
      { text: "sleep", type: "function", signature: "(object, /)", start: 5, end: 7 },
    ],
  };
  const items = completionItems(shuffled, at(1, 8, 6), KINDS);
  assert.equal(items[0].detail, undefined, "sleep took the other entry's signature");
  assert.equal(items[0].range.startColumn, 6, "sleep took the other entry's span");
});

// --- ordering ---

test("the sidecar's order is preserved and sorts ahead of word-based suggestions", () => {
  // Monaco sorts by sortText where there is one and by label where there is
  // not, so any padded number beats every word in the buffer. The order itself
  // is the sidecar's: live names before inferred ones.
  const items = completionItems(MIXED, at(1, 3), KINDS);
  assert.deepEqual(
    items.map((item) => item.sortText),
    ["0000", "0001", "0002", "0003"],
  );
  assert.ok(items[0].sortText < "append");
});

// --- nothing to suggest ---

test("no reply is an empty list rather than a failure", () => {
  for (const value of [null, undefined, {}, { matches: null }]) {
    assert.deepEqual(completionItems(value, at(1, 1), KINDS), []);
  }
});

test("a truncated list is marked incomplete so Monaco asks again", () => {
  assert.equal(isIncomplete({ matches: [], truncated: true }), true);
  assert.equal(isIncomplete(DOTTED), false);
  assert.equal(isIncomplete(null), false);
});
