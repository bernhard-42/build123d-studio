"""What the sidecar does with frames the webview should never have sent.

The webview is not a trusted peer. It is a browser engine running code that a
bug, a half-written feature or a partially received buffer can make lie about a
length - and the socket it connects on is reachable by any process on the
machine, which is why there is a token at all. Every value read off that wire is
therefore input, and this file is about the three that used to be believed.

Three of these reproduce a defect. Checked out against `0567fba^`, the commit
before "Harden the sidecar's failure paths":

* a binary frame shorter than its own header killed the session outright.
  struct.unpack_from raised, the raise landed in the receive loop's `except` -
  the one that means "the connection ended" - and a three-byte frame was
  indistinguishable from the webview going away. Everything went with it: the
  console, the variable explorer, Restart Kernel.
* a header length larger than the frame was used to slice the buffer anyway.
  Python's slicing does not object, so the handler was called with an empty
  payload as though that were the message. A refusal and a silent empty
  delivery are not the same answer.
* a second connection replaced the live one, and the *first* one's cleanup then
  nulled the second's reference on its way out - leaving a connected client that
  nothing could be sent to.

The rest lock properties that already held. They are marked as such: a test that
passes against the code it was meant to catch proves nothing, and pretending
otherwise is how a suite starts measuring its own existence.

Handlers here are registered inline, without lanes. That is deliberate and it is
what lets the first three be checked against `0567fba^` at all, because lanes
arrived later in `3558032` and `on()` did not take the argument yet.
"""

import json
import struct
import threading
import unittest

from channel import HEADER_SIZE, KIND_CONSOLE
from support import SETTLE, CapturedLog, ChannelHarness, Recorder, alive, binary_frame

# A kind nothing registers a handler for.
KIND_UNKNOWN = 99


class ChannelProtocolTest(unittest.TestCase):
    def setUp(self):
        self.harness = ChannelHarness()
        self.text = Recorder()
        self.binary = Recorder()
        self.harness.channel.on("ping", lambda frame: self.text.record(frame["type"]))
        self.harness.channel.on_binary(KIND_CONSOLE, self.binary.record)
        self.harness.start()
        self.addCleanup(self.harness.close)

    # --- reproduces a defect ---

    def test_a_binary_frame_shorter_than_its_header_does_not_end_the_session(self):
        # The property first, the mechanism second, and the order is deliberate.
        # Refusing the frame is how it works; keeping the session is what was
        # lost, and asserting the log line first would report a missing message
        # while saying nothing about the socket that died with it.
        client = self.harness.connect()
        with CapturedLog() as log:
            client.send(b"\x01\x02")
            self.assertTrue(alive(client, self.text), "the session died with the bad frame")
            self.assertTrue(
                log.wait_for("shorter than the header"),
                "the frame should have been refused by length, and said so",
            )

    def test_a_header_longer_than_the_frame_is_refused_rather_than_delivered_empty(self):
        client = self.harness.connect()
        # Eight bytes of frame claiming a megabyte of header. Slicing past the
        # end yields b"", which is why this was silent instead of loud.
        with CapturedLog() as log:
            client.send(binary_frame(KIND_CONSOLE, claimed_header_length=1 << 20))
            self.assertTrue(
                self.binary.quiet_for(0.2),
                f"the handler was reached anyway, with {self.binary.seen()!r}",
            )
            self.assertTrue(alive(client, self.text))
            self.assertTrue(log.wait_for("claiming a 1048576-byte header"))

    def test_a_second_webview_connection_is_refused_and_the_first_keeps_working(self):
        first = self.harness.connect()

        # wait=False: the server never records this one, so waiting for it to be
        # the connected client would time out - which is the point.
        second = self.harness.connect(wait=False)
        with self.assertRaises(Exception) as refused:
            second.recv(timeout=SETTLE)
        self.assertIn("1013", str(refused.exception) + repr(refused.exception))

        self.assertTrue(
            alive(first, self.text),
            "the first connection was collateral damage of refusing the second",
        )

    # --- locks a property that already held ---
    #
    # Kept because they are the neighbours of the three above and cost nothing
    # to run, not because they ever failed. Text frames were hardened from the
    # start; these say so out loud so that a later rearrangement cannot quietly
    # undo it.

    def test_a_text_frame_that_is_not_json_is_reported_and_survived(self):
        client = self.harness.connect()
        client.send("{not json at all")
        reply = json.loads(client.recv(timeout=SETTLE))
        self.assertEqual(reply["type"], "error")
        self.assertEqual(reply["context"], "Malformed frame from the UI")
        self.assertTrue(alive(client, self.text))

    def test_an_unregistered_message_type_is_ignored(self):
        client = self.harness.connect()
        with CapturedLog() as log:
            client.send(json.dumps({"type": "nobody.handles.this"}))
            self.assertTrue(log.wait_for("No handler for message type"))
        self.assertTrue(alive(client, self.text))

    def test_an_unregistered_binary_kind_is_ignored(self):
        client = self.harness.connect()
        with CapturedLog() as log:
            client.send(binary_frame(KIND_UNKNOWN, payload=b"ignored"))
            self.assertTrue(log.wait_for(f"No handler for binary kind {KIND_UNKNOWN}"))
        self.assertTrue(alive(client, self.text))

    def test_a_handler_that_raises_is_reported_and_the_session_survives(self):
        self.harness.channel.on("explode", self._explode)
        client = self.harness.connect()
        client.send(json.dumps({"type": "explode"}))
        reply = json.loads(client.recv(timeout=SETTLE))
        self.assertEqual(reply["type"], "error")
        self.assertIn("deliberate", reply["message"])
        self.assertTrue(alive(client, self.text))

    def test_a_binary_handler_that_raises_is_reported_and_the_session_survives(self):
        self.harness.channel.on_binary(KIND_UNKNOWN, self._explode)
        client = self.harness.connect()
        client.send(binary_frame(KIND_UNKNOWN, payload=b"boom"))
        reply = json.loads(client.recv(timeout=SETTLE))
        self.assertEqual(reply["type"], "error")
        self.assertIn("deliberate", reply["message"])
        self.assertTrue(alive(client, self.text))

    def test_a_frame_of_exactly_the_header_size_carries_an_empty_payload(self):
        """The boundary between the two refusals above, which must be accepted.

        A console frame with no keystrokes in it is well formed - the length
        check has to be `< HEADER_SIZE`, and an off-by-one here would reject a
        legitimate frame while still passing every test above.
        """
        client = self.harness.connect()
        client.send(struct.pack(">BxxxI", KIND_CONSOLE, 0))
        self.assertTrue(self.binary.wait_for(1))
        self.assertEqual(self.binary.seen(), [b""])
        self.assertEqual(len(struct.pack(">BxxxI", KIND_CONSOLE, 0)), HEADER_SIZE)

    def test_the_payload_of_a_well_formed_frame_arrives_whole(self):
        """The other side of the coin: hardening must not eat real keystrokes."""
        client = self.harness.connect()
        header = json.dumps({"seq": 1}).encode("utf-8")
        client.send(binary_frame(KIND_CONSOLE, header_bytes=header, payload=b"print(1)\r"))
        self.assertTrue(self.binary.wait_for(1))
        self.assertEqual(self.binary.seen(), [b"print(1)\r"])

    def _explode(self, _frame):
        raise RuntimeError("deliberate")


class ChannelTokenTest(unittest.TestCase):
    """The token, which is the only thing between a local process and the kernel."""

    def setUp(self):
        self.harness = ChannelHarness()
        self.harness.start()
        self.addCleanup(self.harness.close)

    def test_a_wrong_token_is_refused_before_the_upgrade(self):
        """Refused as HTTP, not closed after upgrading.

        The distinction is load-bearing and documented in _check_token: closing
        an already-upgraded socket looks like a *successful* connection to the
        client, and ocp_vscode's viewer discovery reads that as "viewer present
        but broken" and raises instead of falling back to its defaults. Asserted
        on the status code for that reason - "it did not connect" would pass
        either way.
        """
        with self.assertRaises(Exception) as refused:
            self.harness.connect(token="not-the-token", wait=False)
        self.assertIn("403", str(refused.exception))

    def test_an_empty_token_is_refused(self):
        with self.assertRaises(Exception) as refused:
            self.harness.connect(token="", wait=False)
        self.assertIn("403", str(refused.exception))


if __name__ == "__main__":
    unittest.main()


class WindowGoneTest(unittest.TestCase):
    """What happens to this process when its window leaves.

    The socket dying is not the window dying. A machine waking from sleep resets
    loopback connections, and the frontend reconnects onto the same port and
    token within seconds - so a client going away must be a grace period, not a
    trigger. Measured against a real socket rather than a fake, because "the
    client went" is a websockets library event and mocking it would only assert
    that the mock was called.

    Observed on Windows, 0.3.0.dev173: the machine slept, both of the page's
    sockets were reset, and this process sat holding a kernel, a console, a
    language server and a measurement backend that nothing could reach.
    """

    def setUp(self):
        self.harness = ChannelHarness().start()
        self.addCleanup(self.harness.close)
        self.gone = threading.Event()
        self.harness.channel.when_client_goes(self.gone.set, 0.2)

    def test_a_client_that_leaves_and_stays_away_ends_it(self):
        client = self.harness.connect()
        client.close()

        self.assertTrue(self.gone.wait(SETTLE), "the grace never expired")

    def test_but_one_that_comes_straight_back_does_not(self):
        # The case this whole mechanism exists to survive: the socket is reset,
        # the frontend redials, and the session - kernel, namespace, console -
        # carries on as if nothing happened.
        client = self.harness.connect()
        client.close()
        self.harness.connect()

        self.assertFalse(
            self.gone.wait(0.5),
            "reconnecting did not cancel the grace; a live session would have been stopped",
        )

    def test_and_a_client_that_never_connects_is_not_a_window_that_left(self):
        # Nothing has ever connected, so there is nothing to have gone. The
        # startup path has its own timeout for a window that never arrives.
        self.assertFalse(self.gone.wait(0.5))
