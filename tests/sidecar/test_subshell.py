"""Which shell inside the kernel each request is served by.

The kernel serves one shell serially, so an inspection sent while a cell is
running waits for the cell - 9.57 s against a ten second cell, measured on the
pinned ipykernel 7.3.0, for the identical request a subshell answers in 0.01 s.
Routing is a single header field, and everything worth asserting here follows
from that:

* the two requests that answer questions - an inspection and a completion -
  carry it, so they overtake the code the kernel is running
* the three that change something - a Run, the warm-up import and the chdir - do
  not, because they are ordered with respect to each other by being served
  serially, and os.chdir is process-wide
* a kernel with no subshells is a working application and not a degraded one:
  no header field anywhere, and completion back to asking only while idle
* a restart's subshell belongs to the restart's kernel, so nothing routes to an
  id that died with the process it lived in

The wire format is not guessed at. The header field, the control-channel
message and the reply's shape are the messaging spec's, checked against
ipykernel 7.3.0, and a probe measured the numbers above before any of this was
written.
"""

import tempfile
import unittest

import kernel as kernel_module
from fakes import TestableKernel, wait_until
from support import SETTLE

ANSWER_TIMEOUT = 5.0


# What the main shell looks like on the wire: the field is not there at all.
ABSENT = "(no subshell_id in the header)"


def subshell_ids(client):
    """Which shell each message that went out was addressed to.

    Absent rather than None for the main shell, and the difference is the
    assertion rather than a detail: "no subshell_id in the header" is what the
    messaging spec means by the main shell, and a header carrying the field with
    a null in it says something this application does not mean. It happens to
    reach the same thread on ipykernel, which is exactly why asserting on
    .get() proved nothing - it cannot tell the two apart.
    """
    return [
        message["header"]["subshell_id"] if "subshell_id" in message["header"] else ABSENT
        for message in client.sent
    ]


class SubshellRoutingTest(unittest.TestCase):
    def setUp(self):
        self.kernel = TestableKernel(on_iopub=lambda message: None)
        self.kernel.start()
        self.addCleanup(self.kernel.shutdown)

    def client(self):
        return self.kernel.clients[-1]

    def test_the_kernel_is_asked_for_a_subshell_at_startup(self):
        self.assertTrue(self.kernel.has_subshell())
        sent = self.client().control_channel.sent
        self.assertEqual(
            [message["header"]["msg_type"] for message in sent],
            ["create_subshell_request"],
            "the subshell was not asked for on the control channel",
        )

    def test_an_inspection_goes_to_the_subshell(self):
        """The whole point: it must not queue behind the user's code."""
        self.kernel.evaluate("1 + 1", timeout=ANSWER_TIMEOUT)

        self.assertEqual(len(self.client().sent), 1, "nothing was sent")
        self.assertEqual(subshell_ids(self.client()), ["gen0-sub"])

    def test_a_completion_goes_to_the_subshell(self):
        self.kernel.complete("part.appen", 10, timeout=ANSWER_TIMEOUT)

        self.assertEqual(len(self.client().sent), 1, "nothing was sent")
        self.assertEqual(subshell_ids(self.client()), ["gen0-sub"])

    def test_a_run_stays_on_the_main_shell(self):
        """Ordering with respect to the chdir and the warm-up is what is at stake."""
        self.kernel.execute("print('hello')")

        self.assertTrue(wait_until(lambda: len(self.client().sent) == 1, SETTLE))
        self.assertEqual(subshell_ids(self.client()), [ABSENT])

    def test_the_warm_up_stays_on_the_main_shell(self):
        self.kernel.warm_up()

        self.assertTrue(wait_until(lambda: len(self.client().sent) == 1, SETTLE))
        self.assertEqual(subshell_ids(self.client()), [ABSENT])

    def test_the_chdir_stays_on_the_main_shell(self):
        """os.chdir is process-wide, so on a subshell it would move a running cell."""
        with tempfile.TemporaryDirectory() as folder:
            self.kernel.set_working_dir(folder)

        self.assertTrue(wait_until(lambda: len(self.client().sent) == 1, SETTLE))
        self.assertEqual(subshell_ids(self.client()), [ABSENT])

    def test_an_inspection_after_a_restart_uses_the_new_kernel_s_subshell(self):
        """An id belongs to the process it was created in, and that one is gone."""
        self.kernel.restart()
        self.kernel.evaluate("1 + 1", timeout=ANSWER_TIMEOUT)

        self.assertEqual(subshell_ids(self.kernel.clients[0]), [])
        self.assertEqual(subshell_ids(self.kernel.clients[1]), ["gen1-sub"])


class NoSubshellTest(unittest.TestCase):
    """A kernel that has none, which must be an ordinary working application.

    Not a hypothetical: it is what every ipykernel before 7 does, and the
    fallback is the whole reason routing is a header field that can be absent
    rather than a second socket or a second client.
    """

    def start(self, subshells):
        self.kernel = TestableKernel(on_iopub=lambda message: None, subshells=subshells)
        self.kernel.start()
        self.addCleanup(self.kernel.shutdown)
        return self.kernel.clients[-1]

    def test_a_kernel_that_refuses_is_asked_nothing_more(self):
        client = self.start(subshells=False)

        self.assertFalse(self.kernel.has_subshell())
        self.kernel.evaluate("1 + 1", timeout=ANSWER_TIMEOUT)
        self.kernel.complete("part.appen", 10, timeout=ANSWER_TIMEOUT)

        self.assertEqual(len(client.sent), 2, "one of the two requests never went out")
        self.assertEqual(subshell_ids(client), [ABSENT, ABSENT])

    def test_a_kernel_that_never_answers_is_not_waited_on_for_ever(self):
        """The reply may simply not come: a kernel that has never heard of this.

        The deadline is shortened rather than waited out, because five seconds
        of a unit test proves nothing the tenth of a second does not.
        """
        original = kernel_module.SUBSHELL_TIMEOUT
        kernel_module.SUBSHELL_TIMEOUT = 0.1
        self.addCleanup(setattr, kernel_module, "SUBSHELL_TIMEOUT", original)

        client = self.start(subshells=None)

        self.assertFalse(self.kernel.has_subshell())
        self.kernel.evaluate("1 + 1", timeout=ANSWER_TIMEOUT)
        self.assertEqual(subshell_ids(client), [ABSENT])


if __name__ == "__main__":
    unittest.main()
