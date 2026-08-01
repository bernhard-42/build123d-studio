import { decodeBinary, encodeBinary } from "./frame.js";
import { spawn, quote } from "./proc.js";
import * as log from "./log.js";

// Webview end of the sidecar link.
//
// The sidecar binds a random loopback port and announces it on stdout; that one
// handshake line is all stdio is used for. Everything else runs over the
// WebSocket, which matters because it carries binary natively: pty bytes and
// tessellated geometry never have to be base64-encoded, and a received payload
// can be viewed as typed arrays without a copy.
//
// Binary frame layout, matching sidecar/channel.py:
//   kind (uint8) | 3 pad | header length (uint32 BE) | header JSON | pad | payload
//
// The prefix is 8 bytes and the header is padded up to a multiple of 8, so the
// payload always starts on an 8-byte boundary. That is what makes it legal to
// build Float32Array/Uint32Array views straight over the received ArrayBuffer -
// a typed-array view throws if its byte offset is not a multiple of the element
// size. The length field is the true JSON length, with the padding implied.

// Re-exported so callers need only one import for the link.
export { KIND_CONSOLE, KIND_MODEL } from "./frame.js";

// Backstop for the sidecar's "ready", which it sends once the kernel answers.
// The kernel's own wait_for_ready is 60 s, and the console starts after it, so
// this has to be comfortably longer than both or a slow first start would be
// reported as a failure. It exists for the case where nothing arrives at all -
// a wedged sidecar that is still connected sends neither "error" nor an exit.
const READY_TIMEOUT = 90000;

const handlers = new Map();
const binaryHandlers = new Map();

let socket = null;
let sidecar = null;
let handshakeBuffer = "";
// What startSidecar was called with, so the backend can be brought back without
// the caller having to hold on to it. The environment is already resolved by
// then, and re-resolving it would repeat the whole uv sync for a restart that
// only needs a process.
let launch = null;

function dispatch(frame) {
  const listeners = handlers.get(frame.type);
  if (listeners === undefined || listeners.size === 0) {
    log.warn("Unhandled sidecar frame:", frame.type);
    return;
  }
  for (const listener of listeners) {
    try {
      listener(frame);
    } catch (error) {
      log.error(`Handler for ${frame.type} failed:`, error);
    }
  }
}

function dispatchBinary(buffer) {
  const frame = decodeBinary(buffer, (problem) => log.warn(problem));
  if (frame === null) {
    return;
  }

  const listener = binaryHandlers.get(frame.kind);
  if (listener === undefined) {
    log.warn("Unhandled binary frame kind:", frame.kind);
    return;
  }
  try {
    listener(frame.payload, frame.header, buffer, frame.payloadOffset);
  } catch (error) {
    log.error(`Binary handler for kind ${frame.kind} failed:`, error);
  }
}

/** Subscribe to a text message type. Returns an unsubscribe function. */
export function on(type, listener) {
  if (!handlers.has(type)) {
    handlers.set(type, new Set());
  }
  handlers.get(type).add(listener);
  return () => handlers.get(type).delete(listener);
}

/**
 * Subscribe to a binary frame kind.
 *
 * The listener receives (payload, header, buffer, payloadOffset). buffer and
 * payloadOffset are there so callers that need typed-array views over the
 * payload - the CAD viewer - can build them without copying.
 */
export function onBinary(kind, listener) {
  binaryHandlers.set(kind, listener);
}

/**
 * Wait for a single message of the given type.
 *
 * With a timeout, resolves null when nothing arrives in time - and, which is
 * the point, unsubscribes. Without one, a frame that never comes leaves a
 * listener in the map for the life of the session: the About dialog asks for
 * app.info and gives up after four seconds, but only the *waiting* stopped, so
 * opening it again against a dead sidecar left another one behind each time.
 *
 * The timeout belongs here rather than in a Promise.race at the call site,
 * because whoever owns the subscription has to own its lifetime. Racing it
 * elsewhere abandons the listener by construction.
 */
export function once(type, { timeout = null } = {}) {
  return new Promise((resolve) => {
    let timer = null;
    let off = null;

    const settle = (frame) => {
      if (off !== null) {
        off();
        off = null;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(frame);
    };

    off = on(type, settle);
    if (timeout !== null) {
      timer = setTimeout(() => settle(null), timeout);
    }
  });
}

/** Turn a failure frame into a sentence worth putting on screen. */
function describeFailure(what, type, frame) {
  if (type === "error") {
    const where = frame.context === undefined ? "" : ` while ${frame.context}`;
    return `${what} reported an error${where}: ${frame.message ?? "no detail given"}`;
  }
  if (type === "sidecar.exit") {
    return `${what} stopped unexpectedly (exit code ${frame.code})`;
  }
  if (type === "sidecar.disconnected") {
    return `${what} closed its connection (code ${frame.code})`;
  }
  if (type === "kernel.restart_failed") {
    return `The kernel could not be restarted: ${frame.message ?? "no detail given"}`;
  }
  return `${what}: ${type}`;
}

/**
 * Wait for one outcome, failing fast instead of hanging.
 *
 * Every wait in this protocol needs a failure companion. Awaiting only the
 * success frame is what left startup suspended for ever when the sidecar
 * connected and then died before sending "ready", and what left the settings
 * splash up with no way out when a restart never completed. The sidecar's death
 * is already observable - `sidecar.exit` and `sidecar.disconnected` - it simply
 * was not being raced against.
 *
 * The timeout is a backstop for the case no frame arrives at all: a wedged
 * sidecar that is still connected emits nothing, and neither death signal
 * fires.
 *
 * @returns {{promise: Promise<object>, cancel: () => void}} cancel unsubscribes
 *   and clears the timer, for callers that abandon the wait on another path.
 */
function expectOutcome(success, failures, { timeout = null, what = "The sidecar" } = {}) {
  const offs = [];
  let timer = null;

  const promise = new Promise((resolve, reject) => {
    const settle = (finish, value) => {
      for (const off of offs) {
        off();
      }
      offs.length = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      finish(value);
    };

    offs.push(on(success, (frame) => settle(resolve, frame)));
    for (const type of failures) {
      offs.push(on(type, (frame) => settle(reject, new Error(describeFailure(what, type, frame)))));
    }
    if (timeout !== null) {
      timer = setTimeout(
        () => settle(reject, new Error(`${what} did not respond within ${Math.round(timeout / 1000)}s`)),
        timeout,
      );
    }
  });

  return {
    promise,
    cancel: () => {
      for (const off of offs) {
        off();
      }
      offs.length = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Await a success frame, rejecting on any of the failure frames.
 *
 * @param {string} success frame type that resolves the wait
 * @param {string[]} failures frame types that reject it
 * @param {{timeout?: number, what?: string}} options
 */
export function awaitOutcome(success, failures, options = {}) {
  return expectOutcome(success, failures, options).promise;
}

export function send(type, payload = {}) {
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Sidecar is not connected");
  }
  socket.send(JSON.stringify({ type, ...payload }));
}

/** Send a binary frame. `payload` is a Uint8Array or ArrayBuffer. */
export function sendBinary(kind, payload, header = null) {
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(encodeBinary(kind, payload, header));
}

export function isConnected() {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/**
 * Strip the connection token out of a handshake line before it is logged.
 *
 * The near-miss case - a line that parses but is not what was expected - is
 * exactly the one carrying {"port": N, "token": "..."}, and the log file is
 * something users are invited to copy into bug reports. The token is only ever
 * useful to a process already on this machine, but it has no business on disk.
 */
function redactToken(line) {
  // The closing quote is optional, because the line that most needs redacting
  // is the one that did not arrive whole. A handshake truncated mid-token has
  // no closing quote, so a pattern that required one matched nothing and
  // printed the token - and a truncated handshake is exactly what reaches the
  // "malformed" branch below, which is the only place this is used.
  return line.replace(/("token"\s*:\s*")[^"]*("|$)/g, "$1<redacted>$2");
}

/** Read the sidecar's handshake line off stdout. */
function onHandshakeChunk(chunk, resolve, reject) {
  handshakeBuffer += chunk;
  const newline = handshakeBuffer.indexOf("\n");
  if (newline < 0) {
    return;
  }
  const line = handshakeBuffer.slice(0, newline);
  handshakeBuffer = "";
  try {
    const announcement = JSON.parse(line);
    if (announcement.type !== "listening") {
      reject(new Error(`Unexpected handshake: ${redactToken(line).slice(0, 200)}`));
      return;
    }
    resolve(announcement);
  } catch (error) {
    reject(
      new Error(`Malformed handshake: ${redactToken(line).slice(0, 200)} (${error.message})`),
    );
  }
}

function connect({ port, token }) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    // Held locally as well, so the handlers can tell whether they still belong
    // to the current socket. A restart replaces it, and the old one's close
    // event arrives afterwards - reporting that as a disconnection would raise
    // the "backend stopped" banner over a backend that had just come back.
    const ws = new WebSocket(url);
    socket = ws;
    // Binary frames as ArrayBuffer, so views can be built over them directly.
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      log.info("Connected to sidecar on port", port);
      resolve();
    };
    ws.onerror = () => reject(new Error(`Could not connect to the sidecar on port ${port}`));
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        dispatchBinary(event.data);
        return;
      }
      try {
        dispatch(JSON.parse(event.data));
      } catch (error) {
        log.error("Malformed frame from sidecar:", String(event.data).slice(0, 200), error);
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws) {
        // Superseded by a restart; its replacement is already connected.
        return;
      }
      log.warn("Sidecar socket closed:", event.code, event.reason);
      socket = null;
      dispatch({ type: "sidecar.disconnected", code: event.code });
    };
  });
}

/**
 * Start the sidecar, read its handshake, and connect.
 *
 * @param {{python: string, envRoot: string, appDir: string}} options
 */
export async function startSidecar({ python, envRoot, appDir }) {
  launch = { python, envRoot, appDir };
  const command =
    `${quote(python)} ${quote(`${appDir}/sidecar/main.py`)}` +
    ` --env-root ${quote(envRoot)} --app-dir ${quote(appDir)}`;

  log.info("Starting sidecar:", command);

  // A previous attempt may have left a partial line behind; a stale prefix
  // would corrupt the next handshake.
  handshakeBuffer = "";

  const announcement = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Sidecar did not announce a port")), 30000);

    spawn(command, {
      cwd: appDir,
      envs: {
        PYTHONUNBUFFERED: "1",
        // Keep .pyc files out of the bundle; see Kernel.kernel_environment.
        PYTHONPYCACHEPREFIX: `${envRoot}/pycache`,
      },
      onStdOut: (chunk) =>
        onHandshakeChunk(
          chunk,
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        ),
      // The sidecar keeps stdout for the handshake alone, so stderr is pure log.
      onStdErr: (data) => log.info("sidecar:", data.trimEnd()),
    })
      .then((process) => {
        sidecar = process;
        process.exited.then((code) => {
          if (sidecar !== process) {
            // Stopped on purpose to make room for a replacement.
            return;
          }
          log.warn("Sidecar exited with code", code);
          sidecar = null;
          dispatch({ type: "sidecar.exit", code });
        });
      })
      .catch(reject);
  });

  // Subscribed before the socket is opened, not after.
  //
  // "ready" only arrives once the kernel is up, which takes seconds, so the gap
  // between connect() resolving and a later subscription cannot lose it today.
  // But nothing structural guarantees that - a warm restart is much quicker -
  // and a lost "ready" would hang startup with only an "unhandled frame"
  // warning to show for it.
  //
  // The failure signals are the sidecar's *death*, deliberately not its "error"
  // frames. A fatal startup failure ends in the process exiting, so the exit is
  // the reliable signal; an error frame is not, because the window between the
  // socket opening and "ready" is exactly when the app is already on screen and
  // the user can press Run. That reaches a sidecar whose kernel does not exist
  // yet, raises in the handler, and produces an error frame from a startup that
  // is otherwise perfectly healthy.
  const ready = expectOutcome("ready", ["sidecar.exit", "sidecar.disconnected"], {
    timeout: READY_TIMEOUT,
    what: "The Python sidecar",
  });

  // Error frames still carry the *reason* a fatal start failed, which is what
  // belongs on screen. Recorded rather than awaited, and attached to whatever
  // the wait actually rejects with.
  let reported = null;
  const offError = on("error", (frame) => {
    reported = frame;
  });

  try {
    await connect(announcement);
    return await ready.promise;
  } catch (error) {
    // Abandoning the wait would leave its subscriptions and timer alive, to
    // reject into nothing 90 seconds later.
    ready.cancel();
    if (reported === null) {
      throw error;
    }
    const where = reported.context === undefined ? "sidecar" : reported.context;
    throw new Error(`${error.message} — ${where}: ${reported.message ?? "no detail given"}`);
  } finally {
    offError();
  }
}

/**
 * Start a replacement sidecar after the previous one died.
 *
 * A sidecar crash - running out of memory tessellating something large is the
 * realistic one - used to cost the whole session: the kernel indicator went
 * dead and every action afterwards either threw or was ignored, with a
 * perfectly good editor buffer sitting there and no way back short of
 * restarting the application.
 *
 * The environment does not need rebuilding, so this skips straight to spawning:
 * ensureEnvironment has already run, and repeating it would mean a uv sync for
 * a restart that only needs a process.
 */
export async function restartSidecar() {
  if (launch === null) {
    throw new Error("The Python backend has not been started yet");
  }

  // A process that exited is already gone, but a socket that dropped does not
  // imply a dead process - and one left running would hold a kernel, a console
  // and a model socket that nothing can reach any more.
  if (sidecar !== null) {
    const previous = sidecar;
    sidecar = null; // before killing, so its exit is not reported as a failure
    try {
      await previous.kill();
    } catch (error) {
      log.warn("Could not stop the previous sidecar:", error);
    }
  }
  if (socket !== null) {
    const previous = socket;
    socket = null;
    try {
      previous.close();
    } catch {
      // Already gone.
    }
  }

  // Only "restarting" is announced. The panes need it to clear state that
  // belonged to the dead kernel; the *outcome* is what this function returns,
  // so a matching "restarted" frame would have no consumer and would earn an
  // "unhandled frame" warning on every recovery.
  dispatch({ type: "sidecar.restarting" });
  return startSidecar(launch);
}

/** Ask the sidecar to shut down, then close its stdin as a fallback. */
export async function stopSidecar() {
  if (sidecar === null) {
    return;
  }
  const process = sidecar;
  try {
    send("shutdown");
  } catch {
    // Already gone.
  }
  try {
    // Closing stdin is the signal the sidecar cannot miss, even if the socket
    // never came up or has already failed.
    await process.closeStdin();
  } catch {
    // Already gone.
  }
}
