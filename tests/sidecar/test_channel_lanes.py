"""Lanes: what a slow handler is allowed to hold up, and what it is not.

Everything used to run inline on the single receive thread, so a handler that
took seconds held up every frame behind it - including console keystrokes, which
are the hottest thing in the application and only need an os.write to a pty.
Typing went dead while a measurement indexed a model or the variable explorer
inspected a name, and it read as the console freezing.

The fix was `3558032`, and it cannot be proven by checking that commit out: it
predates the bind/accept split, so the old Channel does not start. What it can
be proven by is the contrast, which is better anyway because it runs against
today's code. The same slow handler is registered twice - once inline, once on a
lane - and a console keystroke is sent behind each. Inline, the keystroke waits
for the whole handler. On a lane, it does not. One test, both halves, no
archaeology.

The second property is that lanes are separate from each other rather than one
background queue. A restart is what a user reaches for precisely when something
is already stuck, so it must not queue behind the very inspection that is stuck.

The third is ordering, which is why these are serial queues and not a thread
pool: opening a file sets the working directory and then runs, and a Run that
overtook its own chdir would resolve relative paths against the previous file's
directory.
"""

import json
import struct
import threading
import time
import unittest

from channel import KIND_CONSOLE
from support import SETTLE, ChannelHarness, Recorder

# Long enough that "did the keystroke wait for it" is not a judgement call, short
# enough that the suite stays quick.
SLOW = 1.5

# What a frame that did not wait should cost: a loopback round trip and a queue
# put. Everything real is two orders of magnitude under this.
PROMPT = 0.5

INSPECT = "inspect"
CONTROL = "control"


def console_frame(payload=b"x"):
    """A keystroke frame, exactly as the webview sends one."""
    return struct.pack(">BxxxI", KIND_CONSOLE, 0) + payload


class LaneTest(unittest.TestCase):
    def setUp(self):
        self.harness = ChannelHarness()
        self.channel = self.harness.channel
        self.keystrokes = Recorder()
        self.channel.on_binary(KIND_CONSOLE, self.keystrokes.record)
        self.addCleanup(self.harness.close)

    def _slow(self, _frame):
        time.sleep(SLOW)

    def _time_a_keystroke_behind(self, client, message_type):
        """Send a slow frame, then a keystroke, and time the keystroke.

        One client for both halves: a second connection would be refused, which
        is the neighbouring property in test_channel_protocol and would show up
        here as a keystroke that never arrives at all.
        """
        before = len(self.keystrokes.seen())
        client.send(json.dumps({"type": message_type}))
        # Ordered on one connection, so this is genuinely behind the slow frame
        # on the wire rather than racing it.
        client.send(console_frame())
        started = time.monotonic()
        self.assertTrue(
            self.keystrokes.wait_for(before + 1, timeout=SLOW + SETTLE),
            "the keystroke never arrived at all",
        )
        return time.monotonic() - started

    def test_a_slow_lane_handler_does_not_delay_a_keystroke_but_an_inline_one_does(self):
        """The contrast that stands in for checking out the pre-lane commit.

        Both halves run against the same code. The only difference is the lane
        argument, which is the fix.
        """
        self.channel.on("slow.inline", self._slow)
        self.channel.on("slow.laned", self._slow, lane=INSPECT)
        self.harness.start()
        client = self.harness.connect()

        laned = self._time_a_keystroke_behind(client, "slow.laned")
        inline = self._time_a_keystroke_behind(client, "slow.inline")

        self.assertLess(
            laned, PROMPT,
            f"a keystroke waited {laned:.2f}s behind a handler that has its own lane",
        )
        self.assertGreater(
            inline, SLOW * 0.8,
            f"the inline half took only {inline:.2f}s, so it is not demonstrating "
            "the delay this test exists to contrast against - the comparison is "
            "worthless without it",
        )

    def test_one_lane_being_busy_does_not_delay_another(self):
        """A restart must not queue behind the inspection it is meant to rescue."""
        control = Recorder()
        self.channel.on("inspect.slow", self._slow, lane=INSPECT)
        self.channel.on("control.restart", lambda frame: control.record(frame["type"]),
                        lane=CONTROL)
        self.harness.start()
        client = self.harness.connect()

        client.send(json.dumps({"type": "inspect.slow"}))
        client.send(json.dumps({"type": "control.restart"}))
        started = time.monotonic()
        self.assertTrue(control.wait_for(1, timeout=SLOW + SETTLE))
        waited = time.monotonic() - started
        self.assertLess(
            waited, PROMPT,
            f"the restart waited {waited:.2f}s behind an inspection on another lane",
        )

    def test_frames_on_one_lane_keep_their_order(self):
        """Serial, not a pool. A Run must never overtake its own chdir.

        Widened by making the first frame the slowest: with a pool, or with a
        second worker on the queue, the later frames would finish first and the
        recorded order would not be the sent order. With one serial worker the
        sleep only delays the whole sequence.
        """
        order = Recorder()

        def handler(frame):
            # Descending, so anything concurrent reorders visibly.
            time.sleep(0.05 * (10 - frame["n"]))
            order.record(frame["n"])

        self.channel.on("ordered", handler, lane=INSPECT)
        self.harness.start()
        client = self.harness.connect()

        for n in range(10):
            client.send(json.dumps({"type": "ordered", "n": n}))
        self.assertTrue(order.wait_for(10, timeout=SLOW + SETTLE + 5))
        self.assertEqual(order.seen(), list(range(10)))

    def test_a_handler_that_raises_does_not_take_the_lane_with_it(self):
        """The worker thread has to survive, or the lane goes silently dead.

        Not a hypothetical: the lane is a `while True` around a queue get, so an
        escaping exception ends the thread and every frame afterwards is
        accepted, queued, and never looked at again. Nothing would report it -
        the socket stays up and the frames keep being read.
        """
        survived = Recorder()

        def handler(frame):
            if frame.get("explode") is True:
                raise RuntimeError("deliberate")
            survived.record(frame.get("n"))

        self.channel.on("fragile", handler, lane=INSPECT)
        self.harness.start()
        client = self.harness.connect()

        client.send(json.dumps({"type": "fragile", "explode": True}))
        client.send(json.dumps({"type": "fragile", "n": 1}))
        self.assertTrue(
            survived.wait_for(1),
            "the lane died with the handler and every later frame was lost",
        )
        self.assertEqual(survived.seen(), [1])

    def test_work_with_no_frame_behind_it_runs_on_a_lane(self):
        """submit(), which is how the idle refresh reaches a lane.

        It comes from the iopub pump rather than from the webview, and it must
        not run there: blocking that thread stops kernel status reaching the
        toolbar.
        """
        done = Recorder()
        self.channel.open_lane(INSPECT)
        self.harness.start()

        caller = threading.current_thread()
        self.channel.submit(INSPECT, lambda: done.record(threading.current_thread()))
        self.assertTrue(done.wait_for(1))
        self.assertIsNot(done.seen()[0], caller, "the work ran on the calling thread")
        self.assertTrue(done.seen()[0].name.startswith("lane-"))

    def test_an_unopened_lane_is_refused_rather_than_created_on_the_spot(self):
        """The Windows deadlock guard, asserted where it is cheap to assert.

        Lanes used to be created lazily inside _lane, holding _lanes_lock across
        threading.Thread.start(). On Windows, starting a thread needs the loader
        lock that a native import holds, so that call could block for good - and
        it held the lock every kernel.execute must take to reach its own lane.
        Every Run went with it.

        The rule is that lanes are opened from Sidecar.__init__, before any
        background import starts. A KeyError here is that rule refusing to be
        broken quietly; a lazily created lane would pass and reintroduce the
        deadlock on a machine none of us runs.
        """
        self.harness.start()
        with self.assertRaises(KeyError):
            self.channel.submit("never-opened", lambda: None)

    def test_opening_a_lane_twice_does_not_start_a_second_worker(self):
        """Or ordering within it would stop being a property at all.

        Asserted through ordering rather than by counting threads. Lane workers
        are `while True` daemons that never exit, so by this point in the run the
        process is full of them from earlier tests and a name count says nothing.
        A descending sleep does: with two workers on one queue the later items
        finish first and the recorded order is not the submitted order.
        """
        order = Recorder()
        self.channel.open_lane(INSPECT)
        self.channel.open_lane(INSPECT)
        self.harness.start()

        for n in range(5):
            self.channel.submit(INSPECT, lambda n=n: (time.sleep(0.05 * (5 - n)),
                                                      order.record(n)))
        self.assertTrue(order.wait_for(5, timeout=SLOW + SETTLE))
        self.assertEqual(order.seen(), list(range(5)))


if __name__ == "__main__":
    unittest.main()
