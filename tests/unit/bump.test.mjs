// node --test tests/unit/bump.test.mjs
//
// Which version comes next. Small, and worth testing anyway: the answer is
// written into two files that must agree, and getting it wrong ships a package
// whose About dialog and whose binary metadata disagree about what it is.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { nextVersion } from "../../scripts/bump.mjs";

test("each part moves its own place", () => {
  assert.equal(nextVersion("0.4.1", "patch"), "0.4.2");
  assert.equal(nextVersion("0.4.1", "minor"), "0.5.0");
  assert.equal(nextVersion("0.4.1", "major"), "1.0.0");
});

test("and everything to its right goes back to zero", () => {
  // The half that a hand-written bump gets wrong: 0.4.9 -> 0.5.0, not 0.5.9.
  assert.equal(nextVersion("0.4.9", "minor"), "0.5.0");
  assert.equal(nextVersion("2.7.3", "major"), "3.0.0");
});

test("an unknown part is refused rather than guessed at", () => {
  assert.equal(nextVersion("0.4.1", "revision"), null);
  assert.equal(nextVersion("0.4.1", ""), null);
});
