// node --test tests/unit/editor/ondisk.test.mjs
//
// The failure this is about is silent by construction: a save that overwrites
// somebody else's edits reports success, because from this application's side
// nothing went wrong. So what is asserted here is not "a change is detected" -
// it is the whole decision table, including every case where the honest answer
// is "no, and do not ask".

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { changedSince, hasTimestamp, stampOf } from "../../../src/editor/ondisk.js";

const stats = (size, modifiedAt) => ({ size, modifiedAt, isFile: true, isDirectory: false });

test("a file that has not been touched has not changed", () => {
  const recorded = stampOf(stats(120, 1000));
  assert.equal(changedSince(recorded, stampOf(stats(120, 1000))), false);
});

test("a rewrite of the same length is still a change", () => {
  // The case a size alone misses: one character replaced by another.
  const recorded = stampOf(stats(120, 1000));
  assert.equal(changedSince(recorded, stampOf(stats(120, 2000))), true);
});

test("a change within the same second is still a change", () => {
  // And the case a timestamp alone misses, on a filesystem whose clock is
  // coarse enough that two edits share one.
  const recorded = stampOf(stats(120, 1000));
  assert.equal(changedSince(recorded, stampOf(stats(140, 1000))), true);
});

test("a buffer that was never loaded from a file cannot have diverged", () => {
  // An untitled buffer, or a Save As to a name that did not exist. Asking about
  // it would be a dialog about a file nobody else has ever seen.
  assert.equal(changedSince(null, stampOf(stats(120, 1000))), false);
});

test("a file that has been deleted is not a conflict", () => {
  // Saving writes it back, which is what Cmd-S over a struck-through tab means.
  // A prompt here could only offer to reload nothing.
  const recorded = stampOf(stats(120, 1000));
  assert.equal(changedSince(recorded, null), false);
});

test("there is no stamp for a file that is not there", () => {
  assert.equal(stampOf(null), null);
  assert.equal(stampOf(undefined), null);
});

test("a stamp keeps only what is compared", () => {
  // Not the whole stat: isFile and createdAt would make two stamps differ for
  // reasons that are not an edit.
  assert.deepEqual(stampOf(stats(120, 1000)), { size: 120, modifiedAt: 1000 });
});

test("a platform with no modification time still catches a length change", () => {
  // If Neutralino reports no usable time somewhere, this must degrade rather
  // than silently answer "unchanged" for ever - which is what comparing two
  // absent values would do.
  const recorded = stampOf({ size: 120 });
  assert.equal(recorded.modifiedAt, null);
  assert.equal(changedSince(recorded, stampOf({ size: 140 })), true);
});

test("and says nothing about a rewrite it cannot see", () => {
  const recorded = stampOf({ size: 120 });
  assert.equal(changedSince(recorded, stampOf({ size: 120 })), false);
});

test("a time of zero is not a time", () => {
  // The shape a platform that does not fill the field in would produce.
  assert.equal(stampOf({ size: 120, modifiedAt: 0 }).modifiedAt, null,
    "zero means the field was not filled in, not the first of January 1970");
  assert.equal(stampOf({ size: 120, modifiedAt: undefined }).modifiedAt, null);
  assert.equal(stampOf({ size: 120, modifiedAt: NaN }).modifiedAt, null);
});

test("whether a stamp can see a rewrite at all is answerable", () => {
  assert.equal(hasTimestamp(stampOf({ size: 1, modifiedAt: 5 })), true);
  assert.equal(hasTimestamp(stampOf({ size: 1 })), false);
  assert.equal(hasTimestamp(null), false);
});
