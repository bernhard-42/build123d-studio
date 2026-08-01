"""Machinery the sidecar's unit tests share.

These tests reach the sidecar's classes directly, which is the whole reason they
exist alongside tests/integration.py: that one drives the process from outside
the way the webview does, so it can only assert on what crosses the socket. It
cannot see which kernel generation a retired pump is holding, or whether a write
landed on a descriptor that has stopped meaning the pty, and those are precisely
the things Phase 3 is about.

Nothing here patches the code under test. Where a race has to be made reliable,
it is widened through a seam the production code already has - a slow handler, a
client that blocks where a real one would, a descriptor deliberately recycled -
so what runs in the test is the shipped control flow with the timing changed,
not a different program.
"""

import contextlib
import io
import struct
import sys
import threading
import time

from websockets.sync.client import connect

from channel import HEADER_FORMAT, Channel, pad_to_alignment

# How long a test waits for something that should be immediate. Generous enough
# that a loaded CI machine does not fail it, short enough that a genuine hang
# does not look like a slow pass.
SETTLE = 5.0


class Recorder:
    """Somewhere for a handler to record that it ran, and in which order."""

    def __init__(self):
        self.calls = []
        self._lock = threading.Lock()
        self._arrived = threading.Event()

    def record(self, value):
        with self._lock:
            self.calls.append(value)
        self._arrived.set()

    def seen(self):
        with self._lock:
            return list(self.calls)

    def wait_for(self, count, timeout=SETTLE):
        """Block until at least ``count`` calls have been recorded."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if len(self.seen()) >= count:
                return True
            time.sleep(0.01)
        return False

    def quiet_for(self, seconds):
        """True if nothing was recorded during the wait.

        The counterpart to wait_for, for the assertions that are about something
        *not* happening - a frame the channel was supposed to refuse, a handler
        that must not have been reached.
        """
        before = len(self.seen())
        time.sleep(seconds)
        return len(self.seen()) == before


class CapturedLog:
    """Collect the sidecar's stderr log while a test runs.

    channel.log resolves sys.stderr at call time, so redirecting it catches the
    log written by the server's own threads as well as by this one. Used only
    where the log is the sole evidence - a frame the channel refuses leaves no
    other trace, by design - and never in place of asserting on behaviour.
    """

    def __init__(self):
        self._buffer = io.StringIO()
        self._redirect = None

    def __enter__(self):
        self._redirect = contextlib.redirect_stderr(self._buffer)
        self._redirect.__enter__()
        return self

    def __exit__(self, *exc_info):
        return self._redirect.__exit__(*exc_info)

    def text(self):
        return self._buffer.getvalue()

    def wait_for(self, needle, timeout=SETTLE):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in self.text():
                return True
            time.sleep(0.01)
        return False


class ChannelHarness:
    """A real Channel, on a real loopback port, with real websocket clients.

    Not a mock of the protocol. Every one of the defects these tests cover was
    in the handling of bytes that actually arrived - a frame shorter than its
    header, a length that overran the buffer, a second client - so the bytes
    have to actually arrive.
    """

    def __init__(self):
        self.channel = Channel()
        self._clients = []

    def start(self):
        # bind() announces its port on stdout, because that is the frontend's
        # handshake and stdout carries nothing else. Here it is noise, and
        # letting it through would corrupt unittest's own output.
        with contextlib.redirect_stdout(io.StringIO()):
            self.channel.bind()
        self.channel.accept()
        return self

    def connect(self, token=None, wait=True):
        """Open a client, the way the webview does.

        ``wait`` is the handshake: the client's connect() returns as soon as the
        upgrade completes, which is before the server's handler has recorded the
        connection. Waiting for that here keeps every test that follows free of
        the race.
        """
        presented = self.channel.token if token is None else token
        client = connect(
            f"ws://127.0.0.1:{self.channel.port}/?token={presented}",
            # No cap, matching the server and the browser.
            max_size=None,
            open_timeout=SETTLE,
        )
        self._clients.append(client)
        if wait:
            self.channel.wait_for_client(timeout=SETTLE)
        return client

    def close(self):
        for client in self._clients:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - a test that already failed may have closed it
                pass
        self._clients.clear()
        self.channel.close()


def binary_frame(kind, header_bytes=b"", payload=b"", claimed_header_length=None):
    """Build a binary frame, with the option of lying about the header length.

    ``claimed_header_length`` is what makes this useful for the hardening tests:
    a frame whose header length does not describe its own contents is exactly
    what the webview must never be trusted to get right, and what the sidecar
    used to index a buffer with unchecked.
    """
    declared = len(header_bytes) if claimed_header_length is None else claimed_header_length
    padding = b"\0" * pad_to_alignment(len(header_bytes))
    return struct.pack(HEADER_FORMAT, kind, declared) + header_bytes + padding + payload


def alive(client, recorder, timeout=SETTLE):
    """True if the session still works, asked by using it.

    The property every hardening test needs is not "no exception was raised" but
    "the connection is still there afterwards" - a malformed frame used to be
    indistinguishable from the webview going away, and the session died with it.
    The only honest way to ask is to send another frame and see it handled.
    """
    before = len(recorder.seen())
    client.send('{"type": "ping"}')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if len(recorder.seen()) > before:
            return True
        time.sleep(0.01)
    return False


def is_windows():
    return sys.platform == "win32"
