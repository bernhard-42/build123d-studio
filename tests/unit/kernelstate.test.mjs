// node --test tests/unit/kernelstate.test.mjs
//
// Two questions share one variable here, and the whole reason this module
// exists is that they must not become one answer. The indicator wants a word
// for "an interrupt has been asked for"; the code that offers to restart a
// kernel which ignored the interrupt wants to know whether it is still busy.
// Merging them - making "interrupting" a state - silently switches off the one
// piece of help a missed interrupt has, and nothing on screen would say so.

import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";

import {
  abandonInterrupt,
  hasStopped,
  indicatorClass,
  kernelState,
  label,
  onKernelChange,
  report,
  requestInterrupt,
  reset,
} from "../../src/kernelstate.js";

beforeEach(() => reset());

// --- what the kernel says --------------------------------------------------

test("the reported state is what comes back, not the word on screen", () => {
  report("busy");
  assert.equal(kernelState(), "busy");
  requestInterrupt();
  assert.equal(kernelState(), "busy", "asking changed what the kernel is doing");
  assert.equal(label(), "interrupting");
});

test("a state nobody defined is taken as dead rather than shown", () => {
  // The indicator has three words and a colour for each. A fourth would arrive
  // with no colour, no meaning to a reader, and no branch that handles it.
  report("confused");
  assert.equal(kernelState(), "dead");
  assert.equal(indicatorClass(), "dead");
});

// --- the interrupt question ------------------------------------------------

test("hasStopped reads the kernel, and an asked-for interrupt does not answer it", () => {
  report("busy");
  requestInterrupt();
  assert.equal(hasStopped(), false, "asking was mistaken for stopping");
});

test("and it is true once the kernel goes idle", () => {
  report("busy");
  requestInterrupt();
  report("idle");
  assert.equal(hasStopped(), true);
});

test("a kernel that stopped is idle, whatever was asked of it", () => {
  report("busy");
  requestInterrupt();
  report("idle");
  assert.equal(label(), "idle", "the word outlived the request");
});

test("so does one that died", () => {
  // A restart, a crash, a sidecar that went. None of them leave an interrupt
  // pending, and an indicator reading "interrupting" over a dead kernel would
  // be describing a request nothing can still answer.
  report("busy");
  requestInterrupt();
  report("dead");
  assert.equal(label(), "dead");
});

test("giving up on the interrupt says busy again, not idle", () => {
  // After the grace period the dialog explains, and the indicator goes back to
  // the truth: it is busy and the interrupt has not landed. Claiming idle would
  // be a lie, and claiming "interrupting" for ever is a promise nobody kept.
  report("busy");
  requestInterrupt();
  abandonInterrupt();
  assert.equal(label(), "busy");
  assert.equal(hasStopped(), false, "giving up was mistaken for stopping");
});

// --- what the indicator shows ----------------------------------------------

test("the dot stays the busy one while an interrupt is pending", () => {
  // Because that is what the kernel is: asked to stop, and not stopped. Only
  // the word says the asking has happened.
  report("busy");
  requestInterrupt();
  assert.equal(indicatorClass(), "busy");
  assert.equal(label(), "interrupting");
});

test("asking an idle kernel to stop does not make it look busy", () => {
  // hasStopped must read the kernel and nothing else. Folding the pending
  // request into it - `state !== "busy" && !interrupting` - looks harmless and
  // is not: the button is reachable while nothing runs, and one press then
  // leaves the restart offer believing the kernel never stopped.
  report("idle");
  requestInterrupt();
  assert.equal(hasStopped(), true);
});

test("interrupting an idle kernel says nothing", () => {
  // The button is reachable when nothing is running - from the keymap, and from
  // the cell markers - and a word about work that is not happening is noise.
  report("idle");
  requestInterrupt();
  assert.equal(label(), "idle");
});

// --- telling the toolbar ---------------------------------------------------

test("every change is announced, so nothing has to remember to redraw", () => {
  let announced = 0;
  const stop = onKernelChange(() => { announced += 1; });

  report("busy");
  requestInterrupt();
  abandonInterrupt();
  report("idle");

  assert.equal(announced, 4);
  stop();
  report("busy");
  assert.equal(announced, 4, "a listener kept being called after it unsubscribed");
});

test("a listener that throws does not stop the next one being told", () => {
  let reached = false;
  const first = onKernelChange(() => { throw new Error("render failed"); });
  const second = onKernelChange(() => { reached = true; });

  report("busy");

  assert.equal(reached, true);
  first();
  second();
});
