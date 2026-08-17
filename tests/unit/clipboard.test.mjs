// node --test tests/unit/clipboard.test.mjs
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

import { chooseTarget, contextMenuItems, isTextField, replaceRange } from "../../src/clipboard.js";

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

// --- what a pane's right-click menu offers ---

test("the console offers Copy and Paste, because a terminal takes typing", () => {
  assert.deepEqual(contextMenuItems({ pane: "console", hasSelection: true, platform: "Darwin" }), [
    { id: "copy", label: "Copy", shortcut: "\u2318C", enabled: true },
    { id: "paste", label: "Paste", shortcut: "\u2318V", enabled: true },
  ]);
});

test("the variable explorer offers Copy alone, being read-only", () => {
  assert.deepEqual(contextMenuItems({ pane: "variables", hasSelection: true, platform: "Darwin" }), [
    { id: "copy", label: "Copy", shortcut: "\u2318C", enabled: true },
  ]);
});

test("the chord is written the way each platform writes it", () => {
  const mac = contextMenuItems({ pane: "console", hasSelection: true, platform: "Darwin" });
  assert.equal(mac[0].shortcut, "\u2318C");
  assert.equal(mac[1].shortcut, "\u2318V");

  for (const platform of ["Windows", "Linux"]) {
    const items = contextMenuItems({ pane: "console", hasSelection: true, platform });
    assert.equal(items[0].shortcut, "Ctrl+C", platform);
    assert.equal(items[1].shortcut, "Ctrl+V", platform);
  }
});

test("Copy is disabled rather than absent when nothing is selected", () => {
  // Absent would make the console menu one row high and then two, which reads
  // as a different menu rather than the same one with less to offer.
  const items = contextMenuItems({ pane: "console", hasSelection: false });
  assert.equal(items.length, 2);
  assert.equal(items[0].enabled, false);
  assert.equal(items[1].enabled, true, "there is always something to paste into a terminal");
});

test("Paste is never offered where it could not go anywhere", () => {
  const items = contextMenuItems({ pane: "variables", hasSelection: false });
  assert.equal(items.some((item) => item.id === "paste"), false);
});

test("a pane with no menu of its own gets no menu at all", () => {
  // The editor, which has Monaco's, and anything not named here - so a new pane
  // shows nothing rather than a stray Copy that does not work.
  assert.deepEqual(contextMenuItems({ pane: "editor", hasSelection: true }), []);
  assert.deepEqual(contextMenuItems({ pane: "viewer", hasSelection: true }), []);
});
