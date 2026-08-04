"""Completion on the shell socket, beside everything else that uses it.

Code completion is the first thing this application asks the kernel that is not
an execute_request. It goes out on the same socket, through the same owning
thread, and is routed back by the same msg_id - so the questions worth asking
are the ones that only arise from it being a *different* message type sharing
that machinery:

* it must leave as a complete_request, not as code the kernel would run
* it must be recorded as internal, or every keystroke that opens the suggestion
  list flashes the toolbar - the kernel publishes busy and idle for a
  complete_request exactly as it does for a Run
* a kernel that does not answer must cost a short wait and nothing else, and
  must not leave the request pending for the rest of the generation
"""

import threading
import unittest

from fakes import TestableKernel, wait_until
from support import SETTLE

ANSWER_TIMEOUT = 5.0


class CompletionTest(unittest.TestCase):
    def setUp(self):
        self.kernel = TestableKernel(on_iopub=lambda message: None)
        self.kernel.start()
        self.addCleanup(self.kernel.shutdown)

    def client(self):
        return self.kernel.clients[-1]

    def test_a_completion_is_sent_as_a_completion(self):
        """Not as an execute_request, which would run the line being typed.

        The failure this excludes is not subtle in its consequences: the shell
        channel only ever built execute_requests, so a completion routed through
        it would execute "part.appen" - or, with a half-typed line, whatever
        that happens to mean.
        """
        content = self.kernel.complete("part.appen", 10, timeout=ANSWER_TIMEOUT)

        self.assertEqual(
            [(code, pos) for code, pos, _ in self.client().completions], [("part.appen", 10)]
        )
        self.assertEqual(self.client().executes, [], "the line being typed was executed")
        self.assertEqual(content["matches"], ["part.appen"])

    def test_a_completion_is_recorded_as_internal(self):
        """Or the toolbar flickers busy/idle on every keystroke.

        Asserted through is_internal - the same question the iopub pump asks -
        rather than by reading the deque, because the pump is the only consumer
        and what matters is the answer it gets.
        """
        self.kernel.complete("pa", 2, timeout=ANSWER_TIMEOUT)
        self.assertEqual(len(self.client().completions), 1, "nothing was sent")
        _, _, msg_id = self.client().completions[-1]

        self.assertTrue(
            self.kernel.is_internal({"parent_header": {"msg_id": msg_id}}),
            "a completion's iopub traffic would be read as user activity",
        )

    def test_a_completion_the_kernel_never_answers_gives_up_quickly(self):
        """The realistic case, and the reason the budget is short.

        A kernel part-way through a cell serves the shell channel serially, so a
        completion asked while code is running waits for the code. A suggestion
        list is worth nothing by then, so the wait is bounded and the answer is
        no answer.
        """
        kernel = TestableKernel(on_iopub=lambda message: None, answers=False)
        kernel.start()
        self.addCleanup(kernel.shutdown)

        self.assertIsNone(kernel.complete("pa", 2, timeout=0.05))

    def test_an_abandoned_completion_is_not_remembered(self):
        """Every keystroke is a request, so a leak here is a leak per character.

        Same property test_a_timed_out_inspection_is_not_remembered_for_ever
        holds for inspections; it matters more here because of the rate.
        """
        kernel = TestableKernel(on_iopub=lambda message: None, answers=False)
        kernel.start()
        self.addCleanup(kernel.shutdown)
        shell = kernel._generation.shell

        for _ in range(5):
            kernel.complete("pa", 2, timeout=0.05)

        self.assertEqual(shell._pending, {}, "a timed-out completion was left pending")

    def test_a_completion_and_a_run_do_not_take_each_other_s_replies(self):
        """The routing property, asked of the message type that is new.

        A Run's execute_reply is awaited by nobody, so when it lands the only
        request waiting is the completion - which under arrival-order routing
        would be handed a reply with no matches in it and report that there is
        nothing to suggest.

        Widened the way the shell channel's own tests widen it: hold the shell
        thread inside the Run's send until the completion is queued behind it,
        so both are in flight together on every run.
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
        asking = threading.Thread(
            target=lambda: answer.update(
                value=kernel.complete("part.", 5, timeout=ANSWER_TIMEOUT)
            ),
            name="completion",
        )
        asking.start()
        self.assertTrue(wait_until(lambda: shell._outbox.qsize() >= 1, ANSWER_TIMEOUT))

        release.set()
        asking.join(timeout=SETTLE * 2)

        self.assertEqual(
            (answer.get("value") or {}).get("matches"), ["part."],
            "the completion was given the Run's reply instead of its own",
        )

    def test_a_completion_after_a_restart_reaches_the_new_kernel(self):
        """The generation scoping, which a new message type has to respect too.

        A completion sent after a restart must go to the replacement's client.
        Nothing about the kind changes that, and the assertion is cheap enough
        to be worth making rather than assumed.
        """
        self.kernel.complete("before", 6, timeout=ANSWER_TIMEOUT)
        self.kernel.restart()
        self.kernel.complete("after", 5, timeout=ANSWER_TIMEOUT)

        self.assertEqual([code for code, _, _ in self.kernel.clients[0].completions], ["before"])
        self.assertEqual([code for code, _, _ in self.kernel.clients[1].completions], ["after"])


if __name__ == "__main__":
    unittest.main()
