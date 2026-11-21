// node --test tests/unit/geometry.test.mjs
//
// Where the window opens. A stored size must be a usable number, because
// settings.json is editable; a stored position comes back as it was saved,
// because no display information says where a screen sits.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { geometryToStore, usableGeometry } from "../../src/geometry.js";

// --- coming back ---

test("a remembered size and position is used", () => {
  assert.deepEqual(
    usableGeometry({ width: 1400, height: 900, x: 100, y: 60 }),
    { width: 1400, height: 900, x: 100, y: 60 },
  );
});

test("nothing remembered means nothing to apply", () => {
  assert.equal(usableGeometry(null), null);
  assert.equal(usableGeometry(undefined), null);
  assert.equal(usableGeometry({}), null);
});

test("a size that is not a number is refused, because settings.json is editable", () => {
  assert.equal(usableGeometry({ width: "1600", height: 1000 }), null);
  assert.equal(usableGeometry({ width: 0, height: 1000 }), null);
  assert.equal(usableGeometry({ width: Number.NaN, height: 1000 }), null);
});

test("a size below the window's minimum comes back at the minimum", () => {
  assert.deepEqual(
    usableGeometry({ width: 100, height: 50 }),
    { width: 800, height: 600 },
  );
});

test("a position comes back wherever it was, a second screen and negative ones included", () => {
  // A second monitor to the right, or above or left of the main one, gives
  // coordinates far from the origin or below zero. Nothing can tell those
  // apart from a screen that is gone, so none of them is dropped.
  for (const [x, y] of [[2400, 200], [-1900, 0], [100, -1100], [5000, 3000]]) {
    assert.deepEqual(
      usableGeometry({ width: 1400, height: 900, x, y }),
      { width: 1400, height: 900, x, y },
    );
  }
});

test("a position that is not a number is dropped, and the size is kept", () => {
  assert.deepEqual(
    usableGeometry({ width: 1400, height: 900, x: "100", y: 60 }),
    { width: 1400, height: 900 },
  );
  assert.deepEqual(
    usableGeometry({ width: 1400, height: 900, x: Number.NaN, y: 60 }),
    { width: 1400, height: 900 },
  );
});

// --- going away ---

test("what the window reports is what gets written down", () => {
  assert.deepEqual(
    geometryToStore({ size: { width: 1400.4, height: 900.6 }, position: { x: 10.2, y: 20.8 } }),
    { width: 1400, height: 901, x: 10, y: 21 },
  );
});

test("a failed query saves nothing rather than saving rubbish", () => {
  // Overwriting a good remembered geometry because getSize threw is worse than
  // not saving at all.
  assert.equal(geometryToStore({ size: null, position: { x: 1, y: 2 } }), null);
  assert.equal(geometryToStore({ size: { width: 0, height: 0 } }), null);
});

test("a failed position query still saves the size", () => {
  assert.deepEqual(
    geometryToStore({ size: { width: 1400, height: 900 }, position: null }),
    { width: 1400, height: 900 },
  );
});

test("a maximised window records that, and the size to return to", () => {
  assert.deepEqual(
    geometryToStore({ size: { width: 1400, height: 900 }, position: { x: 0, y: 0 },
                      maximized: true }),
    { width: 1400, height: 900, x: 0, y: 0, maximized: true },
  );
});
