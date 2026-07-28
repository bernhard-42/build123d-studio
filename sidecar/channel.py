"""The webview link: a WebSocket on a random loopback port.

The application has no fixed port anywhere - a hard-coded one (ocp_vscode's
3939, say) is what actually collides. This server binds port 0 and lets the OS
pick, then tells the frontend which port it got.

Bootstrap goes over stdout, because that is the one channel guaranteed to exist
before anything else does::

    frontend spawns sidecar  ->  sidecar binds 127.0.0.1:0
                             ->  prints {"port": N, "token": "..."} on stdout
                             ->  frontend connects, everything else over the socket

Unlike a pipe, a listening socket is reachable by any process on the machine, so
the connection carries a random token - the same measure Neutralino itself takes
for its own webview link.

Two frame types:

* text - JSON control messages, ``{"type": ..., ...}``
* binary - a 1-byte kind, a 4-byte big-endian header length, that many bytes of
  JSON header, then the raw payload

The binary form exists so tessellated geometry and pty output never have to be
base64-encoded. Keeping the payload at a known offset also means the webview can
build typed-array views straight over the received ArrayBuffer, with no copy.
"""

import json
import secrets
import struct
import sys
import threading
import traceback
from urllib.parse import urlparse, parse_qs

from websockets.sync.server import serve

# Kinds of binary frame.
KIND_CONSOLE = 1
KIND_MODEL = 2

# kind, 3 padding bytes, header length. The padding is not cosmetic: the
# webview builds Float32Array/Uint32Array views directly over the received
# ArrayBuffer, and a typed-array view throws unless its byte offset is a
# multiple of the element size. An 8-byte prefix plus a header padded to a
# multiple of 8 puts the payload on an 8-byte boundary every time.
HEADER_FORMAT = ">Bxxx I"
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)
ALIGNMENT = 8

# Tessellated models get large; do not let the library cap them.
MAX_MESSAGE = None


def log(*parts):
    """Log to stderr. stdout carries the handshake and nothing else."""
    print(*parts, file=sys.stderr, flush=True)


def pad_to_alignment(length):
    """Bytes of padding needed to reach the next ALIGNMENT boundary."""
    return (-length) % ALIGNMENT


def encode_binary(kind, payload, header=None, header_bytes=None):
    """Frame a binary message, keeping the payload 8-byte aligned.

    ``header_bytes`` accepts already-encoded JSON, so a header that arrived from
    the kernel can be forwarded without a decode/encode round trip.
    """
    if header_bytes is None:
        header_bytes = b"" if header is None else json.dumps(header).encode("utf-8")
    # The length on the wire is the true JSON length; the padding that follows
    # is implied by rounding up to ALIGNMENT, so the reader can slice the JSON
    # exactly and still find the payload on a boundary.
    padding = b"\0" * pad_to_alignment(len(header_bytes))
    return (
        struct.pack(HEADER_FORMAT, kind, len(header_bytes))
        + header_bytes
        + padding
        + payload
    )


class Channel:
    """WebSocket server for the single webview client."""

    def __init__(self):
        self._handlers = {}
        self._binary_handlers = {}
        self._connection = None
        self._send_lock = threading.Lock()
        self._connected = threading.Event()
        self._server = None
        self._rejection_logged = False
        self.port = None
        self.token = secrets.token_urlsafe(32)

    # --- registration ---

    def on(self, message_type, handler):
        """Register the handler for one text message type."""
        self._handlers[message_type] = handler

    def on_binary(self, kind, handler):
        """Register the handler for one binary frame kind."""
        self._binary_handlers[kind] = handler

    # --- lifecycle ---

    def start(self):
        """Bind, announce the port on stdout, and serve in the background."""
        self._server = serve(
            self._handle_connection,
            "127.0.0.1",
            0,
            max_size=MAX_MESSAGE,
            process_request=self._check_token,
        )
        port = self._server.socket.getsockname()[1]
        self.port = port

        threading.Thread(
            target=self._server.serve_forever, name="ws-server", daemon=True
        ).start()

        sys.stdout.write(
            json.dumps({"type": "listening", "port": port, "token": self.token}) + "\n"
        )
        sys.stdout.flush()
        log(f"Listening on 127.0.0.1:{port}")
        return port

    def wait_for_client(self, timeout=30):
        """Block until the webview connects, so no early output is lost."""
        if not self._connected.wait(timeout):
            raise TimeoutError("The webview did not connect")

    def close(self):
        if self._server is not None:
            self._server.shutdown()

    # --- sending ---

    def send(self, message_type, **payload):
        """Send a JSON control message. Safe to call from any thread."""
        self._send(json.dumps({"type": message_type, **payload}))

    def send_binary(self, kind, payload, header=None, header_bytes=None):
        """Send a binary frame. Safe to call from any thread."""
        self._send(encode_binary(kind, payload, header, header_bytes))

    def _send(self, data):
        with self._send_lock:
            connection = self._connection
            if connection is None:
                return
            try:
                connection.send(data)
            except Exception as exc:  # noqa: BLE001 - the UI may have gone away
                log(f"Send failed: {exc}")

    def error(self, context, exc):
        """Report a failure to the UI and to the log, without dying."""
        log(f"{context}: {exc}")
        traceback.print_exc(file=sys.stderr)
        self.send("error", context=context, message=str(exc))

    # --- receiving ---

    def _check_token(self, connection, request):
        """Reject unauthorised clients during the HTTP handshake.

        Deliberately here rather than in the handler. Closing an already-upgraded
        socket with code 1008 looks like a *successful* connection to the client,
        which then fails on its first recv - and ocp_vscode's config probe reads
        that as "viewer present but broken" and raises, instead of falling back
        to its defaults. Refusing before the upgrade gives a plain HTTP 403 and a
        clean, immediate failure.
        """
        query = parse_qs(urlparse(request.path).query)
        presented = query.get("token", [""])[0]
        # Constant-time compare: the token is the only thing standing between a
        # local process and the kernel.
        if secrets.compare_digest(presented, self.token):
            return None

        # Not necessarily an intrusion: ocp_vscode's viewer discovery is
        # deliberately pointed at this port so it fails here rather than
        # reaching someone else's viewer (see Kernel.kernel_environment), and
        # that probe lands on every show(). Log the first one so a real problem
        # stays visible, then stay quiet.
        if not self._rejection_logged:
            self._rejection_logged = True
            log("Refused an unauthorised connection (further ones not logged)")
        return connection.respond(403, "unauthorised\n")

    def _handle_connection(self, connection):
        log("Webview connected")
        self._connection = connection
        self._connected.set()

        try:
            for message in connection:
                self._dispatch(message)
        except Exception as exc:  # noqa: BLE001
            log(f"Connection closed: {exc}")
        finally:
            self._connection = None
            log("Webview disconnected")

    def _dispatch(self, message):
        if isinstance(message, bytes):
            self._dispatch_binary(message)
        else:
            self._dispatch_text(message)

    def _dispatch_text(self, message):
        try:
            frame = json.loads(message)
        except ValueError as exc:
            self.error("Malformed frame from the UI", exc)
            return

        message_type = frame.get("type")
        handler = self._handlers.get(message_type)
        if handler is None:
            log(f"No handler for message type {message_type!r}")
            return
        try:
            handler(frame)
        except Exception as exc:  # noqa: BLE001 - a bad frame must not kill the sidecar
            self.error(f"Handling {message_type!r}", exc)

    def _dispatch_binary(self, message):
        kind, header_length = struct.unpack_from(HEADER_FORMAT, message)
        payload_offset = HEADER_SIZE + header_length + pad_to_alignment(header_length)
        payload = message[payload_offset:]

        handler = self._binary_handlers.get(kind)
        if handler is None:
            log(f"No handler for binary kind {kind}")
            return
        try:
            handler(payload)
        except Exception as exc:  # noqa: BLE001
            self.error(f"Handling binary kind {kind}", exc)
