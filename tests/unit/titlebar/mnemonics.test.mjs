// node --test tests/unit/titlebar/mnemonics.test.mjs
//
// The keyboard half of the in-window menu bar, which is the half people have
// muscle memory for: Alt shows the underlines, Alt-F opens File, the arrows walk
// it, Escape leaves. None of it runs on macOS, where the menu is the system's.
//
// Pure because all of it is characters and indices. What is not here is drawing
// the bar, which needs a window and is covered by tests/frontend.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  afterKey,
  assignMnemonics,
  menuForLetter,
  splitTitle,
} from "../../../src/titlebar/mnemonics.js";

const TITLES = ["File", "Edit", "View", "Run", "Help"];

test("each menu claims the first letter nobody has taken", () => {
  const mnemonics = assignMnemonics(TITLES);

  assert.deepEqual(mnemonics.map((m) => m.letter), ["f", "e", "v", "r", "h"]);
  assert.deepEqual(mnemonics.map((m) => m.at), [0, 0, 0, 0, 0]);
});

test("a word's initial is preferred to the next free character", () => {
  // Windows picks the first letter of a *word* before any letter at all, which
  // is why File takes F, Open File takes O, and Open Folder takes the F of
  // Folder - not the p of Open, which is what nobody's fingers expect.
  const labels = ["New", "Open File…", "Open Folder…", "Save", "Save As…", "Save All"];
  const mnemonics = assignMnemonics(labels);

  assert.deepEqual(
    mnemonics.map((m, i) => `${labels[i].slice(0, m.at)}[${labels[i][m.at]}]`),
    ["[N]", "[O]", "Open [F]", "[S]", "Save [A]", "Sa[v]"],
  );
});

test("and only then any letter that is left", () => {
  // "Save All" has no free initial - S and A are gone - so it falls through to
  // its own letters in order.
  const [, , third] = assignMnemonics(["Save", "As", "Save All"]);
  assert.equal(third.letter, "v");
});

test("punctuation and spaces claim nothing", () => {
  const [ellipsis] = assignMnemonics(["… Open"]);
  assert.equal(ellipsis.letter, "o");
});

test("a clash takes the next word along, and the first menu keeps its own", () => {
  // First-come-first-served is what makes the assignment stable: a menu added
  // later must not take a letter from one that was already there, because that
  // silently retrains everybody's fingers.
  const mnemonics = assignMnemonics(["File", "Format", "Find"]);

  assert.deepEqual(mnemonics.map((m) => m.letter), ["f", "o", "i"]);
});

test("a menu with no letter left has none, rather than an invented one", () => {
  const mnemonics = assignMnemonics(["Aa", "Aa"]);

  assert.equal(mnemonics[1].letter, null);
  assert.equal(mnemonics[1].at, -1);
});

test("a letter finds its menu, whatever case it arrives in", () => {
  const mnemonics = assignMnemonics(TITLES);

  assert.equal(menuForLetter(mnemonics, "f"), 0);
  assert.equal(menuForLetter(mnemonics, "F"), 0);
  assert.equal(menuForLetter(mnemonics, "h"), 4);
  assert.equal(menuForLetter(mnemonics, "z"), -1);
});

test("a title splits around its letter, in three pieces", () => {
  // Three pieces rather than marked-up text, so nothing here has to know about
  // HTML or about escaping.
  const [file, , , , ] = assignMnemonics(TITLES);
  assert.deepEqual(splitTitle("File", file), { before: "", letter: "F", after: "ile" });

  const [, format] = assignMnemonics(["File", "Format"]);
  assert.deepEqual(splitTitle("Format", format), { before: "F", letter: "o", after: "rmat" });

  assert.deepEqual(splitTitle("File", null), { before: "File", letter: "", after: "" });
});

// --- what a key does -------------------------------------------------------

const MNEMONICS = assignMnemonics(TITLES);
const ITEMS = assignMnemonics(["New", "Open File…", "Open Folder…"]);
const SHAPE = { menus: TITLES.length, counts: [4, 3, 2, 5, 2], mnemonics: MNEMONICS, items: ITEMS };
const open = (index, highlighted = -1) =>
  ({ open: index, highlighted, showUnderlines: true });
const listening = { open: -1, highlighted: -1, showUnderlines: true };
const shut = { open: -1, highlighted: -1, showUnderlines: false };

test("with nothing open and nothing showing, the keys belong to the editor", () => {
  // The bar must not eat an arrow key somebody is using to move the caret.
  for (const key of ["ArrowDown", "ArrowLeft", "f", "Enter", "Escape"]) {
    assert.equal(afterKey(shut, key, SHAPE), null, key);
  }
});

test("Alt then a letter opens that menu, as two keystrokes", () => {
  // Alt has been pressed and released, so the bar is listening and the
  // underlines are showing. Without this the letter they invite does nothing.
  assert.equal(afterKey(listening, "f", SHAPE).open, 0);
  assert.equal(afterKey(listening, "h", SHAPE).open, 4);
  assert.equal(afterKey(listening, "z", SHAPE), null);
});

test("and Escape stops it listening", () => {
  assert.deepEqual(afterKey(listening, "Escape", SHAPE), { ...shut, choose: -1 });
});

test("Escape closes what is open", () => {
  assert.deepEqual(afterKey(open(1), "Escape", SHAPE), { ...shut, choose: -1 });
});

test("left and right walk the bar, and wrap", () => {
  assert.equal(afterKey(open(0), "ArrowRight", SHAPE).open, 1);
  assert.equal(afterKey(open(4), "ArrowRight", SHAPE).open, 0);
  assert.equal(afterKey(open(0), "ArrowLeft", SHAPE).open, 4);
});

test("moving to another menu highlights nothing in it yet", () => {
  assert.equal(afterKey(open(0, 2), "ArrowRight", SHAPE).highlighted, -1);
});

test("down takes the first item and up the last", () => {
  assert.equal(afterKey(open(1), "ArrowDown", SHAPE).highlighted, 0);
  assert.equal(afterKey(open(1), "ArrowUp", SHAPE).highlighted, 2);
});

test("and they wrap within the menu", () => {
  assert.equal(afterKey(open(1, 2), "ArrowDown", SHAPE).highlighted, 0);
  assert.equal(afterKey(open(1, 0), "ArrowUp", SHAPE).highlighted, 2);
});

test("a menu with nothing selectable in it does not move", () => {
  const shape = { ...SHAPE, counts: [0, 3, 2, 5, 2] };
  assert.equal(afterKey(open(0), "ArrowDown", shape), null);
});

test("an item's own letter runs it, and closes the menu", () => {
  // The half that makes the underlines worth drawing: in an open File menu, F
  // is Open Folder rather than a second trip to the File menu.
  const answer = afterKey(open(0), "f", SHAPE);

  assert.equal(answer.choose, 2, "Open Folder was not the one chosen");
  assert.equal(answer.open, -1, "the menu stayed open");
});

test("and it wins over a menu that claims the same letter", () => {
  // Both File and Open Folder answer to F. What is in front of the user wins.
  assert.equal(afterKey(open(0), "f", SHAPE).choose, 2);
  // With no item claiming it, the letter moves to that menu instead.
  assert.equal(afterKey(open(0), "e", SHAPE).open, 1);
  assert.equal(afterKey(open(0), "e", SHAPE).choose, -1);
});

test("a letter nobody claims changes nothing", () => {
  assert.equal(afterKey(open(0), "z", SHAPE), null);
});
