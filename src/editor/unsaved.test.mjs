// node --test src/editor/unsaved.test.mjs
//
// The wording of the last thing standing between a quit and somebody's
// afternoon. Phase 2 exists partly because work could be lost silently, so what
// this dialog says - and whether its buttons can be read as applying to one
// file when they mean all of them - is worth pinning down.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { unsavedPrompt } from "./unsaved.js";

test("one file is named, and the buttons speak of one file", () => {
  const prompt = unsavedPrompt(["/p/bracket.py"]);
  assert.equal(prompt.detail, "/p/bracket.py has unsaved changes.");
  assert.equal(prompt.save, "Save");
  assert.equal(prompt.discard, "Discard");
});

test("several are counted and listed, and the buttons say All", () => {
  // "Save" beside a list of four reads as saving the one you are looking at.
  const prompt = unsavedPrompt(["/p/a.py", "/p/b.py", "Untitled"]);
  assert.match(prompt.detail, /^3 files have unsaved changes:/);
  for (const name of ["/p/a.py", "/p/b.py", "Untitled"]) {
    assert.ok(prompt.detail.includes(name), name);
  }
  assert.equal(prompt.save, "Save All");
  assert.equal(prompt.discard, "Discard All");
});

test("cancel is always cancel", () => {
  assert.equal(unsavedPrompt(["/p/a.py"]).cancel, "Cancel");
  assert.equal(unsavedPrompt(["/p/a.py", "/p/b.py"]).cancel, "Cancel");
});

test("a long list is summarised rather than run off the screen", () => {
  const names = Array.from({ length: 14 }, (_, index) => `/p/file${index}.py`);
  const prompt = unsavedPrompt(names);

  assert.match(prompt.detail, /^14 files have unsaved changes:/);
  assert.ok(prompt.detail.includes("/p/file9.py"), "the tenth is still named");
  assert.ok(!prompt.detail.includes("/p/file10.py"), "the eleventh is not");
  assert.ok(prompt.detail.includes("…and 4 more"));
});

test("exactly ten are all named, with nothing left to summarise", () => {
  const names = Array.from({ length: 10 }, (_, index) => `/p/file${index}.py`);
  const prompt = unsavedPrompt(names);
  assert.ok(prompt.detail.includes("/p/file9.py"));
  assert.ok(!prompt.detail.includes("more"));
});

test("the count is the first thing said, before any name", () => {
  // Three files is a moment's thought and thirty is a mistake worth
  // cancelling, and that is the part that decides which button to press.
  const prompt = unsavedPrompt(["/p/a.py", "/p/b.py"]);
  assert.ok(prompt.detail.indexOf("2 files") < prompt.detail.indexOf("/p/a.py"));
});

test("the names are on their own lines, so the list reads as a list", () => {
  const prompt = unsavedPrompt(["/p/a.py", "/p/b.py"]);
  const lines = prompt.detail.split("\n").filter((line) => line.includes(".py"));
  assert.equal(lines.length, 2);
});
