// The binary frame format, both directions, in one place.
//
// This is half of a protocol whose other half is sidecar/channel.py, and the
// two have to agree exactly:
//
//   kind (uint8) | 3 pad | header length (uint32 BE) | header JSON | pad | payload
//
// The prefix is 8 bytes and the header is padded up to a multiple of 8, so the
// payload always starts on an 8-byte boundary. That is what makes it legal to
// build Float32Array/Uint32Array views straight over the received ArrayBuffer -
// a typed-array view throws if its byte offset is not a multiple of the element
// size. The length field is the true JSON length, with the padding implied.
//
// It lives apart from ipc.js so it can be tested. Decoding is the one place in
// the webview that reads attacker-shaped input - lengths off the wire, used to
// index a buffer - and the sidecar side was hardened for exactly that while
// this side was not. Every failure here is silent: it throws inside a
// WebSocket message handler, where the only thing that notices is the global
// rejection logger.

export const KIND_CONSOLE = 1;
export const KIND_MODEL = 2;

const FRAME_PREFIX = 8;
const ALIGNMENT = 8;

/** Round a length up to the next 8-byte boundary. */
export function alignUp(length) {
  return length + (((-length % ALIGNMENT) + ALIGNMENT) % ALIGNMENT);
}

/**
 * Decode a received frame.
 *
 * Returns {kind, header, payload, payloadOffset}, or null for anything that
 * does not describe a frame this application could have sent. Null rather than
 * a throw, because the caller is a WebSocket message handler: there is nobody
 * to catch it, and one malformed frame must not take the connection with it.
 *
 * Every length is checked against what is actually there. Trusting them turned
 * a truncated or hostile frame into a RangeError from a typed-array
 * constructor, which is a statement about JavaScript rather than about the
 * frame. This mirrors the bounds checks the sidecar side already has.
 *
 * @param {ArrayBuffer} buffer
 * @param {(message: string) => void} onProblem told why a frame was rejected
 */
export function decodeBinary(buffer, onProblem = () => {}) {
  if (!(buffer instanceof ArrayBuffer)) {
    onProblem(`Ignoring a binary frame that is not an ArrayBuffer: ${typeof buffer}`);
    return null;
  }
  if (buffer.byteLength < FRAME_PREFIX) {
    onProblem(`Ignoring a ${buffer.byteLength}-byte binary frame: shorter than the header`);
    return null;
  }

  const view = new DataView(buffer);
  const kind = view.getUint8(0);
  const headerLength = view.getUint32(4);
  const payloadOffset = FRAME_PREFIX + alignUp(headerLength);

  // Checked before the header is sliced as well as before the payload is: a
  // declared length can exceed the frame on its own, and the padded offset can
  // overflow past it even when the header itself fits.
  if (FRAME_PREFIX + headerLength > buffer.byteLength || payloadOffset > buffer.byteLength) {
    onProblem(
      `Ignoring a binary frame claiming a ${headerLength}-byte header ` +
        `in ${buffer.byteLength} bytes`,
    );
    return null;
  }

  let header = {};
  if (headerLength > 0) {
    const bytes = new Uint8Array(buffer, FRAME_PREFIX, headerLength);
    try {
      header = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      onProblem(`Ignoring a binary frame whose header is not JSON: ${error.message}`);
      return null;
    }
  }

  // A view, not a copy - the whole point of the binary frame.
  return { kind, header, payload: new Uint8Array(buffer, payloadOffset), payloadOffset };
}

/**
 * Encode a frame to send.
 *
 * @param {number} kind
 * @param {Uint8Array|ArrayBuffer} payload
 * @param {object|null} header
 */
export function encodeBinary(kind, payload, header = null) {
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
  return frame;
}
