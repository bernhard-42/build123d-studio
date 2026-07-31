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
import time

from channel import log

PREFIX = struct.Struct(">Q")
SHORT = struct.Struct(">H")
LENGTH = struct.Struct(">I")

MAX_MESSAGE = 512 * 1024 * 1024

# The token is 32 bytes of secrets.token_urlsafe, so 43 characters. The cap is
# only here so that a declared token length cannot itself be used to make this
# read something large before anything has been checked.
MAX_TOKEN = 256

# Per-recv: a peer that stops talking mid-message gives up the connection.
SOCKET_TIMEOUT = 30

# And two bounds on whole connections, because a per-recv timeout bounds only a
# single recv: a client sending one byte every twenty-nine seconds resets it
# every time and holds the accept loop, which is serial, for as long as it
# likes. Every later show() then fails with a refused connection and no hint as
# to why.
#
# Two rather than one, because who is holding the loop matters. Until the token
# has been checked the peer is a stranger - any process on this machine can
# connect - and a stranger gets seconds, not minutes, because that number is
# exactly how long an unauthenticated process can stop the viewer working. After
# the token, it is our own kernel delivering a model, and the budget is generous:
# the largest measured here is 46 MB, which crosses loopback in a fraction of a
# second, so this is a limit on accident rather than on anything real.
HANDSHAKE_TIMEOUT = 5
MESSAGE_TIMEOUT = 120


def _receive_exactly(connection, count, deadline):
    """Read exactly count bytes, or give up at the deadline.

    The per-recv timeout alone is not a bound on the connection. A client that
    sends one byte every twenty-nine seconds resets it every time and holds the
    accept loop - which is serial - for as long as it likes, and every later
    show() then fails with a refused connection and no hint as to why. That is
    the same shape as the timeout that already exists, one level up: bounding
    each step bounds nothing about the whole.
    """
    chunks = []
    remaining = count
    while remaining > 0:
        budget = deadline - time.monotonic()
        if budget <= 0:
            raise TimeoutError(f"Gave up with {remaining} bytes still to come")
        # Whichever expires first: the idle timeout for a peer that has stopped
        # talking, the deadline for one that is talking too slowly to matter.
        connection.settimeout(min(SOCKET_TIMEOUT, budget))
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
        # The stranger's budget until the token proves otherwise.
        deadline = time.monotonic() + HANDSHAKE_TIMEOUT
        total = PREFIX.unpack(_receive_exactly(connection, PREFIX.size, deadline))[0]
        if total > MAX_MESSAGE:
            raise ValueError(f"Refusing a {total} byte model message")

        # The token is read and checked before anything else is read at all.
        #
        # This used to take the whole body first and check the token inside it,
        # which meant any process on the machine could make the sidecar allocate
        # up to half a gigabyte per connection attempt, repeatedly, without ever
        # presenting a credential. The module's own premise is that loopback
        # reachability is not authority, and buffering half a gigabyte on behalf
        # of an unauthenticated peer contradicted it.
        if total < SHORT.size:
            raise ValueError(f"Truncated model message: {total} bytes")
        token_length = SHORT.unpack(_receive_exactly(connection, SHORT.size, deadline))[0]
        if token_length > MAX_TOKEN or SHORT.size + token_length > total:
            raise ValueError(f"Refusing a model message declaring a {token_length} byte token")

        # Compared as bytes, never decoded. compare_digest on two str values
        # requires both to be ASCII-only, and decoding with "replace" is exactly
        # what produces a non-ASCII one: a single stray byte becomes U+FFFD and
        # the comparison raises TypeError, which this module then reported as
        # "Failed to read a model" - a bad token described as a broken kernel.
        token = _receive_exactly(connection, token_length, deadline)
        if not secrets.compare_digest(token, self.token.encode("ascii")):
            # Nothing beyond the token has been read, and nothing more will be.
            log("Rejected a model message with a bad token")
            return

        # Authenticated now, so the generous budget applies to the body.
        deadline = time.monotonic() + MESSAGE_TIMEOUT
        body = _receive_exactly(connection, total - SHORT.size - token_length, deadline)

        # Every length is checked against what is actually left. Trusting them
        # turned a truncated message into a confusing struct.error from
        # unpack_from rather than a statement about the message.
        cursor = 0

        def take(count, what):
            nonlocal cursor
            if cursor + count > len(body):
                raise ValueError(
                    f"Model message {what} runs past the end "
                    f"({cursor + count} > {len(body)} bytes)"
                )
            chunk = body[cursor : cursor + count]
            cursor += count
            return chunk

        header_length = LENGTH.unpack(take(LENGTH.size, "header length"))[0]
        header = take(header_length, "header")
        mapping_length = LENGTH.unpack(take(LENGTH.size, "mapping length"))[0]
        mapping = take(mapping_length, "mapping")

        self.on_model(header, mapping, body[cursor:])

    def stop(self):
        self._stop.set()
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
