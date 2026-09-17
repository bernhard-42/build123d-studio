// node --test tests/unit/vars/filter.test.mjs
//
// Proof, at writing: with the label clause removed from matchesFilter, "a
// label matches too" fails; with trim() removed, "spaces around the query do
// not count" fails.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { filterRows, matchesFilter } from "../../../src/vars/filter.js";

const ROWS = [
  { name: "plate", label: "" },
  { name: "plate_holes", label: "" },
  { name: "b", label: "Box top" },
  { name: "count", label: "" },
];

test("an empty query keeps every row, in order", () => {
  assert.deepEqual(filterRows(ROWS, "").map((r) => r.name), ["plate", "plate_holes", "b", "count"]);
});

test("a query matches anywhere in the name, case-insensitively", () => {
  assert.deepEqual(filterRows(ROWS, "PL").map((r) => r.name), ["plate", "plate_holes"]);
  assert.deepEqual(filterRows(ROWS, "hole").map((r) => r.name), ["plate_holes"]);
  assert.deepEqual(filterRows(ROWS, "nt").map((r) => r.name), ["count"]);
});

test("a label matches too", () => {
  // The label is how a shape says which one it is; a search for "top" should
  // find the box labelled top.
  assert.deepEqual(filterRows(ROWS, "top").map((r) => r.name), ["b"]);
});

test("spaces around the query do not count", () => {
  assert.equal(matchesFilter({ name: "plate" }, "  plate "), true);
  assert.equal(matchesFilter({ name: "plate" }, "   "), true);
});

test("a row without a label is fine", () => {
  assert.equal(matchesFilter({ name: "x" }, "top"), false);
});
