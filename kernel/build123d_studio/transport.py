"""Delivery of models, mappings, configs and commands to the sidecar.

A loopback TCP connection to the port the sidecar is listening on, which it
passes down in the environment. The port is OS-assigned rather than configured,
so it cannot collide with anything - including a second copy of build123d-studio.

See sidecar/modelsock.py for the message layout and for why this is TCP on every
platform rather than a Unix socket here and a named pipe on Windows.

Four kinds of message go up this socket, and they are the ecosystem's own
numbers rather than a private vocabulary of ours - `MessageType` lives in
`ocp_viewer_core.comms` for exactly that reason:

    DATA     a tessellated model: a JSON header plus its raw buffers
    BACKEND  the id-to-shape mapping the measurement backend keeps
    CONFIG   a `ui` config block for the viewer that is already on screen
    COMMAND  a question, and the only kind that is answered

Only COMMAND gets a reply, and it arrives on the same connection before it
closes. That is the reply hop the show pipeline needs: `status` and
`workspace_config` are *reads*, made before any model is sent.
"""

import os
import socket
import struct

import orjson

# BRep shapes, locations and enums are not JSON. The mapping handed to the
# measurement backend is full of raw OCP objects and a config block can hold
# enums, so both need this - and it is the protocol's answer rather than any
# one transport's, which is why it is not in the websocket client.
from ocp_viewer_core.codec import default as ocp_json_default
from ocp_viewer_core.comms import MessageType

ENV_PORT = "BUILD123D_STUDIO_MODEL_PORT"
ENV_TOKEN = "BUILD123D_STUDIO_MODEL_TOKEN"

PREFIX = struct.Struct(">Q")
SHORT = struct.Struct(">H")
KIND = struct.Struct(">B")
LENGTH = struct.Struct(">I")

# A command is answered out of the sidecar's own memory - the last status the
# viewer pushed, or the settings file - so there is no browser in the path and
# no reason for this to take long. Long enough that a busy sidecar is not
# mistaken for a dead one, short enough that a show() cannot hang a kernel.
REPLY_TIMEOUT = 10

# Connecting is loopback to a listener that is already bound, so it is either
# immediate or it is not happening. This bounds the case a refused connection
# does not cover: a listen backlog that is full, which blocks rather than
# refusing.
CONNECT_TIMEOUT = 5

# Writing is bounded too, and this is the one that matters most since the core
# adoption: a show() now makes two blocking reads before it draws anything, so
# an unbounded write means a stalled sidecar stops Python rather than delaying a
# frame. Generous against the largest model measured here - 46 MB, which crosses
# loopback in a fraction of a second - because what this bounds is a sidecar
# that has stopped reading, not one that is reading slowly.
SEND_TIMEOUT = 30


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


def _encode(token, kind, body, payload):
    token_bytes = token.encode("ascii")
    body_bytes = orjson.dumps(body, default=ocp_json_default)

    message = b"".join(
        [
            SHORT.pack(len(token_bytes)),
            token_bytes,
            KIND.pack(int(kind)),
            LENGTH.pack(len(body_bytes)),
            body_bytes,
            payload,
        ]
    )
    return PREFIX.pack(len(message)) + message


def _connect(port):
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(CONNECT_TIMEOUT)
    try:
        connection.connect(("127.0.0.1", port))
    except socket.timeout as exc:
        # Named separately from a refusal because it is a different fault and a
        # different fix: nothing is listening is a viewer that has gone, and a
        # connect that hangs is one that is alive and not accepting.
        connection.close()
        raise NotConnected(
            f"build123d-studio's viewer did not accept a connection on port {port} "
            f"within {CONNECT_TIMEOUT} s"
        ) from exc
    except (ConnectionRefusedError, OSError) as exc:
        connection.close()
        raise NotConnected(
            f"build123d-studio's viewer is not accepting messages on port {port}"
        ) from exc
    return connection


def _send(kind, body, payload=b""):
    """Deliver one message. Blocks until the sidecar has taken it, or gives up.

    Bounded rather than blocking for ever, and the bound is what stops a stalled
    sidecar from stopping Python: every send here happens inside the user's
    show(), on the kernel's own thread, so a write nobody is reading is a
    notebook that never comes back.
    """
    port, token = _endpoint()
    connection = _connect(port)
    try:
        connection.settimeout(SEND_TIMEOUT)
        connection.sendall(_encode(token, kind, body, payload))
    except socket.timeout as exc:
        raise NotConnected(
            f"build123d-studio's viewer stopped reading after {SEND_TIMEOUT} s "
            "and the model was not delivered"
        ) from exc
    finally:
        connection.close()


def _receive_exactly(connection, count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = connection.recv(min(remaining, 1 << 20))
        if chunk == b"":
            raise NotConnected("build123d-studio closed the connection before answering")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def send_model(header, payload):
    """Deliver one tessellated model."""
    _send(MessageType.DATA, header, payload)


def send_mapping(mapping):
    """Deliver the id-to-shape mapping the measurement backend keeps."""
    _send(MessageType.BACKEND, mapping)


def send_config(config):
    """Deliver a `ui` config block to the viewer that is already on screen."""
    _send(MessageType.CONFIG, config)


def ask(request):
    """Send a command and return the sidecar's answer.

    The one message that is answered. The reply is a single length-prefixed
    JSON document written on the same connection, which then closes - so a
    command is one round trip and holds nothing open.
    """
    port, token = _endpoint()
    connection = _connect(port)
    try:
        connection.settimeout(REPLY_TIMEOUT)
        connection.sendall(_encode(token, MessageType.COMMAND, request, b""))
        length = LENGTH.unpack(_receive_exactly(connection, LENGTH.size))[0]
        return orjson.loads(_receive_exactly(connection, length))
    except socket.timeout as exc:
        # Which hop, in the sentence itself. A bare NotConnected here reads as
        # "there is no application", which is the one thing it is not: the
        # viewer is running and is not answering, and those have different
        # fixes.
        raise NotConnected(
            f"build123d-studio's viewer is not answering: {request.get('command')!r} "
            f"went unanswered for {REPLY_TIMEOUT} s"
        ) from exc
    finally:
        connection.close()
