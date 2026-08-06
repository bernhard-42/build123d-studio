// node --test src/geometry.test.mjs
//
// Where the window opens. Every case here is a way of losing the window
// entirely, which is the failure that has no keyboard shortcut: restore a
// position on a monitor that is no longer attached and there is nothing on
// screen to drag back.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { geometryToStore, usableGeometry } from "./geometry.js";

const LAPTOP = { x: 0, y: 0, width: 1920, height: 1200 };
const SECOND = { x: 1920, y: 0, width: 2560, height: 1440 };

// --- coming back ---

test("a remembered size and position on an attached screen is used", () => {
  assert.deepEqual(
    usableGeometry({ width: 1400, height: 900, x: 100, y: 60 }, [LAPTOP]),
    { width: 1400, height: 900, x: 100, y: 60 },
  );
});

test("nothing remembered means nothing to apply", () => {
  assert.equal(usableGeometry(null, [LAPTOP]), null);
  assert.equal(usableGeometry(undefined, [LAPTOP]), null);
  assert.equal(usableGeometry({}, [LAPTOP]), null);
});

test("a size that is not a number is refused, because settings.json is editable", () => {
  assert.equal(usableGeometry({ width: "1600", height: 1000 }, [LAPTOP]), null);
  assert.equal(usableGeometry({ width: 0, height: 1000 }, [LAPTOP]), null);
  assert.equal(usableGeometry({ width: Number.NaN, height: 1000 }, [LAPTOP]), null);
});

test("a size below the window's minimum comes back at the minimum", () => {
  assert.deepEqual(
    usableGeometry({ width: 100, height: 50 }, [LAPTOP]),
    { width: 800, height: 600 },
  );
});

test("a position on a screen that is gone is dropped, and the size is kept", () => {
  // The undocked laptop. Restoring x=2400 faithfully opens the window on a
  // monitor that is not there; dropping only the position gives back the size
  // the user chose and lets the window manager place it.
  const stored = { width: 1400, height: 900, x: 2400, y: 200 };
  assert.deepEqual(usableGeometry(stored, [LAPTOP]), { width: 1400, height: 900 });
  assert.deepEqual(usableGeometry(stored, [LAPTOP, SECOND]), stored);
});

test("a position far off the top or left is dropped too", () => {
  assert.deepEqual(
    usableGeometry({ width: 1400, height: 900, x: -5000, y: 0 }, [LAPTOP]),
    { width: 1400, height: 900 },
  );
});

test("a window hanging slightly off an edge is still reachable", () => {
  // Legitimate and common: only the title bar has to be grabbable.
  assert.deepEqual(
    usableGeometry({ width: 1400, height: 900, x: 1700, y: 1000 }, [LAPTOP]),
    { width: 1400, height: 900, x: 1700, y: 1000 },
  );
});

test("no display information keeps the position rather than throwing it away", () => {
  // getDisplays failing must not cost the user their window position.
  const stored = { width: 1400, height: 900, x: 100, y: 60 };
  assert.deepEqual(usableGeometry(stored, []), stored);
  assert.deepEqual(usableGeometry(stored, null), stored);
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
