// Rebuild ocp_tessellate's arrays as typed-array views over the received frame.
//
// The sidecar delivers the tessellation as a JSON header describing each array
// - dtype, shape, and an {offset, length} into a single binary payload - plus
// that payload as raw bytes. Nothing here copies: each array becomes a view
// straight onto the WebSocket frame's ArrayBuffer, which is exactly the form
// three-cad-viewer's ShapeBinary wants.
//
// The dtype mapping deliberately matches three-cad-viewer's own decodeBuffer,
// including its treatment of int32 as Uint32Array: ocp_tessellate emits signed
// triangle indices, and the viewer feeds them to three.js as unsigned.

const CONSTRUCTORS = {
  float32: Float32Array,
  float64: Float64Array,
  int32: Uint32Array,
  uint32: Uint32Array,
  uint8: Uint8Array,
};

function isBufferRef(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.codec === "raw" &&
    typeof value.offset === "number" &&
    typeof value.length === "number"
  );
}

function viewOf(reference, buffer, payloadOffset) {
  const Constructor = CONSTRUCTORS[reference.dtype];
  if (Constructor === undefined) {
    throw new Error(`Unsupported dtype from the tessellator: ${reference.dtype}`);
  }
  const byteOffset = payloadOffset + reference.offset;
  if (byteOffset % Constructor.BYTES_PER_ELEMENT !== 0) {
    // Should be impossible - the sidecar pads every array to an 8-byte
    // boundary - but a silent copy here would hide a framing regression.
    throw new Error(
      `Array at offset ${byteOffset} is not aligned for ${reference.dtype}`,
    );
  }
  return new Constructor(buffer, byteOffset, reference.length / Constructor.BYTES_PER_ELEMENT);
}

/** Replace every buffer reference in the tree with a typed-array view. */
export function rehydrate(node, buffer, payloadOffset) {
  if (isBufferRef(node)) {
    return viewOf(node, buffer, payloadOffset);
  }
  if (Array.isArray(node)) {
    return node.map((item) => rehydrate(item, buffer, payloadOffset));
  }
  if (typeof node === "object" && node !== null) {
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = rehydrate(value, buffer, payloadOffset);
    }
    return result;
  }
  return node;
}
