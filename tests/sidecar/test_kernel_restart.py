"""The restart races - M3, §3.3.7, and the internal-request record.

These are the three fixes from `8730a3a` and `a5f2a4b`'s neighbourhood that the
Phase 2 notes are honest about never having reproduced. They were fixed by
reading the code and reasoning about it, which is the weakest kind of fix there
is: nothing distinguishes a race that was cured from one that merely stopped
showing up. The whole point of this file is to remove that distinction.

**Race widening** is what makes it possible. A race whose window is a few
microseconds cannot be caught by running the code more often - the Windows
session established that by trying, and the pre-fix code passed 3/3 against a
46 MB assembly. What works is making the window enormous on purpose: hold the
thread exactly where the real one would have been unlucky, then do the thing the
race needs. The window stops being a matter of luck and becomes an instruction.

Every widening here goes through a seam the production code already has - a
client that blocks where a real one waits on a socket, an iopub callback that
blocks where channel.send would have blocked on _send_lock. Kernel.new_manager
is overridden so no kernel process is started; everything above it is the
shipped code. Nothing is patched.

What each test reproduces, verified by un-applying the fix and watching it fail:

* **M3** - `restart()` used to set one shared stop flag, join the pump with a
  two second timeout, and then *clear* that flag. A pump that had not finished
  in two seconds - one blocked in channel.send, which holds _send_lock for the
  length of an entire model frame - woke up afterwards, found the flag clear
  because the replacement had cleared it, and carried on reading `self.client`:
  the new one. Two threads on one zmq socket, which is the fault that produced
  "Invalid Signature: b'<IDS|MSG>'".
* **§3.3.7** - `shutdown()` closed the channels without holding the shell lock,
  so it could do that underneath a thread part-way through a send. Phase 3c
  replaced the lock with one owning thread, so what these two now hold is the
  ordering that took its place: retire the sender, *then* close what it was
  sending on. The property asserted is unchanged, which is the point - it
  survived the rewrite, and the test is how that is known rather than hoped.
* **the restart swap** - `restart()` rebuilds `self.client`, and since the lanes
  landed it does so on a different thread from the one a Run arrives on. Held
  after 3c by `_ready`, which makes a Run that arrives mid-restart wait for the
  replacement instead of being refused or reaching a torn-down client.
* **_internal_lock** - the request id was recorded *after* the send returned, so
  the kernel could publish a status for a request the pump then failed to
  recognise as internal. The explorer treated its own refresh as user activity
  and queued another. This is the one the Windows session measured: 617
  misclassified statuses before the fix, 2 after.
"""

import threading
import time
import unittest

from fakes import TestableKernel
from support import SETTLE

# How long to let a straggler thread misbehave before concluding it will not.
# It only has to lose one race, and it is released before this starts.
MISBEHAVE_WINDOW = 1.0


class RestartRaceTest(unittest.TestCase):
    def setUp(self):
        self.delivered = []
        self.held = threading.Event()
        self.holding = threading.Event()
        self.hold_the_pump = False

    def on_iopub(self, message):
        self.delivered.append((threading.current_thread().name, message))
        if self.hold_the_pump:
            # Where the real pump blocks: channel.send holds _send_lock for the
            # length of an entire model frame, and with nobody draining the
            # socket that is unbounded. The pump waits here instead.
            self.holding.set()
            self.held.wait(timeout=SETTLE * 4)

    def test_a_pump_left_over_from_a_restart_never_touches_the_new_client(self):
        """M3, widened until the straggler is a certainty rather than a chance.

        The old pump is held inside on_iopub across the whole restart, then
        released. If it can reach the replacement, it now will: it wakes up with
        a fresh kernel in place and every reason to keep reading.

        Asserted as "no client was ever read by two threads", which is the fault
        itself - a zmq socket is not thread safe - rather than one of the
        symptoms it produces.
        """
        kernel = TestableKernel(on_iopub=self.on_iopub)
        self.hold_the_pump = True
        kernel.start()
        self.addCleanup(kernel.shutdown)

        first = kernel.clients[0]
        first.deliver()
        self.assertTrue(self.holding.wait(timeout=SETTLE), "the pump never blocked")

        # The restart runs with the old pump stuck. Its join times out, which is
        # the case the whole generation scheme exists for.
        kernel.restart()
        self.assertEqual(len(kernel.clients), 2)
        second = kernel.clients[1]

        # Now let the straggler go, with the replacement already running.
        self.held.set()
        time.sleep(MISBEHAVE_WINDOW)

        for client in (first, second):
            self.assertLessEqual(
                len(client.readers), 1,
                f"{client.name} was read by {sorted(client.readers)} - two threads "
                "on one client is the fault that produces 'Invalid Signature'",
            )
        self.assertEqual(
            second.readers & first.readers, set(),
            "the same thread read both generations' clients",
        )
        self.assertTrue(first.channels_stopped, "the old client was left open")

    def test_the_old_client_is_closed_before_the_replacement_is_read(self):
        """The other half of what makes a straggler harmless.

        A pump that never exits is only safe because the client it holds has
        been closed and its stop flag stays set. If the close were skipped the
        generation scheme would still contain the *reference* while leaving a
        live socket for the straggler to read.
        """
        kernel = TestableKernel(on_iopub=self.on_iopub)
        kernel.start()
        self.addCleanup(kernel.shutdown)
        first = kernel.clients[0]

        kernel.restart()
        self.assertTrue(first.channels_stopped)
        self.assertEqual(kernel.clients[0].name, "gen0")
        self.assertFalse(kernel.clients[1].channels_stopped)

    def test_a_run_arriving_during_a_restart_never_reaches_a_torn_down_client(self):
        """The restart swap, hammered from another thread.

        Restart used to run on the receive thread, which is also where an
        execute came from, so the two could not overlap. It runs on its own lane
        now, so a Run can land while the client is being replaced.

        Two things have to hold, and the second is easy to lose while fixing the
        first. The Run must not reach a torn-down client - and it must not be
        thrown away either. Pressing Run and then Restart Kernel should run the
        code on the new kernel, which the shell lock used to give by being held
        across the whole swap and `_ready` gives now.

        Widened by hammering rather than by blocking, because this window is
        opened by the restart itself and is already milliseconds wide - the
        widening that matters is the number of attempts landing inside it.
        """
        kernel = TestableKernel(on_iopub=lambda message: None)
        kernel.start()
        self.addCleanup(kernel.shutdown)

        stop = threading.Event()
        failures = []

        def keep_running_code():
            while not stop.is_set():
                try:
                    kernel.execute("1 + 1")
                except Exception as exc:  # noqa: BLE001 - recorded, not raised
                    failures.append(repr(exc))

        runner = threading.Thread(target=keep_running_code, name="run-hammer")
        runner.start()
        try:
            for _ in range(5):
                kernel.restart()
        finally:
            stop.set()
            runner.join(timeout=SETTLE)

        stopped = [
            (client.name, client.executed_after_stop)
            for client in kernel.clients
            if len(client.executed_after_stop) > 0
        ]
        self.assertEqual(stopped, [], f"a Run reached a client whose channels were closed: {stopped}")
        self.assertEqual(failures, [])

    def test_shutdown_waits_for_a_send_that_is_already_in_flight(self):
        """§3.3.7, which was fixed on the strength of an argument alone.

        stop() is called on the way out of the process, where an inspection on
        the inspect lane or a Run on the execute lane can still be part-way
        through a send. Closing the socket underneath one of them is the same
        fault as two threads sharing it, at the least convenient moment - benign
        only because os._exit(0) follows, and "benign because of what happens
        next" is not a property to leave lying around in threaded code.

        Held by a lock when this was written and by an ordering since 3c -
        retire the only sender, then close. The test did not change, which is
        what makes it worth having: it is stated in terms of what must be true
        rather than of the mechanism that happened to be true at the time.

        Widened by blocking inside client.execute, which is where the real one
        is inside a zmq send.
        """
        in_send = threading.Event()
        release = threading.Event()

        def block_once(_msg_id):
            if not in_send.is_set():
                in_send.set()
                release.wait(timeout=SETTLE * 2)

        kernel = TestableKernel(on_iopub=lambda message: None, on_execute=block_once)
        kernel.start()
        client = kernel.clients[0]

        sender = threading.Thread(target=lambda: kernel.execute("x"), name="sender")
        sender.start()
        self.assertTrue(in_send.wait(timeout=SETTLE), "the send never started")

        closed_early = []

        def shut_down():
            kernel.shutdown()

        closer = threading.Thread(target=shut_down, name="closer")
        closer.start()

        # The send is still in flight. Nothing may have closed the channels.
        time.sleep(MISBEHAVE_WINDOW)
        if client.channels_stopped:
            closed_early.append("stop_channels ran while a send was in flight")

        release.set()
        sender.join(timeout=SETTLE)
        closer.join(timeout=SETTLE)

        self.assertEqual(closed_early, [])
        self.assertTrue(client.channels_stopped, "the shutdown never completed")


class InternalRequestRecordTest(unittest.TestCase):
    """_internal_lock: the gap between sending a request and calling it ours.

    The id used to be recorded after the send returned. The kernel can answer
    inside that gap - it publishes busy for a request the pump then fails to
    recognise as internal - and the refresh that follows every idle is the one
    that hits it. A leaked pair is visible in any Windows log of the period as a
    busy and an idle a millisecond apart, right after the warm-up. The toolbar
    flickers, and the explorer treats its own refresh as user activity and
    queues another: the exact loop the deque exists to prevent, arrived at by
    losing a race rather than by forgetting.

    Widened by asking the question from inside client.execute - which is to say,
    at the precise moment the kernel would be answering. That turns a
    microsecond window into every single iteration.
    """

    ROUNDS = 100

    # Long enough for the asking thread to reach _internal_lock, which is all the
    # widening needs: from there the fix makes it wait and the defect lets it
    # through. Not a synchronisation - just enough head start that it arrives
    # inside the window on every round instead of one round in thousands.
    HEAD_START = 0.002

    def test_a_status_arriving_during_the_send_is_still_recognised_as_internal(self):
        answers = []
        answers_lock = threading.Lock()
        askers = []

        def ask_from_inside_the_send(msg_id):
            # The kernel, answering while the sender has not yet returned. In
            # production this thread is the iopub pump and the window is however
            # long a zmq send takes.
            answer = kernel.is_internal({"parent_header": {"msg_id": msg_id}})
            with answers_lock:
                answers.append(answer)

        def on_execute(msg_id):
            # Started and deliberately *not* joined here. Joining would wait for
            # _internal_lock, which this very thread is holding - so with the fix
            # in place the test would deadlock against its own correctness, and
            # the only version that ran quickly would be the broken one.
            asker = threading.Thread(
                target=ask_from_inside_the_send, args=(msg_id,), name="fake-kernel"
            )
            asker.start()
            askers.append(asker)
            time.sleep(self.HEAD_START)

        kernel = TestableKernel(on_iopub=lambda message: None, on_execute=on_execute)
        kernel.start()
        self.addCleanup(kernel.shutdown)

        for _ in range(self.ROUNDS):
            kernel.evaluate("1", timeout=0.02)
        for asker in askers:
            asker.join(timeout=SETTLE)

        missed = len([answer for answer in answers if answer is not True])
        self.assertEqual(len(answers), self.ROUNDS, "the widening did not run every round")
        self.assertEqual(
            missed, 0,
            f"{missed}/{self.ROUNDS} internal requests were misread as user activity, "
            "each of which is a spurious variable-explorer refresh and a toolbar flicker",
        )


if __name__ == "__main__":
    unittest.main()
