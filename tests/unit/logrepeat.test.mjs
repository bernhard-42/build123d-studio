import assert from "node:assert/strict";
import test from "node:test";

import { emit, repeater } from "../../src/logrepeat.js";

/** A stream that collects what would have been written. */
function sink() {
  const written = [];
  return { written, append: (text) => written.push(text), text: () => written.join("") };
}

const entry = (key, line) => ({ key, line });

test("the first line is written without a leading newline", () => {
  const stream = repeater();
  const out = sink();
  emit(stream, entry("INFO a", "12:00 INFO a"), out.append);
  assert.equal(out.text(), "12:00 INFO a");
});

test("a repeat is a dot, not another line", () => {
  const stream = repeater();
  const out = sink();
  for (let i = 0; i < 4; i += 1) {
    emit(stream, entry("INFO waiting", `12:0${i} INFO waiting`), out.append);
  }
  assert.equal(out.text(), "12:00 INFO waiting...");
});

test("the same words at different moments are the same entry", () => {
  // Which is the whole point: the timestamp is not part of the key, or nothing
  // would ever repeat.
  const stream = repeater();
  const out = sink();
  emit(stream, entry("INFO x", "12:00:01 INFO x"), out.append);
  emit(stream, entry("INFO x", "12:00:09 INFO x"), out.append);
  assert.equal(out.text(), "12:00:01 INFO x.");
});

test("a different message closes the run and starts its own line", () => {
  const stream = repeater();
  const out = sink();
  emit(stream, entry("INFO a", "t1 INFO a"), out.append);
  emit(stream, entry("INFO a", "t2 INFO a"), out.append);
  emit(stream, entry("INFO b", "t3 INFO b"), out.append);
  assert.equal(out.text(), "t1 INFO a.\nt3 INFO b");
});

test("alternating messages never collapse", () => {
  const stream = repeater();
  const out = sink();
  emit(stream, entry("A", "t1 A"), out.append);
  emit(stream, entry("B", "t2 B"), out.append);
  emit(stream, entry("A", "t3 A"), out.append);
  assert.equal(out.text(), "t1 A\nt2 B\nt3 A");
});

test("the same words at different levels are different entries", () => {
  // A warning that repeats an info line is news, not a repeat.
  const stream = repeater();
  const out = sink();
  emit(stream, entry("INFO kernel busy", "t1 INFO kernel busy"), out.append);
  emit(stream, entry("WARNING kernel busy", "t2 WARNING kernel busy"), out.append);
  assert.equal(out.text(), "t1 INFO kernel busy\nt2 WARNING kernel busy");
});

test("each stream counts its own repeats", () => {
  // Three files. A line repeated in one must not be swallowed in another
  // because they happen to say the same thing.
  const app = repeater();
  const console_ = repeater();
  const a = sink();
  const c = sink();
  emit(app, entry("X", "t1 X"), a.append);
  emit(console_, entry("X", "t1 X"), c.append);
  assert.equal(a.text(), "t1 X");
  assert.equal(c.text(), "t1 X", "the second stream wrote a dot for a line it had never written");
});
