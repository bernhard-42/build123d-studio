// The Debug Adapter Protocol conversation, with the transport left out.
//
// The sidecar relays DAP verbatim and understands none of it, so this is the
// only place in the application that knows what a `seq` is. Given a way to send
// a message and a stream of messages coming back, it correlates replies to
// requests and hands events to whoever asked - which is all a DAP client is,
// once somebody else owns the socket.
//
// The transport is injected rather than imported so this can be driven by a
// test with no sidecar and no window. What that buys is worth naming: the
// ordering rule below is the one thing here that was got wrong first time, in a
// probe, and it cost an hour of believing the kernel could not be debugged.

/**
 * A DAP client over any transport.
 *
 * @param {{send: (message: object) => void}} transport
 */
export function createClient(transport) {
  const pending = new Map();
  const listeners = new Map();
  let nextSeq = 1;

  /** Send a request and resolve with its response. */
  function request(command, args = {}) {
    const seq = nextSeq;
    nextSeq += 1;
    return new Promise((resolve) => {
      pending.set(seq, resolve);
      transport.send({ seq, type: "request", command, arguments: args });
    });
  }

  /** Subscribe to a DAP event. Returns an unsubscribe function. */
  function on(event, listener) {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event).add(listener);
    return () => listeners.get(event).delete(listener);
  }

  /** Wait for one event. Used for `initialized`, which gates configuration. */
  function once(event) {
    return new Promise((resolve) => {
      const off = on(event, (message) => {
        off();
        resolve(message);
      });
    });
  }

  /**
   * Take one message off the wire.
   *
   * Responses whose request is not outstanding are dropped rather than thrown
   * on: a session that has been terminated may still have answers in flight,
   * and there is nobody left who wanted them.
   */
  function handle(message) {
    if (message === null || message === undefined) {
      return;
    }
    if (message.type === "response") {
      const resolve = pending.get(message.request_seq);
      if (resolve !== undefined) {
        pending.delete(message.request_seq);
        resolve(message);
      }
      return;
    }
    if (message.type !== "event") {
      return;
    }
    for (const listener of listeners.get(message.event) ?? []) {
      listener(message);
    }
  }

  /**
   * Abandon everything outstanding, because there is nothing left to answer it.
   *
   * Resolved rather than rejected, and with a failed response rather than
   * nothing: every caller here already handles a request that did not succeed,
   * and a promise that never settles is how a UI ends up waiting for ever on a
   * process that has exited.
   */
  function close() {
    for (const [seq, resolve] of pending) {
      resolve({ type: "response", request_seq: seq, success: false,
                message: "the debug session ended" });
    }
    pending.clear();
    listeners.clear();
  }

  return { request, on, once, handle, close };
}

/**
 * Tell the adapter where to stop in one file.
 *
 * DAP has no way to add or remove a single breakpoint: setBreakpoints replaces
 * everything for that source, so the caller sends the file's whole list every
 * time. An empty list is how the last mark in a file is removed.
 *
 * @returns {number[]} the lines the adapter accepted
 */
export async function setBreakpoints(client, path, lines) {
  const reply = await client.request("setBreakpoints", {
    source: { path },
    breakpoints: lines.map((line) => ({ line })),
    sourceModified: false,
  });
  return (reply?.body?.breakpoints ?? [])
    .filter((breakpoint) => breakpoint.verified === true)
    .map((breakpoint) => breakpoint.line);
}

/**
 * Bring a session up, in the order the protocol requires.
 *
 * The order is the whole of this function and it is not obvious: DAP says the
 * client must wait for the `initialized` *event* before configuring. Sent
 * earlier, `setBreakpoints` is accepted and answers `verified: true`, and the
 * code then runs straight past the breakpoint - which reads exactly like a
 * debugger that does not work rather than like a client that spoke out of turn.
 *
 * Every marked file is sent, not only the one being run: a breakpoint in a
 * module the script imports is how somebody follows execution into it.
 *
 * @param {object} client from createClient
 * @param {Array<{path: string, lines: number[]}>} files where to stop
 * @returns {Promise<{verified: number}>} how many lines the adapter accepted
 */
export async function configure(client, files, { justMyCode = true } = {}) {
  const ready = client.once("initialized");
  await client.request("initialize", {
    clientID: "build123d-studio",
    adapterID: "debugpy",
    pathFormat: "path",
    // Both one-based, which is Monaco's convention too, so no position in this
    // feature is ever translated.
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
  });
  // Whether "step into" may enter build123d, or stops at the edge of the
  // user's own file. Not a cosmetic setting: with justMyCode on, a step into
  // `extrude(Ellipse(10, 6), 2)` stays on the line it started on, silently, as
  // though the call had no inside. Measured - with it off the same step lands
  // in Ellipse.__init__ in build123d's objects_sketch.py.
  //
  // Defaulted on, which is debugpy's own default and the safer one to meet
  // first: stepping into a library you did not mean to enter is disorienting
  // when you are still learning what the buttons do. Settings turns it off for
  // anyone who wants to see what build123d did with their arguments.
  await client.request("attach", { justMyCode });
  await ready;

  let verified = 0;
  for (const file of files) {
    verified += (await setBreakpoints(client, file.path, file.lines)).length;
  }
  await client.request("configurationDone", {});
  return { verified };
}
