"""Turn ocp_tessellate's base64 arrays back into one contiguous payload.

``ocp_tessellate.utils.numpy_to_buffer_json`` already ravels every array into a
contiguous C buffer - it then base64-encodes it and wraps it in JSON, because it
was written for a websocket that carries text.

That encoding is pure overhead here. The webview wants exactly what numpy had in
the first place: flat buffers it can wrap in Float32Array/Uint32Array views.
three-cad-viewer's ShapeBinary format is precisely that.

So each ``{"buffer": <base64>, "codec": "b64"}`` node is replaced by an
``{"offset", "length"}`` reference into a single payload block, and the block is
sent as binary. The webview then builds typed-array views over it without
copying or parsing anything numeric.

One base64 decode happens here, which is unavoidable without reimplementing
``_convert``'s tail - and at roughly a gigabyte a second it is far cheaper than
the JSON parse it saves on the other side.
"""

import base64

# Every array starts on an 8-byte boundary. Float64Array is the widest type
# three-cad-viewer can ask for, and a typed-array view throws if its byte offset
# is not a multiple of the element size.
ALIGNMENT = 8


def _pad(length):
    return (-length) % ALIGNMENT


def split_buffers(node, blocks=None, offset=0):
    """Walk the tessellation tree, extracting array buffers.

    :returns: ``(node_without_buffers, payload_bytes)``
    """
    top_level = blocks is None
    if top_level:
        blocks = []

    def walk(value, cursor):
        if isinstance(value, dict):
            if value.get("codec") == "b64" and "buffer" in value:
                raw = base64.b64decode(value["buffer"])
                blocks.append(raw)
                reference = {
                    "shape": value.get("shape"),
                    "dtype": value.get("dtype"),
                    "codec": "raw",
                    "offset": cursor,
                    "length": len(raw),
                }
                cursor += len(raw)
                padding = _pad(cursor)
                if padding:
                    blocks.append(b"\0" * padding)
                    cursor += padding
                return reference, cursor

            result = {}
            for key, item in value.items():
                result[key], cursor = walk(item, cursor)
            return result, cursor

        if isinstance(value, (list, tuple)):
            items = []
            for item in value:
                converted, cursor = walk(item, cursor)
                items.append(converted)
            return items, cursor

        return value, cursor

    converted, _ = walk(node, offset)
    return converted, b"".join(blocks)
