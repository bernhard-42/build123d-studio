"""Delivery of tessellated models from the kernel to the sidecar.

A loopback TCP connection to the port the sidecar is listening on, which it
passes down in the environment. The port is OS-assigned rather than configured,
so it cannot collide with anything - including a second copy of build123d-studio.

See sidecar/modelsock.py for the message layout and for why this is TCP on every
platform rather than a Unix socket here and a named pipe on Windows.
"""

import os
import socket
import struct

import orjson

# ocp_vscode's JSON fallback: it serialises TopoDS shapes to base64 BRep,
# locations to (translation, quaternion) and enums to their values. The mapping
# handed to the measurement backend is full of raw OCP objects, and the config
# in the header can hold enums, so both need it.
from ocp_vscode.comms import default as ocp_json_default

ENV_PORT = "BUILD123D_STUDIO_MODEL_PORT"
ENV_TOKEN = "BUILD123D_STUDIO_MODEL_TOKEN"

PREFIX = struct.Struct(">Q")
SHORT = struct.Struct(">H")
LENGTH = struct.Struct(">I")


class NotConnected(RuntimeError):
    """Raised when show() is called outside a running build123d-studio."""


def _endpoint():
    port = os.environ.get(ENV_PORT)
    token = os.environ.get(ENV_TOKEN)
    if port is None or port == "" or token is None:
        raise NotConnected(
            "build123d-studio is not running: show() needs the application's viewer. "
            f"({ENV_PORT} is not set in this kernel.)"
        )
    return int(port), token


def _encode(token, header, mapping, payload):
    token_bytes = token.encode("ascii")
    header_bytes = orjson.dumps(header, default=ocp_json_default)
    mapping_bytes = orjson.dumps(mapping, default=ocp_json_default)

    body = b"".join(
        [
            SHORT.pack(len(token_bytes)),
            token_bytes,
            LENGTH.pack(len(header_bytes)),
            header_bytes,
            LENGTH.pack(len(mapping_bytes)),
            mapping_bytes,
            payload,
        ]
    )
    return PREFIX.pack(len(body)) + body


def send_model(header, mapping, payload):
    """Deliver one tessellated model. Blocks until the sidecar has taken it."""
    port, token = _endpoint()
    message = _encode(token, header, mapping, payload)

    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        connection.connect(("127.0.0.1", port))
    except (ConnectionRefusedError, OSError) as exc:
        raise NotConnected(
            f"build123d-studio's viewer is not accepting models on port {port}"
        ) from exc
    try:
        connection.sendall(message)
    finally:
        connection.close()
