// node --test tests/unit/vars/tree.test.mjs
//
// Paths, pages and column widths. All three are arithmetic that fails quietly:
// a path that compares wrong closes the innocent row, an off-by-one in a page
// makes one element permanently unreachable, and a width that escapes its
// clamp leaves a column with no handle to drag it back by.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { columnWidths, isUnder, pageInfo, pathKey, resized, samePath } from "../../../src/vars/tree.js";

// --- paths ---

test("a path is the same row whichever array holds it", () => {
  assert.equal(samePath(["a", 3, 0], ["a", 3, 0]), true);
  assert.equal(samePath(["a", 3], ["a", 3, 0]), false);
  assert.equal(samePath(["a", 3, 0], ["a", 0, 3]), false);
});

test("names that would collide under a separator do not", () => {
  // A variable name can hold anything a Python identifier can, and a key can
  // hold anything at all - so "a.b" and ["a", "b"] must not be one row.
  assert.notEqual(pathKey(["a.b"]), pathKey(["a", "b"]));
  assert.notEqual(pathKey(["a"]), pathKey(["a", 0]));
});

test("a descendant is under its ancestor, and a sibling is not", () => {
  assert.equal(isUnder(["a", 3, 0], ["a", 3]), true);
  assert.equal(isUnder(["a", 3], ["a"]), true);
  assert.equal(isUnder(["a", 4], ["a", 3]), false);
  assert.equal(isUnder(["b", 3], ["a"]), false);
});

test("a row is not under itself, so closing one keeps its own state", () => {
  assert.equal(isUnder(["a", 3], ["a", 3]), false);
});

test("a longer name is not a descendant of a shorter one", () => {
  // "ab" starts with "a" as text and is a different variable entirely.
  assert.equal(isUnder(["ab", 0], ["a"]), false);
});

// --- paging ---

test("a list that fits has no pager", () => {
  assert.equal(pageInfo({ offset: 0, total: 3, page: 100, count: 3 }), null);
  assert.equal(pageInfo({ count: 0 }), null);
});

test("the first page of many offers only forwards", () => {
  const pager = pageInfo({ offset: 0, total: 5000, page: 100, count: 100 });
  assert.equal(pager.label, "1–100 of 5000");
  assert.equal(pager.hasPrev, false);
  assert.equal(pager.hasNext, true);
  assert.equal(pager.nextOffset, 100);
});

test("a middle page offers both, and steps by the page the kernel used", () => {
  const pager = pageInfo({ offset: 100, total: 5000, page: 100, count: 100 });
  assert.equal(pager.label, "101–200 of 5000");
  assert.equal(pager.hasPrev, true);
  assert.equal(pager.hasNext, true);
  assert.equal(pager.prevOffset, 0);
  assert.equal(pager.nextOffset, 200);
});

test("the last page is short and says so, and does not offer a next", () => {
  // The case that decides why the step comes from the kernel: forwards is the
  // number of children in hand, backwards is the page size, and on a short last
  // page those differ. Deriving both from the children would skip 43 rows.
  const pager = pageInfo({ offset: 5000, total: 5043, page: 100, count: 43 });
  assert.equal(pager.label, "5001–5043 of 5043");
  assert.equal(pager.hasNext, false);
  assert.equal(pager.prevOffset, 4900);
});

test("paging back from the second page lands on the first, not before it", () => {
  assert.equal(pageInfo({ offset: 50, total: 500, page: 100, count: 100 }).prevOffset, 0);
});

// --- column widths ---

test("nothing stored is the defaults", () => {
  assert.deepEqual(columnWidths(null), { name: 30, type: 26 });
  assert.deepEqual(columnWidths(undefined), { name: 30, type: 26 });
  assert.deepEqual(columnWidths({}), { name: 30, type: 26 });
});

test("stored widths are used", () => {
  assert.deepEqual(columnWidths({ name: 45, type: 15 }), { name: 45, type: 15 });
});

test("settings.json is a file a user can edit, so nonsense is not trusted", () => {
  // A NaN reaches the table as "NaN%" and lays the whole thing out wrongly,
  // with nothing on screen to say why.
  assert.deepEqual(columnWidths({ name: "wide", type: null }), { name: 30, type: 26 });
  assert.deepEqual(columnWidths({ name: Number.NaN, type: 20 }).name, 30);
});

test("a column cannot be stored so narrow that it cannot be grabbed again", () => {
  assert.equal(columnWidths({ name: 0, type: 26 }).name, 8);
  assert.equal(columnWidths({ name: -50, type: 26 }).name, 8);
});

test("widths that would leave nothing for the value column fall back", () => {
  assert.deepEqual(columnWidths({ name: 60, type: 40 }), { name: 30, type: 26 });
});

// --- dragging ---

test("dragging the first boundary moves the name column to the pointer", () => {
  assert.deepEqual(resized("name", { name: 30, type: 26 }, 0.45), { name: 45, type: 26 });
});

test("dragging the second boundary sets the type column's width, not its edge", () => {
  // The pointer is at 60% of the table and the name column takes 30, so the
  // type column is the 30 in between - not 60.
  assert.deepEqual(resized("type", { name: 30, type: 26 }, 0.6), { name: 30, type: 30 });
});

test("neither drag can squeeze a column away", () => {
  assert.equal(resized("name", { name: 30, type: 26 }, 0).name, 8);
  assert.equal(resized("type", { name: 30, type: 26 }, 0).type, 8);
  // Nor the columns after it: dragging the first boundary to the far right
  // must leave room for both of the others.
  const far = resized("name", { name: 30, type: 26 }, 1);
  assert.ok(far.name + far.type <= 92, `${far.name} + ${far.type}`);
  assert.ok(resized("type", { name: 30, type: 26 }, 1).type <= 62);
});
