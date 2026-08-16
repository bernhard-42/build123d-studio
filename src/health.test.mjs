import assert from "node:assert/strict";
import test from "node:test";

import { anythingUnwell, health, onHealthChange, record, reset, summary, worstState } from "./health.js";

test("nothing has spoken, so nothing is wrong", () => {
  reset();
  assert.equal(worstState(), "ready");
  assert.equal(anythingUnwell(), false);
});

test("starting is not a fault", () => {
  // At the moment the window appears the measurement backend is still loading
  // its geometry kernel and will be for a second or two. Treating that as a
  // fault would leave every good start looking like a bad one.
  reset();
  record("measurement", "starting", "loading the geometry kernel");
  assert.equal(anythingUnwell(), false);
});

test("a failure outranks everything else, whatever order it arrived in", () => {
  reset();
  record("kernel", "ready");
  record("measurement", "failed", "did not answer its first ping");
  record("console", "ready");
  assert.equal(worstState(), "failed");
  assert.equal(anythingUnwell(), true);
  assert.equal(health()[0].name, "measurement", "the worst is not first");
});

test("degraded counts as unwell: it works, with something worth knowing", () => {
  reset();
  record("viewer", "degraded", "the model channel is slow");
  assert.equal(anythingUnwell(), true);
});

test("the last word from a subsystem replaces the one before", () => {
  reset();
  record("measurement", "failed", "died");
  record("measurement", "ready", "");
  assert.equal(anythingUnwell(), false);
  assert.equal(health().length, 1);
});

test("an unknown state is treated as degraded rather than dropped", () => {
  // A newer sidecar may report something this frontend has never heard of.
  // Silently ignoring it would be the one outcome nobody could diagnose.
  reset();
  record("something", "sideways");
  assert.equal(worstState(), "degraded");
});

test("a nameless report is ignored", () => {
  reset();
  record("", "failed");
  assert.equal(health().length, 0);
});

test("the summary names each part and why", () => {
  reset();
  record("measurement", "failed", "did not answer its first ping");
  assert.equal(summary(), "measurement: failed - did not answer its first ping");
});

test("watchers hear about every change", () => {
  reset();
  const seen = [];
  const stop = onHealthChange((current) => seen.push(current.length));
  record("kernel", "ready");
  record("viewer", "ready");
  stop();
  record("console", "ready");
  assert.deepEqual(seen, [1, 2], "a watcher heard after it stopped, or missed one");
});

test("reset tells its subscribers, so nothing goes on showing a dead process", () => {
  reset();
  record("kernel", "failed", "the kernel process exited");

  const seen = [];
  const stop = onHealthChange((entries) => seen.push(entries.length));
  reset();
  stop();

  assert.deepStrictEqual(seen, [0]);
  assert.strictEqual(anythingUnwell(), false);
});
