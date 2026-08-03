// node --test src/backdrop.test.mjs
//
// Which press-and-release pairs dismiss a dialog. The case that matters is the
// one that was reported: selecting the text in the New File template field by
// dragging, and letting go past the edge of the panel, closed the settings
// dialog. Whether the browser delivers the events in this order is the
// platform's business and is specified; what is decided here is what to do with
// them.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { dismisses } from "./backdrop.js";

test("a plain click on the backdrop dismisses", () => {
  assert.equal(dismisses({ pressedOnBackdrop: true, releasedOnBackdrop: true }), true);
});

test("dragging out of a field and releasing on the backdrop does not", () => {
  // The reported bug. The click event's own target is the overlay here, which
  // is exactly why it cannot be the thing that is asked.
  assert.equal(dismisses({ pressedOnBackdrop: false, releasedOnBackdrop: true }), false);
});

test("pressing on the backdrop and releasing inside the panel does not", () => {
  assert.equal(dismisses({ pressedOnBackdrop: true, releasedOnBackdrop: false }), false);
});

test("a click wholly inside the panel does not", () => {
  assert.equal(dismisses({ pressedOnBackdrop: false, releasedOnBackdrop: false }), false);
});

test("a release that never reached the overlay does not dismiss", () => {
  // mouseup outside the window leaves the flag at the false mousedown set it
  // to, rather than at whatever the last interaction happened to leave behind.
  assert.equal(dismisses({ pressedOnBackdrop: true, releasedOnBackdrop: undefined }), false);
});
