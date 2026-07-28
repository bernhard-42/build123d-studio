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

export const KIND_CONSOLE = 1;
export const KIND_MODEL = 2;

const FRAME_PREFIX = 8;
const ALIGNMENT = 8;

function alignUp(length) {
  return length + ((-length % ALIGNMENT) + ALIGNMENT) % ALIGNMENT;
}

const handlers = new Map();
const binaryHandlers = new Map();

let socket = null;
let sidecar = null;
let handshakeBuffer = "";

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
  const view = new DataView(buffer);
  const kind = view.getUint8(0);
  const headerLength = view.getUint32(4);
  const payloadOffset = FRAME_PREFIX + alignUp(headerLength);

  let header = {};
  if (headerLength > 0) {
    const bytes = new Uint8Array(buffer, FRAME_PREFIX, headerLength);
    header = JSON.parse(new TextDecoder().decode(bytes));
  }
  // A view, not a copy - the whole point of the binary frame.
  const payload = new Uint8Array(buffer, payloadOffset);

  const listener = binaryHandlers.get(kind);
  if (listener === undefined) {
    log.warn("Unhandled binary frame kind:", kind);
    return;
  }
  try {
    listener(payload, header, buffer, payloadOffset);
  } catch (error) {
    log.error(`Binary handler for kind ${kind} failed:`, error);
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

/** Wait for a single message of the given type. */
export function once(type) {
  return new Promise((resolve) => {
    const off = on(type, (frame) => {
      off();
      resolve(frame);
    });
  });
}

/**
 * Wait for whichever of these message types arrives first.
 *
 * For request/response pairs where the response can be either an outcome or a
 * failure: awaiting only the success message means a failure hangs the caller
 * for the rest of the session, with nothing on screen to say so.
 */
export function onceOf(...types) {
  return new Promise((resolve) => {
    const offs = [];
    const settle = (frame) => {
      for (const off of offs) {
        off();
      }
      resolve(frame);
    };
    for (const type of types) {
      offs.push(on(type, settle));
    }
  });
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
  const headerBytes =
    header === null ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(header));
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const payloadOffset = FRAME_PREFIX + alignUp(headerBytes.length);

  const frame = new Uint8Array(payloadOffset + body.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, kind);
  view.setUint32(4, headerBytes.length);
  frame.set(headerBytes, FRAME_PREFIX);
  frame.set(body, payloadOffset);

  socket.send(frame);
}

export function isConnected() {
  return socket !== null && socket.readyState === WebSocket.OPEN;
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
      reject(new Error(`Unexpected handshake: ${line.slice(0, 200)}`));
      return;
    }
    resolve(announcement);
  } catch (error) {
    reject(new Error(`Malformed handshake: ${line.slice(0, 200)} (${error.message})`));
  }
}

function connect({ port, token }) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    socket = new WebSocket(url);
    // Binary frames as ArrayBuffer, so views can be built over them directly.
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      log.info("Connected to sidecar on port", port);
      resolve();
    };
    socket.onerror = () => reject(new Error(`Could not connect to the sidecar on port ${port}`));
    socket.onmessage = (event) => {
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
    socket.onclose = (event) => {
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
  const command =
    `${quote(python)} ${quote(`${appDir}/sidecar/main.py`)}` +
    ` --env-root ${quote(envRoot)} --app-dir ${quote(appDir)}`;

  log.info("Starting sidecar:", command);

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
          log.warn("Sidecar exited with code", code);
          sidecar = null;
          dispatch({ type: "sidecar.exit", code });
        });
      })
      .catch(reject);
  });

  await connect(announcement);
  return once("ready");
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
