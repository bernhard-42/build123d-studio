// node --test tests/unit/vars/sort.test.mjs
//
// Proof, at writing: with the lowercasing removed from sortRows, "sorting is
// case-insensitive" fails; with nextOrder always answering ascending, "a third
// click returns to the kernel's order" fails.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { nextOrder, sortRows } from "../../../src/vars/sort.js";

const ROWS = [
  { name: "plate", type: "Part" },
  { name: "Box1", type: "Box" },
  { name: "count", type: "int" },
  { name: "axis", type: "Vector" },
];

test("no order is the kernel's order, untouched", () => {
  assert.equal(sortRows(ROWS, null), ROWS);
});

test("by name, ascending and descending", () => {
  assert.deepEqual(
    sortRows(ROWS, { column: "name", direction: "asc" }).map((r) => r.name),
    ["axis", "Box1", "count", "plate"],
  );
  assert.deepEqual(
    sortRows(ROWS, { column: "name", direction: "desc" }).map((r) => r.name),
    ["plate", "count", "Box1", "axis"],
  );
});

test("by type, and ties keep the kernel's order", () => {
  const rows = [...ROWS, { name: "lid", type: "Part" }];
  assert.deepEqual(
    sortRows(rows, { column: "type", direction: "asc" }).map((r) => r.name),
    ["Box1", "count", "plate", "lid", "axis"],
  );
});

test("sorting is case-insensitive", () => {
  const rows = [{ name: "b" }, { name: "A" }, { name: "C" }];
  assert.deepEqual(sortRows(rows, { column: "name", direction: "asc" }).map((r) => r.name), ["A", "b", "C"]);
});

test("a click cycles ascending, descending, then back to the kernel's order", () => {
  const first = nextOrder(null, "name");
  assert.deepEqual(first, { column: "name", direction: "asc" });
  const second = nextOrder(first, "name");
  assert.deepEqual(second, { column: "name", direction: "desc" });
  assert.equal(nextOrder(second, "name"), null);
});

test("a click on the other column starts that column ascending", () => {
  assert.deepEqual(nextOrder({ column: "name", direction: "desc" }, "type"), { column: "type", direction: "asc" });
});
