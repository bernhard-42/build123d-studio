// node --test tests/unit/debug/dap.test.mjs
//
// The DAP conversation, driven with no sidecar and no window - which is the
// reason the transport is injected rather than imported.
//
// The ordering test is the one that earned its place. In a probe against the
// kernel, setBreakpoints was sent before the `initialized` event arrived; it
// was accepted, answered `verified: true`, and execution ran straight past the
// breakpoint. That reads exactly like a debugger that does not work, and it
// cost an hour of believing so.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { configure, createClient, setBreakpoints } from "../../../src/debug/dap.js";

/** A transport that records what was sent and lets a test answer it. */
function fakeTransport() {
  const sent = [];
  const transport = { send: (message) => sent.push(message) };
  return { sent, transport, commands: () => sent.map((message) => message.command) };
}

const respond = (client, seq, body = {}) =>
  client.handle({ type: "response", request_seq: seq, success: true, body });

/** Let the awaits in configure() run. Two turns, because each step awaits. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// --- correlation ---

test("a reply reaches the request that asked for it, not the one before", async () => {
  const { transport, sent } = fakeTransport();
  const client = createClient(transport);

  const first = client.request("stackTrace", { threadId: 1 });
  const second = client.request("scopes", { frameId: 7 });

  // Answered out of order, which an adapter is allowed to do.
  respond(client, sent[1].seq, { scopes: ["Locals"] });
  respond(client, sent[0].seq, { stackFrames: ["frame"] });

  assert.deepEqual((await first).body, { stackFrames: ["frame"] });
  assert.deepEqual((await second).body, { scopes: ["Locals"] });
});

test("every request gets its own seq", () => {
  const { transport, sent } = fakeTransport();
  const client = createClient(transport);
  client.request("threads");
  client.request("threads");
  assert.notEqual(sent[0].seq, sent[1].seq);
});

test("a reply nobody is waiting for is dropped rather than thrown on", () => {
  // A terminated session can still have answers in flight, and there is nobody
  // left who wanted them.
  const { transport } = fakeTransport();
  const client = createClient(transport);
  assert.doesNotThrow(() => respond(client, 99));
  assert.doesNotThrow(() => client.handle(null));
  assert.doesNotThrow(() => client.handle({ type: "response" }));
});

// --- events ---

test("an event reaches its listeners and nobody else's", () => {
  const { transport } = fakeTransport();
  const client = createClient(transport);
  const stops = [];
  const exits = [];
  client.on("stopped", (message) => stops.push(message.body.reason));
  client.on("exited", () => exits.push(true));

  client.handle({ type: "event", event: "stopped", body: { reason: "breakpoint" } });

  assert.deepEqual(stops, ["breakpoint"]);
  assert.deepEqual(exits, []);
});

test("unsubscribing stops the listener", () => {
  const { transport } = fakeTransport();
  const client = createClient(transport);
  const seen = [];
  const off = client.on("stopped", () => seen.push(true));
  client.handle({ type: "event", event: "stopped", body: {} });
  off();
  client.handle({ type: "event", event: "stopped", body: {} });
  assert.equal(seen.length, 1);
});

test("closing answers everything outstanding rather than leaving it hanging", async () => {
  // A promise that never settles is how a UI ends up waiting for ever on a
  // process that has already exited.
  const { transport } = fakeTransport();
  const client = createClient(transport);
  const pending = client.request("stackTrace", { threadId: 1 });
  client.close();
  const reply = await pending;
  assert.equal(reply.success, false);
});

// --- the ordering rule ---

test("nothing is configured until the adapter says it is initialized", async () => {
  const { transport, sent, commands } = fakeTransport();
  const client = createClient(transport);

  const done = configure(client, [{ path: "/tmp/a.py", lines: [5] }]);

  // initialize and attach go out, and then nothing does.
  await settle();
  respond(client, sent[0].seq);
  await settle();
  respond(client, sent[1].seq);
  await settle();
  assert.deepEqual(commands(), ["initialize", "attach"],
    "setBreakpoints must wait for the initialized event");

  client.handle({ type: "event", event: "initialized" });
  await settle();
  assert.deepEqual(commands(), ["initialize", "attach", "setBreakpoints"]);

  respond(client, sent[2].seq, { breakpoints: [{ verified: true, line: 5 }] });
  await settle();
  respond(client, sent[3].seq);

  assert.deepEqual(commands(), ["initialize", "attach", "setBreakpoints", "configurationDone"]);
  assert.equal((await done).verified, 1);
});

test("every marked file is sent, not only the one being run", async () => {
  // A breakpoint in a module the script imports is how somebody follows
  // execution into it, and DAP addresses breakpoints one source at a time.
  const { transport, sent } = fakeTransport();
  const client = createClient(transport);

  const done = configure(client, [
    { path: "/tmp/main.py", lines: [5] },
    { path: "/tmp/helper.py", lines: [2, 9] },
  ]);
  await settle();
  respond(client, sent[0].seq);
  await settle();
  respond(client, sent[1].seq);
  client.handle({ type: "event", event: "initialized" });
  await settle();
  respond(client, sent[2].seq, { breakpoints: [{ verified: true, line: 5 }] });
  await settle();
  respond(client, sent[3].seq, {
    breakpoints: [{ verified: true, line: 2 }, { verified: true, line: 9 }],
  });
  await settle();
  respond(client, sent[4].seq);

  assert.deepEqual(
    sent.filter((message) => message.command === "setBreakpoints")
      .map((message) => message.arguments.source.path),
    ["/tmp/main.py", "/tmp/helper.py"],
  );
  assert.equal((await done).verified, 3);
});

test("lines and columns are asked for one-based, so nothing is ever translated", async () => {
  const { transport, sent } = fakeTransport();
  const client = createClient(transport);
  configure(client, []);
  await settle();

  // Monaco counts from one too. The whole feature has no coordinate conversion
  // in it, and this is where that is decided.
  assert.equal(sent[0].arguments.linesStartAt1, true);
  assert.equal(sent[0].arguments.columnsStartAt1, true);
});

test("a breakpoint the adapter refused is not counted as set", async () => {
  const { transport, sent } = fakeTransport();
  const client = createClient(transport);
  const done = configure(client, [{ path: "/tmp/a.py", lines: [5, 9] }]);

  await settle();
  respond(client, sent[0].seq);
  await settle();
  respond(client, sent[1].seq);
  client.handle({ type: "event", event: "initialized" });
  await settle();
  respond(client, sent[2].seq, {
    breakpoints: [{ verified: true, line: 5 }, { verified: false, line: 9 }],
  });
  await settle();
  respond(client, sent[3].seq);

  assert.equal((await done).verified, 1);
});

test("removing the last mark in a file sends an empty list, not nothing", async () => {
  // DAP replaces a source's breakpoints wholesale, so an empty list is the only
  // way to say "none here any more".
  const { transport, sent } = fakeTransport();
  const client = createClient(transport);
  const done = setBreakpoints(client, "/tmp/a.py", []);
  await settle();

  assert.deepEqual(sent[0].arguments.breakpoints, []);
  respond(client, sent[0].seq, { breakpoints: [] });
  assert.deepEqual(await done, []);
});

test("whether step-into may enter build123d is the caller's to decide", async () => {
  // Not a cosmetic setting: with justMyCode on, a step into
  // `extrude(Ellipse(10, 6), 2)` stays on the line it started on, silently, as
  // though the call had no inside. Measured against build123d - with it off the
  // same step lands in Ellipse.__init__ in objects_sketch.py.
  const attachArguments = async (options) => {
    const { transport, sent } = fakeTransport();
    const client = createClient(transport);
    configure(client, [], options);
    await settle();
    respond(client, sent[0].seq);
    await settle();
    return sent.find((message) => message.command === "attach").arguments;
  };

  assert.equal((await attachArguments({ justMyCode: false })).justMyCode, false);
  assert.equal((await attachArguments({ justMyCode: true })).justMyCode, true);
});

test("and defaults to staying in the user's own code", async () => {
  // debugpy's own default, and the safer one to meet first: stepping into a
  // library you did not mean to enter is disorienting while you are still
  // learning what the buttons do.
  const { transport, sent } = fakeTransport();
  const client = createClient(transport);
  configure(client, []);
  await settle();
  respond(client, sent[0].seq);
  await settle();

  assert.equal(sent.find((message) => message.command === "attach").arguments.justMyCode, true);
});
