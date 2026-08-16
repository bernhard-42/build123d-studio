"""The model channel, and the two properties threading it had to keep.

The channel used to read and deliver each message on the accept loop itself, so
a message nobody could deliver was a listener nobody could reach. That matters
because of what the shared show pipeline does now: every show *asks* first -
`status` and `workspace_config` are reads, before a model is sent - so a command
that queues behind the previous show's model delays every frame drawn.

Threading it back is easy and losing the order is easier, hence both tests here:
a command must be answered while a model is stuck, and the model stream must
still arrive in the order it was sent, because a mapping that overtook its own
model would describe the wrong one.

The wire format is written out by hand rather than imported from the kernel's
transport, deliberately: the two ends agreeing with each other proves nothing
about either, and importing `build123d_studio` here would drag OCP in behind it.
"""

import socket
import struct
import threading
import time
import unittest

import orjson
from ocp_viewer_core.comms import MessageType

from modelsock import ModelSocket

PREFIX = struct.Struct(">Q")
SHORT = struct.Struct(">H")
KIND = struct.Struct(">B")
LENGTH = struct.Struct(">I")


def encode(token, kind, body, payload=b""):
    token_bytes = token.encode("ascii")
    body_bytes = orjson.dumps(body)
    message = b"".join([
        SHORT.pack(len(token_bytes)),
        token_bytes,
        KIND.pack(int(kind)),
        LENGTH.pack(len(body_bytes)),
        body_bytes,
        payload,
    ])
    return PREFIX.pack(len(message)) + message


class ModelSocketTest(unittest.TestCase):
    def setUp(self):
        self.delivered = []
        self.holding = threading.Event()
        self.let_go = threading.Event()

        self.socket = ModelSocket(
            on_model=self._on_model,
            on_mapping=lambda document: self.delivered.append(("mapping", document)),
            on_config=lambda config: self.delivered.append(("config", config)),
            on_command=lambda request: {"answered": request.get("command")},
        )
        self.port = self.socket.start()
        self.addCleanup(self.socket.stop)
        self.addCleanup(self.let_go.set)

    def _on_model(self, document, payload):
        self.delivered.append(("model", document, payload))
        # Only the model blocks, and only while a test says so: this stands in
        # for the webview being busy, which is the one thing delivery waits on.
        if not self.let_go.is_set():
            self.holding.set()
            self.let_go.wait(20)

    def send(self, kind, body, payload=b"", expect_reply=False):
        connection = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        try:
            connection.sendall(encode(self.socket.token, kind, body, payload))
            if not expect_reply:
                return None
            length = LENGTH.unpack(_exactly(connection, LENGTH.size))[0]
            return orjson.loads(_exactly(connection, length))
        finally:
            connection.close()

    def test_a_command_is_answered_while_a_model_is_stuck(self):
        threading.Thread(
            target=self.send, args=(MessageType.DATA, {"header": 1}, b"buffers"), daemon=True
        ).start()
        self.assertTrue(self.holding.wait(10), "the model was never delivered")

        # The whole point: this is a *read* the next show makes, and the model in
        # front of it may take as long as the webview takes.
        started = time.monotonic()
        answer = self.send(MessageType.COMMAND, {"command": "status"}, expect_reply=True)
        waited = time.monotonic() - started

        self.assertEqual(answer, {"answered": "status"})
        self.assertLess(waited, 5, f"the command waited {waited:.1f}s behind the model")

    def test_the_model_stream_keeps_its_order(self):
        self.let_go.set()
        for index in range(4):
            self.send(MessageType.DATA, {"show": index}, b"")
            self.send(MessageType.BACKEND, {"mapping": index})
            self.send(MessageType.CONFIG, {"config": index})

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and len(self.delivered) < 12:
            time.sleep(0.02)

        kinds = [entry[0] for entry in self.delivered]
        self.assertEqual(kinds, ["model", "mapping", "config"] * 4)
        shows = [orjson.loads(entry[1])["show"] for entry in self.delivered if entry[0] == "model"]
        self.assertEqual(shows, [0, 1, 2, 3])

    def test_it_says_what_it_is_doing(self):
        # The stall report reads this, and it is the difference between "the
        # show is waiting on the kernel" and "the show is waiting on the window".
        threading.Thread(
            target=self.send, args=(MessageType.DATA, {"header": 1}, b""), daemon=True
        ).start()
        self.assertTrue(self.holding.wait(10))

        state = self.socket.state()
        self.assertTrue(state["listening"])
        self.assertEqual(state["queued"], 0)

    def test_a_bad_token_is_refused_without_reading_the_body(self):
        # Unchanged by the threading, and worth holding: any process on this
        # machine can connect.
        connection = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        self.addCleanup(connection.close)
        connection.sendall(encode("not-the-token", MessageType.CONFIG, {"config": 1}))
        time.sleep(0.5)
        self.assertEqual(self.delivered, [])


def _exactly(connection, count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = connection.recv(remaining)
        if chunk == b"":
            raise AssertionError("the model channel closed before answering")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


if __name__ == "__main__":
    unittest.main()
