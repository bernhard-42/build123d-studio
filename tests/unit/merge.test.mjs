// node --test tests/unit/merge.test.mjs
//
// The defect these exist for: store.js wrote its whole in-memory copy, which is
// a snapshot taken when the instance started. A second instance therefore
// reverted the first one's settings on every write it made - not occasionally,
// and not under any particular timing.
//
// The first test below is the one that matters, and it fails against the old
// implementation for the right reason: `{ ...values }` alone answers with a
// theme of "light", because that is what was on disk when this instance read it.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mergeSetting } from "../../src/merge.js";

test("a key another instance changed survives this instance's write", () => {
  // This instance started when the theme was light and has never touched it.
  const values = { theme: "light", splitters: { top: 0.5 } };
  // Meanwhile the other window switched to dark.
  const onDisk = JSON.stringify({ theme: "dark", splitters: { top: 0.5 } });

  const merged = mergeSetting(onDisk, { ...values, splitters: { top: 0.7 } }, "splitters");

  assert.equal(merged.theme, "dark", "the other instance's theme must not be reverted");
  assert.deepEqual(merged.splitters, { top: 0.7 }, "this write still lands");
});

test("the key being written wins over what the file says about it", () => {
  const merged = mergeSetting(JSON.stringify({ theme: "dark" }), { theme: "light" }, "theme");
  assert.equal(merged.theme, "light");
});

test("keys on disk that this instance has never heard of are kept", () => {
  // An older or newer build wrote something this one does not know about.
  const onDisk = JSON.stringify({ unknownFutureKey: 42 });
  const merged = mergeSetting(onDisk, { theme: "dark" }, "theme");
  assert.equal(merged.unknownFutureKey, 42);
  assert.equal(merged.theme, "dark");
});

test("no file yet: the in-memory copy is what gets written", () => {
  const merged = mergeSetting(null, { theme: "dark", sampleShown: true }, "theme");
  assert.deepEqual(merged, { theme: "dark", sampleShown: true });
});

test("a damaged file does not reset the settings this session knows about", () => {
  // settings.json is a file a user can open and edit, so this is reachable.
  for (const damaged of ["", "{", "not json at all", "[1,2,3]", "null", '"a string"', "7"]) {
    const merged = mergeSetting(damaged, { theme: "dark", sampleShown: true }, "theme");
    assert.deepEqual(
      merged,
      { theme: "dark", sampleShown: true },
      `${JSON.stringify(damaged)} must not become an empty settings file`,
    );
  }
});

test("a value of false or 0 is written, not skipped", () => {
  // The kind of thing a truthiness test would drop: both are legitimate stored
  // values - "step into my code only", off; a splitter dragged to the edge.
  assert.equal(mergeSetting("{}", { justMyCode: false }, "justMyCode").justMyCode, false);
  assert.equal(mergeSetting("{}", { fraction: 0 }, "fraction").fraction, 0);
});

test("the caller's objects are not mutated", () => {
  const values = { theme: "dark" };
  const onDiskObject = { theme: "light", other: 1 };
  mergeSetting(JSON.stringify(onDiskObject), values, "theme");
  assert.deepEqual(values, { theme: "dark" }, "values is the live in-memory settings");
});
