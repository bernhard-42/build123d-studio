// node --test tests/unit/running.test.mjs
//
// The property is that a quit reaches every process that is still running, and
// the failure it exists for is silent: uv carried on installing after the
// window closed, because run() awaited the exit and threw the handle away.
// Nothing observed it until a first run was interrupted and the next start
// found two of them in one environment.
//
// The awaiting matters as much as the killing. Neutralino's kill is an IPC call
// to the native side, so a stopAll that does not wait can return before a
// single request has gone out, and app.exit() follows it immediately.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createRegistry } from "../../src/running.js";

/** A process handle that records being killed, and can be slow or broken. */
function handle(name, killed, { delay = 0, throws = null } = {}) {
  return {
    name,
    kill: async () => {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (throws !== null) {
        throw throws;
      }
      killed.push(name);
    },
  };
}

test("a quit kills everything still running", async () => {
  const killed = [];
  const registry = createRegistry();
  registry.track(handle("uv", killed));
  registry.track(handle("curl", killed));

  assert.equal(await registry.stopAll(), 2);
  assert.deepEqual(killed.sort(), ["curl", "uv"]);
});

test("one that has already ended is not killed", async () => {
  const killed = [];
  const registry = createRegistry();
  const uv = registry.track(handle("uv", killed));
  registry.track(handle("curl", killed));
  registry.forget(uv);

  assert.equal(await registry.stopAll(), 1);
  assert.deepEqual(killed, ["curl"]);
});

test("stopAll waits for the kills rather than only asking", async () => {
  // The one that would pass against a stopAll returning before its IPC has
  // gone: everything here is slower than the call that starts it.
  const killed = [];
  const registry = createRegistry();
  registry.track(handle("uv", killed, { delay: 20 }));
  registry.track(handle("tar", killed, { delay: 20 }));

  await registry.stopAll();

  assert.equal(killed.length, 2, "stopAll returned before the kills landed");
});

test("a kill that fails does not strand the others", async () => {
  // A handle goes stale the moment its process exits on its own, and a quit
  // arriving just then must still collect everything else.
  const killed = [];
  const failures = [];
  const registry = createRegistry();
  registry.track(handle("stale", killed, { throws: new Error("no such process") }));
  registry.track(handle("uv", killed));

  const stopped = await registry.stopAll({
    onError: (which, error) => failures.push([which.name, error.message]),
  });

  assert.equal(stopped, 2);
  assert.deepEqual(killed, ["uv"]);
  assert.deepEqual(failures, [["stale", "no such process"]]);
});

test("asking twice during one quit kills once", async () => {
  const killed = [];
  const registry = createRegistry();
  registry.track(handle("uv", killed));

  const [first, second] = await Promise.all([registry.stopAll(), registry.stopAll()]);

  assert.equal(first + second, 1, "the same process was killed twice");
  assert.deepEqual(killed, ["uv"]);
  assert.equal(registry.count(), 0);
});

// --- the window a quit can land in -----------------------------------------

test("a process that arrives after the quit kills itself", async () => {
  // The native side creates the process while handling the spawn request, so
  // it exists before the handle does. A quit draining the set in that window
  // found nothing to kill, and app.exit() followed - which is exactly the
  // failure this module exists to prevent, through a few milliseconds.
  const killed = [];
  const registry = createRegistry();

  await registry.stopAll();
  registry.track(handle("uv", killed));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(killed, ["uv"], "a late arrival was recorded rather than killed");
  assert.equal(registry.count(), 0, "it was added to a set nobody will read again");
});

test("and a bootstrap that retries after being killed does not escape either", async () => {
  // Killing `uv sync` makes run() resolve non-zero, and the bootstrap answers a
  // failed sync by retrying it. The retry spawns a fresh uv, after the quit.
  const killed = [];
  const registry = createRegistry();
  registry.track(handle("uv sync", killed));

  await registry.stopAll();
  registry.track(handle("uv sync (retry)", killed));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(killed.sort(), ["uv sync", "uv sync (retry)"]);
});

test("a late arrival that cannot be killed does not throw at the caller", async () => {
  // This runs from track(), which is on the spawn path, not the quit path.
  const registry = createRegistry();
  await registry.stopAll();

  registry.track(handle("stale", [], { throws: new Error("no such process") }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
