"""One owning thread per socket, and replies that go to whoever asked.

Phase 3c replaced `_shell_lock` with `ShellChannel`. The lock made "only one
thread at a time may touch this socket" a rule that four separate callers had to
follow - the channel thread for a Run, the iopub pump for the refresh after an
idle, the pty reader and a fallback Timer for the warm-up. One owning thread
makes it a property of the design: there is no way to reach the socket except by
putting a request in an outbox.

The second half is routing. Serialising the *reads* was never enough, because
whoever held the lock took whatever reply happened to arrive. An inspection
polled in slices, discarded anything that was not its own, and relied on the
real consumer coming back for it - which worked only because exactly one caller
ever awaited a reply. Futures keyed by msg_id remove the coordination: a request
that wants an answer gets its own, and an answer nobody wants is counted.

What that buys, and what these tests hold it to:

* two inspections can be outstanding at once without stealing from each other,
  so the refresh that follows an idle no longer queues behind an expansion the
  user asked for
* an inspection whose kernel is replaced underneath it is answered immediately
  instead of waiting out its full fifteen seconds for a reply that cannot come -
  which is fifteen seconds of a variable-explorer row saying "loading"
* a restart cannot leave a second sender behind, because retiring the shell
  thread means waiting for it
"""

import threading
import time
import unittest

from fakes import TestableKernel, wait_until
from kernel import KernelUnavailable
from support import SETTLE

# Comfortably longer than a fake kernel needs, so a test that waits this long
# has found a real stall rather than a slow machine.
ANSWER_TIMEOUT = 5.0


class ShellRoutingTest(unittest.TestCase):
    def setUp(self):
        self.kernel = TestableKernel(on_iopub=lambda message: None)
        self.kernel.start()
        self.addCleanup(self.kernel.shutdown)

    def test_concurrent_inspections_each_get_their_own_reply(self):
        """The property the _evaluate_lock used to buy by forbidding overlap.

        Eight at once, each asking a different question. Under the old design
        this could not even be attempted: two readers of one socket stole each
        other's replies, so evaluate() held a lock and they queued.

        A property lock rather than a reproduction. A kernel answers in the
        order it was asked, so mis-keyed routing still lands on the right
        request as long as every outstanding request wanted a reply - see the
        test below for the case where that stops being true.
        """
        answers = {}
        answers_lock = threading.Lock()

        def ask(n):
            answer = self.kernel.evaluate(f"expression-{n}", timeout=ANSWER_TIMEOUT)
            with answers_lock:
                answers[n] = answer

        askers = [threading.Thread(target=ask, args=(n,), name=f"ask-{n}") for n in range(8)]
        for asker in askers:
            asker.start()
        for asker in askers:
            asker.join(timeout=SETTLE * 2)

        self.assertEqual(
            answers, {n: f"expression-{n}" for n in range(8)},
            "an inspection was answered with somebody else's reply",
        )

    def test_a_reply_nobody_asked_for_is_not_given_to_whoever_is_waiting(self):
        """The realistic misrouting, and the reason replies are keyed by msg_id.

        A kernel answers its shell requests in order, so routing by arrival
        order and routing by msg_id agree as long as everything outstanding
        wanted a reply. What breaks that is a Run: nobody awaits its
        execute_reply, so when it lands, "the request that is waiting" is some
        inspection it has nothing to do with. That inspection would be handed an
        answer with no user_expressions in it and report that the name could not
        be read - a variable-explorer row failing because of a Run.

        Widened by holding the shell thread inside the Run's send until the
        inspection is queued behind it, so both are in flight together on every
        run rather than when the timing happens to overlap.
        """
        release = threading.Event()
        first_send = threading.Event()

        def hold_the_first_send(_msg_id):
            if not first_send.is_set():
                first_send.set()
                release.wait(timeout=SETTLE * 2)

        kernel = TestableKernel(on_iopub=lambda message: None, on_execute=hold_the_first_send)
        kernel.start()
        self.addCleanup(kernel.shutdown)
        shell = kernel._generation.shell

        threading.Thread(target=lambda: kernel.execute("a Run"), name="run").start()
        self.assertTrue(first_send.wait(timeout=SETTLE), "the Run never reached the socket")

        answer = {}
        inspection = threading.Thread(
            target=lambda: answer.update(value=kernel.evaluate("mine", timeout=ANSWER_TIMEOUT)),
            name="inspection",
        )
        inspection.start()
        # Queued behind the Run, which is what puts both in one drain.
        self.assertTrue(wait_until(lambda: shell._outbox.qsize() >= 1, ANSWER_TIMEOUT))

        release.set()
        inspection.join(timeout=SETTLE * 2)

        self.assertEqual(
            answer.get("value"), "mine",
            "the inspection was given the Run's reply instead of its own",
        )
        self.assertGreaterEqual(shell.unclaimed, 1, "the Run's reply was never counted")

    def test_a_timed_out_inspection_is_not_remembered_for_ever(self):
        """Otherwise the pending map grows by one for every inspection that fails.

        Each entry holds a Future nobody will ever look at again, and the map
        lives as long as the kernel generation does.
        """
        kernel = TestableKernel(on_iopub=lambda message: None, answers=False)
        kernel.start()
        self.addCleanup(kernel.shutdown)
        shell = kernel._generation.shell

        self.assertIsNone(kernel.evaluate("never answered", timeout=0.05))
        self.assertEqual(shell._pending, {}, "a timed-out request was left pending")


class ShellRetirementTest(unittest.TestCase):
    """What happens to requests when the kernel underneath them is replaced."""

    def test_an_inspection_outstanding_at_a_restart_is_answered_at_once(self):
        """Not left to time out.

        The old design had nothing to say here: a reply that could never arrive
        was indistinguishable from one that had not arrived yet, so an
        inspection caught by a restart waited out its whole timeout. On the
        inspect lane that is fifteen seconds of holding up everything behind it,
        for an answer that was never coming.
        """
        kernel = TestableKernel(on_iopub=lambda message: None, answers=False)
        kernel.start()
        self.addCleanup(kernel.shutdown)

        outcome = {}
        asking = threading.Event()

        def ask():
            asking.set()
            started = time.monotonic()
            # A timeout long enough that waiting it out would be unmistakable.
            outcome["answer"] = kernel.evaluate("outstanding", timeout=30)
            outcome["waited"] = time.monotonic() - started

        asker = threading.Thread(target=ask, name="inspection")
        asker.start()
        self.assertTrue(asking.wait(timeout=SETTLE))
        # Let it get as far as being registered as pending.
        self.assertTrue(wait_until(
            lambda: len(kernel._generation.shell._pending) == 1, ANSWER_TIMEOUT
        ))

        kernel.restart()
        asker.join(timeout=SETTLE * 2)

        self.assertFalse(asker.is_alive(), "the inspection was still waiting after the restart")
        self.assertIsNone(outcome["answer"])
        self.assertLess(
            outcome["waited"], SETTLE * 2,
            f"the inspection waited {outcome['waited']:.1f}s for a kernel that had gone",
        )

    def test_a_restart_waits_for_a_send_rather_than_leaving_a_second_sender(self):
        """The guarantee the shell lock used to give, now given by a join.

        A restart that did not wait would tear the client down with the shell
        thread still inside a send on the shell channel, and then start a second
        thread beside the first - two senders, which is the fault one owning
        thread exists to make impossible.
        """
        in_send = threading.Event()
        release = threading.Event()

        def block_once(_msg_id):
            if not in_send.is_set():
                in_send.set()
                release.wait(timeout=SETTLE * 4)

        kernel = TestableKernel(on_iopub=lambda message: None, on_execute=block_once)
        kernel.start()
        self.addCleanup(kernel.shutdown)
        first = kernel.clients[0]

        threading.Thread(target=lambda: kernel.execute("x"), name="sender").start()
        self.assertTrue(in_send.wait(timeout=SETTLE), "the send never started")

        restarted = threading.Event()
        threading.Thread(
            target=lambda: (kernel.restart(), restarted.set()), name="restarter"
        ).start()

        # The send is still in flight, so the restart must not have got as far as
        # closing anything.
        time.sleep(0.5)
        self.assertFalse(first.channels_stopped,
                         "the client was closed with a send still in flight")
        self.assertEqual(len(kernel.clients), 1, "a second kernel was started beside the send")

        release.set()
        self.assertTrue(restarted.wait(timeout=SETTLE * 2), "the restart never finished")
        self.assertTrue(first.channels_stopped)
        self.assertEqual(len(kernel.clients), 2)

        for client in kernel.clients:
            self.assertLessEqual(
                len(client.senders), 1,
                f"{client.name} was sent on by {sorted(client.senders)} - two threads on "
                "one socket is what the owning thread exists to rule out",
            )

    def test_a_request_after_shutdown_is_refused_rather_than_lost(self):
        """Silence would be the worst answer.

        A Run submitted to a retired kernel used to block on a lock and then
        reach whatever was rebuilt. With nothing being rebuilt it has to say so,
        or the frame is accepted, queued, and never mentioned again.
        """
        kernel = TestableKernel(on_iopub=lambda message: None)
        kernel.start()
        kernel.shutdown()

        started = time.monotonic()
        with self.assertRaises(KernelUnavailable):
            kernel.execute("1 + 1")
        # And it says so promptly rather than after the full restart grace.
        self.assertLess(time.monotonic() - started, SETTLE * 2)


if __name__ == "__main__":
    unittest.main()
