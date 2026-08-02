// node --test src/clipboard.test.mjs
//
// Only the parts that can be wrong without a window: which surface a command is
// routed to, what counts as a text field, and the range arithmetic that decides
// how much of a value a paste replaces. An off-by-one in the last one eats a
// character on every paste and looks like a clipboard problem rather than a
// slicing problem.
//
// Whether Windows and GNU/Linux actually deliver the click, and whether
// Neutralino's clipboard reads what the system holds, are a real build's
// answers.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { chooseTarget, isTextField, replaceRange } from "./clipboard.js";

// --- routing ---

test("the console wins, because it and the editor both own a textarea", () => {
  assert.equal(
    chooseTarget({ consoleFocused: true, editorFocused: true, fieldFocused: true }),
    "console",
  );
});

test("the editor comes next, and a plain field last", () => {
  assert.equal(
    chooseTarget({ consoleFocused: false, editorFocused: true, fieldFocused: true }),
    "editor",
  );
  assert.equal(
    chooseTarget({ consoleFocused: false, editorFocused: false, fieldFocused: true }),
    "field",
  );
});

test("nothing focused is not an error, it is nothing to do", () => {
  assert.equal(
    chooseTarget({ consoleFocused: false, editorFocused: false, fieldFocused: false }),
    "none",
  );
});

// --- what has a caret in it ---

test("text inputs and textareas carry a caret", () => {
  assert.equal(isTextField({ tagName: "TEXTAREA" }), true);
  for (const type of ["text", "search", "url", "email", "password", "tel", "number"]) {
    assert.equal(isTextField({ tagName: "INPUT", type }), true, type);
  }
});

test("a control that only looks like an input does not", () => {
  // These have a value and no caret. Cutting from a radio button would throw
  // inside setSelectionRange, which is not a failure anyone would connect to
  // having pressed Cmd-X.
  for (const type of ["radio", "checkbox", "button", "submit", "range", "color", "file"]) {
    assert.equal(isTextField({ tagName: "INPUT", type }), false, type);
  }
  assert.equal(isTextField({ tagName: "DIV" }), false);
  assert.equal(isTextField({ tagName: "BUTTON" }), false);
});

test("a contenteditable does", () => {
  assert.equal(isTextField({ tagName: "DIV", isContentEditable: true }), true);
});

test("no element is not a field", () => {
  assert.equal(isTextField(null), false);
  assert.equal(isTextField(undefined), false);
});

// --- the arithmetic ---

test("replaces exactly the selected range", () => {
  assert.equal(replaceRange("hello world", 6, 11, "there"), "hello there");
  assert.equal(replaceRange("hello world", 0, 5, "goodbye"), "goodbye world");
});

test("an empty selection inserts at the caret", () => {
  assert.equal(replaceRange("hello world", 5, 5, ","), "hello, world");
  assert.equal(replaceRange("", 0, 0, "text"), "text");
});

test("cutting is replacing with nothing", () => {
  assert.equal(replaceRange("hello world", 5, 11, ""), "hello");
});

test("a range outside the value is clamped rather than producing undefined", () => {
  // Browsers do report selectionEnd past the value in some states, and
  // "hello undefined" is a much worse outcome than a clamp.
  assert.equal(replaceRange("hello", 0, 99, "x"), "x");
  assert.equal(replaceRange("hello", 99, 99, "!"), "hello!");
  assert.equal(replaceRange("hello", -5, 2, "J"), "Jllo");
});

test("a backwards range inserts rather than deleting what it spans", () => {
  // start > end can arrive from a selection made right-to-left in some engines.
  // It collapses to an insertion at start and nothing is lost - "hellXo", with
  // the trailing character still there, is the whole point.
  assert.equal(replaceRange("hello", 4, 2, "X"), "hellXo");
});
