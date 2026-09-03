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
  interruptPending,
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

test("asking is not being obeyed", () => {
  report("busy");
  requestInterrupt();
  assert.equal(interruptPending(), true, "asking was mistaken for stopping");
});

test("and the request is answered once the kernel goes idle", () => {
  report("busy");
  requestInterrupt();
  report("idle");
  assert.equal(interruptPending(), false);
});

test("a kernel that stopped and was given new work has still obeyed", () => {
  // The defect this replaced a state reading for. Interrupt a cell, let it
  // stop, run two more inside the five second grace, and a check that sampled
  // the state at the deadline saw `busy` - the new work - and offered to
  // restart a kernel that had done exactly what it was told.
  report("busy");
  requestInterrupt();
  report("idle");
  report("busy");

  assert.equal(interruptPending(), false, "new work was mistaken for a missed interrupt");
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
  assert.equal(interruptPending(), false, "the offer is made once, not repeatedly");
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

test("asking an idle kernel to stop leaves nothing pending", () => {
  // The button is reachable while nothing is running - from the keymap and from
  // the cell markers - and a press then must not leave a request standing that
  // the grace would later report as a kernel refusing to stop.
  report("idle");
  requestInterrupt();
  report("idle");
  assert.equal(interruptPending(), false);
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

// --- what is waiting behind the one that is running ---------------------------

test("a queue behind the running cell is counted in the word", () => {
  // Pressing Run while a cell runs queues it, and nothing used to say so: the
  // indicator already read "busy" and the console shows `In [n]` only when the
  // kernel starts a request. His table, in order.
  report("busy", 0);
  assert.equal(label(), "busy");
  report("busy", 1);
  assert.equal(label(), "busy [+1]");
  report("busy", 2);
  assert.equal(label(), "busy [+2]");
  report("busy", 1);
  assert.equal(label(), "busy [+1]");
  report("busy", 0);
  assert.equal(label(), "busy");
  report("idle", 0);
  assert.equal(label(), "idle");
});

test("the dot is still the busy one, however many are waiting", () => {
  // The kernel is running one thing. A queue says how much work is booked, not
  // what state the kernel is in.
  report("busy", 3);
  assert.equal(indicatorClass(), "busy");
});

test("a queue against a kernel that is not running is not shown", () => {
  // The count arrives from another process on the same frame as the state, and
  // "idle [+2]" would be a contradiction on screen rather than information.
  report("idle", 2);
  assert.equal(label(), "idle");
});

test("a count that is not a whole number is no count at all", () => {
  report("busy", undefined);
  assert.equal(label(), "busy");
  report("busy", null);
  assert.equal(label(), "busy");
  report("busy", -1);
  assert.equal(label(), "busy");
});

test("interrupting still wins, because it is about the run in progress", () => {
  // Somebody who has just pressed Interrupt is asking about the cell that is
  // running, not about what is booked behind it.
  report("busy", 2);
  requestInterrupt();
  assert.equal(label(), "interrupting");
});

test("and the queue is forgotten when the kernel stops", () => {
  report("busy", 2);
  report("idle");
  assert.equal(label(), "idle");
  report("busy");
  assert.equal(label(), "busy", "a stale count outlived the run it belonged to");
});
