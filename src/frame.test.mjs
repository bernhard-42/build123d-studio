// node --test src/frame.test.mjs
//
// The binary frame is the one place in the webview that reads lengths off the
// wire and uses them to index a buffer. Every failure is silent - it throws
// inside a WebSocket message handler, where nothing catches it - so the frames
// that break it have to be constructed here rather than waited for.
//
// The round trip is the important half: this codec has a counterpart in
// sidecar/channel.py, and the two agreeing is what makes the whole binary path
// work. What is asserted below is the wire format itself, not just that encode
// and decode are inverses, because two matching mistakes would satisfy that.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { alignUp, decodeBinary, encodeBinary, KIND_CONSOLE, KIND_MODEL } from "./frame.js";

/** The bytes of an encoded frame, as an ArrayBuffer the decoder would receive. */
function wire(kind, payload, header = null) {
  const frame = encodeBinary(kind, payload, header);
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
}

const silent = () => {};

test("alignUp rounds to the next 8-byte boundary", () => {
  assert.equal(alignUp(0), 0);
  assert.equal(alignUp(1), 8);
  assert.equal(alignUp(8), 8);
  assert.equal(alignUp(9), 16);
  assert.equal(alignUp(120), 120);
});

test("a frame round-trips with its header and payload intact", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = decodeBinary(wire(KIND_MODEL, payload, { type: "data", count: 3 }), silent);

  assert.equal(frame.kind, KIND_MODEL);
  assert.deepEqual(frame.header, { type: "data", count: 3 });
  assert.deepEqual([...frame.payload], [1, 2, 3, 4, 5]);
});

test("a frame with no header round-trips too", () => {
  const frame = decodeBinary(wire(KIND_CONSOLE, new TextEncoder().encode("ls\r")), silent);
  assert.equal(frame.kind, KIND_CONSOLE);
  assert.deepEqual(frame.header, {});
  assert.equal(new TextDecoder().decode(frame.payload), "ls\r");
});

test("the payload always starts on an 8-byte boundary", () => {
  // This is the property the whole format exists for: the viewer builds
  // Float32Array views straight over the received buffer, and a typed-array
  // view throws unless its byte offset is a multiple of the element size.
  for (let size = 0; size < 40; size += 1) {
    const header = { pad: "x".repeat(size) };
    const frame = decodeBinary(wire(KIND_MODEL, new Uint8Array(8), header), silent);
    assert.equal(frame.payloadOffset % 8, 0, `header of ${size} x's misaligned the payload`);
    // And the view can actually be built, which is the thing that matters.
    assert.doesNotThrow(() => new Float32Array(frame.payload.buffer, frame.payloadOffset, 2));
  }
});

test("the wire layout matches sidecar/channel.py", () => {
  // Encoded by hand from the format in channel.py rather than from this
  // module's own code: kind, three pad bytes, big-endian header length.
  const frame = encodeBinary(KIND_MODEL, new Uint8Array([0xaa]), { a: 1 });
  const header = JSON.stringify({ a: 1 });

  assert.equal(frame[0], KIND_MODEL);
  assert.deepEqual([...frame.slice(1, 4)], [0, 0, 0], "three padding bytes");
  const view = new DataView(frame.buffer, frame.byteOffset);
  assert.equal(view.getUint32(4), header.length, "big-endian header length");
  assert.equal(new TextDecoder().decode(frame.slice(8, 8 + header.length)), header);
  assert.equal(frame[frame.length - 1], 0xaa, "payload last");
});

test("a frame shorter than the header is refused, not thrown on", () => {
  for (const size of [0, 1, 7]) {
    const problems = [];
    assert.equal(decodeBinary(new ArrayBuffer(size), (p) => problems.push(p)), null);
    assert.equal(problems.length, 1, `${size} bytes should be reported once`);
  }
});

test("a header length past the end of the frame is refused", () => {
  // The hostile case: a length field that does not describe this frame. It used
  // to reach `new Uint8Array(buffer, 8, headerLength)` and throw a RangeError
  // out of the WebSocket handler.
  const buffer = new ArrayBuffer(16);
  new DataView(buffer).setUint32(4, 0xffffffff);

  const problems = [];
  assert.equal(decodeBinary(buffer, (p) => problems.push(p)), null);
  assert.match(problems[0], /claiming a 4294967295-byte header/);
});

test("a header that fits but whose padding does not is refused", () => {
  // 9 bytes of header fits in a 24-byte frame, but the payload offset is then
  // 8 + 16 = 24 - and one more byte would be past the end. The check has to
  // look at the padded offset, not only at the header.
  const buffer = new ArrayBuffer(20);
  new DataView(buffer).setUint32(4, 9);
  assert.equal(decodeBinary(buffer, silent), null);
});

test("a header that is not JSON is refused rather than thrown on", () => {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  view.setUint32(4, 3);
  new Uint8Array(buffer).set(new TextEncoder().encode("{{{"), 8);

  const problems = [];
  assert.equal(decodeBinary(buffer, (p) => problems.push(p)), null);
  assert.match(problems[0], /not JSON/);
});

test("something that is not an ArrayBuffer at all is refused", () => {
  for (const value of [null, undefined, "text", new Uint8Array(16)]) {
    assert.equal(decodeBinary(value, silent), null, `${typeof value} must be refused`);
  }
});

test("an empty payload is a frame, not an error", () => {
  const frame = decodeBinary(wire(KIND_CONSOLE, new Uint8Array(0)), silent);
  assert.equal(frame.payload.length, 0);
});
