// node --test tests/unit/nativelink.test.mjs
//
// Noticing that the link to the application has stopped answering.
//
// The failure is specific and was measured rather than imagined: on Windows
// waking from sleep the socket to Neutralino stays open as far as the page can
// tell, and every call made on it - saving a file, spawning a process, closing
// the window - is queued and never rejected. Nothing throws, nothing closes,
// and the only symptom is an application where nothing works.
//
// So the policy is what has to be right, and it is a balance: report too eagerly
// and somebody is told to reload a window that was fine, losing whatever is
// unsaved; report too late and they spend minutes wondering why Save does
// nothing.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  holdNativeLink,
  nativeLinkHeld,
  watchNativeLink,
} from "../../src/nativelink.js";

/** A probe that answers, or hangs, depending on a switch the test holds. */
function switchable() {
  const state = { answering: true, asked: 0 };
  state.probe = () => {
    state.asked += 1;
    return state.answering ? Promise.resolve({}) : new Promise(() => {});
  };
  return state;
}

const settle = (ms) => new Promise((done) => setTimeout(done, ms));

test("a link that answers is never reported", async () => {
  const link = switchable();
  let lost = 0;
  const stop = watchNativeLink({
    probe: link.probe, onLost: () => { lost += 1; }, interval: 5, deadline: 20,
  });

  await settle(60);
  stop();

  assert.equal(lost, 0);
  assert.ok(link.asked > 2, `the watch never asked anything (${link.asked})`);
});

test("one that stops answering is reported once", async () => {
  const link = switchable();
  let lost = 0;
  const stop = watchNativeLink({
    probe: link.probe, onLost: () => { lost += 1; }, interval: 5, deadline: 15, misses: 2,
  });

  link.answering = false;
  await settle(120);
  stop();

  assert.equal(lost, 1, "the dead link was reported once, and only once");
});

test("a single miss is not enough", async () => {
  // The first probe after a resume is the one most likely to have been in
  // flight across the suspend. Condemning the link for it would tell somebody
  // to reload a window that is about to be fine.
  const link = switchable();
  let lost = 0;
  const stop = watchNativeLink({
    probe: link.probe, onLost: () => { lost += 1; }, interval: 5, deadline: 15, misses: 2,
  });

  link.answering = false;
  await settle(25);
  link.answering = true;
  await settle(60);
  stop();

  assert.equal(lost, 0, "one missed answer condemned a link that came back");
});

test("a probe that fails still counts as an answer", async () => {
  // A refusal travelled down the link and came back, which is the opposite of
  // the silence this watches for. Only silence means gone.
  let lost = 0;
  const stop = watchNativeLink({
    probe: () => Promise.reject(new Error("no permission")),
    onLost: () => { lost += 1; },
    interval: 5, deadline: 15, misses: 2,
  });

  await settle(60);
  stop();

  assert.equal(lost, 0);
});

test("and stopping the watch stops the probing", async () => {
  const link = switchable();
  const stop = watchNativeLink({ probe: link.probe, interval: 5, deadline: 15, onLost: () => {} });

  await settle(30);
  stop();
  const asked = link.asked;
  await settle(40);

  assert.equal(link.asked, asked, "it kept asking after being stopped");
});

// --- the machine waking up --------------------------------------------------

/** A clock a test can move, because a test cannot sleep a machine. */
function movable(start = 1_000_000) {
  const clock = { at: start };
  clock.now = () => clock.at;
  return clock;
}

test("a clock that jumps means the machine slept, and the link is asked at once", async () => {
  // Without this the banner waits for the next scheduled probe - up to the full
  // interval, and then a deadline on top. Measured on Windows at 0.3.0.dev177:
  // ten seconds from the machine coming back to being told the link was gone.
  //
  // The patient deadline here is set enormous on purpose: this must answer on
  // the wake deadline, which is short because the probe is a loopback call that
  // either replies at once or never. If this test starts taking the patient
  // path it will hang rather than fail, which is the same signal.
  const clock = movable();
  const link = switchable();
  let lost = 0;
  const stop = watchNativeLink({
    probe: link.probe, onLost: () => { lost += 1; }, now: clock.now,
    interval: 100000, deadline: 100000, wakeDeadline: 15, misses: 2, tick: 5, jump: 5000,
  });

  link.answering = false;
  clock.at += 60000;
  await settle(80);
  stop();

  assert.equal(lost, 1, "the wake was not noticed, or a second silence was waited for");
});

test("and a link that is fine after the wake is left alone", async () => {
  // The other half, and the one that costs work if it is wrong: a false alarm
  // here tells somebody to reload a window that was working.
  const clock = movable();
  const link = switchable();
  let lost = 0;
  const stop = watchNativeLink({
    probe: link.probe, onLost: () => { lost += 1; }, now: clock.now,
    interval: 100000, deadline: 100000, wakeDeadline: 15, misses: 2, tick: 5, jump: 5000,
  });

  clock.at += 60000;
  await settle(80);
  stop();

  assert.equal(lost, 0);
  assert.ok(link.asked > 0, "the wake did not trigger a probe at all");
});

test("an ordinary tick is not a jump", async () => {
  const clock = movable();
  const link = switchable();
  let lost = 0;
  const stop = watchNativeLink({
    probe: link.probe, onLost: () => { lost += 1; }, now: clock.now,
    interval: 100000, deadline: 100000, wakeDeadline: 15, misses: 2, tick: 5, jump: 5000,
  });

  link.answering = false;
  clock.at += 1200;
  await settle(80);
  stop();

  assert.equal(lost, 0, "a second of ordinary time was treated as a suspend");
  assert.equal(link.asked, 0, "it probed without being asked to");
});

// --- not concluding anything while we are the reason it is slow ------------
//
// uv pumps a local checkout's build output through the same connection every
// native call uses. On Windows that was enough for two probes in a row to miss
// their five-second deadline, and the window was told it had died - over an
// install that ran perfectly.

test("a held link is not probed, and is never reported", async () => {
  const link = switchable();
  link.answering = false;
  let lost = 0;
  const stop = watchNativeLink({
    probe: link.probe,
    onLost: () => { lost += 1; },
    interval: 5,
    deadline: 15,
    misses: 2,
    isHeld: () => true,
  });

  await settle(120);
  stop();

  assert.equal(link.asked, 0, "a held link was asked anyway");
  assert.equal(lost, 0, "a held link was declared dead");
});

test("and it is asked again once the hold is released", async () => {
  const link = switchable();
  let held = true;
  const stop = watchNativeLink({
    probe: link.probe, onLost: () => {}, interval: 5, deadline: 15, isHeld: () => held,
  });

  await settle(40);
  assert.equal(link.asked, 0, "asked while held");

  held = false;
  await settle(40);
  stop();

  assert.ok(link.asked > 0, "the watch did not resume after the hold");
});

test("holdNativeLink nests, so an action inside an action still holds", () => {
  // A re-install stages files, runs uv, then restarts the language server and
  // the kernel. A flag would be cleared by whichever finished first.
  assert.equal(nativeLinkHeld(), false);
  const outer = holdNativeLink();
  const inner = holdNativeLink();
  inner();
  assert.equal(nativeLinkHeld(), true, "the outer hold was released by the inner one");
  outer();
  assert.equal(nativeLinkHeld(), false);
  outer();
  assert.equal(nativeLinkHeld(), false, "releasing twice went negative");
});
