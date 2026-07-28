"""Receives tessellated models from the kernel.

Counterpart to kernel/build123d_studio/transport.py.

A loopback TCP listener on an OS-assigned port, on every platform. This was a
Unix domain socket, which was tidy on macOS and Linux and simply did not exist on
Windows - the named-pipe server was never written, so show() could not have
worked there at all. One mechanism that works everywhere beats two, one of which
is missing.

The port is never configured, so it cannot collide; the sidecar picks it up from
the OS and passes it to the kernel in the environment. Because any local process
could otherwise connect and push a model into the viewer, each message carries a
random token, compared in constant time.

Message layout, all lengths big-endian::

    uint64 total length of everything that follows
    uint16 token length   | token
    uint32 header length  | header JSON   -> forwarded to the viewer
    uint32 mapping length | mapping JSON  -> kept by the measurement backend
    payload                              -> raw tessellation buffers

The split matters: ``mapping`` carries serialised BRep shapes that only the
measurement backend needs, and shipping them to the webview would roughly double
the traffic for data it cannot use.
"""

import secrets
import socket
import struct
import threading

from channel import log

PREFIX = struct.Struct(">Q")
SHORT = struct.Struct(">H")
LENGTH = struct.Struct(">I")

MAX_MESSAGE = 512 * 1024 * 1024


def _receive_exactly(connection, count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = connection.recv(min(remaining, 1 << 20))
        if chunk == b"":
            raise ConnectionError("The kernel closed the connection early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class ModelSocket:
    """Listens for models and hands each to a callback."""

    def __init__(self, on_model):
        self.on_model = on_model
        self.port = None
        self.token = secrets.token_urlsafe(32)

        self._server = None
        self._thread = None
        self._stop = threading.Event()

    def start(self):
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(4)
        self.port = self._server.getsockname()[1]

        self._thread = threading.Thread(target=self._serve, name="modelsock", daemon=True)
        self._thread.start()
        log(f"Model channel listening on 127.0.0.1:{self.port}")
        return self.port

    def _serve(self):
        while not self._stop.is_set():
            try:
                connection, _ = self._server.accept()
            except OSError:
                if not self._stop.is_set():
                    log("Model channel accept failed")
                return
            try:
                self._read_model(connection)
            except Exception as exc:  # noqa: BLE001 - one bad model must not stop the server
                log(f"Failed to read a model: {exc}")
            finally:
                connection.close()

    def _read_model(self, connection):
        total = PREFIX.unpack(_receive_exactly(connection, PREFIX.size))[0]
        if total > MAX_MESSAGE:
            raise ValueError(f"Refusing a {total} byte model message")
        body = _receive_exactly(connection, total)

        cursor = 0
        token_length = SHORT.unpack_from(body, cursor)[0]
        cursor += SHORT.size
        token = body[cursor : cursor + token_length].decode("ascii", "replace")
        cursor += token_length

        if not secrets.compare_digest(token, self.token):
            log("Rejected a model message with a bad token")
            return

        header_length = LENGTH.unpack_from(body, cursor)[0]
        cursor += LENGTH.size
        header = body[cursor : cursor + header_length]
        cursor += header_length

        mapping_length = LENGTH.unpack_from(body, cursor)[0]
        cursor += LENGTH.size
        mapping = body[cursor : cursor + mapping_length]
        cursor += mapping_length

        self.on_model(header, mapping, body[cursor:])

    def stop(self):
        self._stop.set()
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
