"""The warm-up ends on its iopub idle or its shell reply, whichever comes first.

On 2026-10-22 the idle never arrived: the kernel had imported build123d and
was idle, its execute_reply had come back on the shell channel, and the sidecar
went on waiting for a status message for the rest of the session. Everything
the warm-up gates - the Import and Export dialogs' options, the viewer
defaults - was refused until the kernel was restarted.
"""

import concurrent.futures
import os
import tempfile
import types
import unittest

from instance import Instance
from kernel import Kernel, Request
from main import Sidecar
from test_run_queue import FakeChannel, FakeKernel, status


class WarmUpReplyTest(unittest.TestCase):
    """Kernel.warm_up hands its reply to whoever asked to hear it."""

    def warm_up(self, on_finished):
        submitted = []

        def submit(code, **kwargs):
            request = Request(code, {}, True, kwargs.get("want_reply", False))
            request.sent.set_result("warm-1")
            submitted.append(request)
            return request

        fake = types.SimpleNamespace(_submit=submit)
        msg_id = Kernel.warm_up(fake, on_finished=on_finished)
        return msg_id, submitted[0]

    def test_the_reply_reports_the_warm_up_finished(self):
        finished = []
        msg_id, request = self.warm_up(finished.append)
        self.assertEqual(msg_id, "warm-1")
        self.assertEqual(finished, [])

        request.reply.set_result({"content": {"status": "ok"}})

        self.assertEqual(finished, ["warm-1"])

    def test_a_reply_that_never_came_reports_nothing(self):
        finished = []
        _, request = self.warm_up(finished.append)
        request.reply.set_exception(concurrent.futures.CancelledError())
        self.assertEqual(finished, [])


class WarmUpFinishedTest(unittest.TestCase):
    """The sidecar's half: either signal clears the gate, once."""

    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-warm-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)
        self.sidecar = Sidecar(
            env_root=root, app_dir=root, instance=instance, settings_path=os.path.join(root, "settings.json")
        )
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel
        self.sidecar.kernel = FakeKernel()
        self.sidecar.kernel.internal = {"warm-1"}
        self.sidecar._warm_request = "warm-1"

    def refreshes(self):
        return [entry for entry in self.channel.sent if entry == ("submit", {"lane": "inspect"})]

    def test_the_reply_alone_ends_the_warm_up(self):
        self.sidecar.warm_up_finished("warm-1")
        self.assertIsNone(self.sidecar._warm_request)
        self.assertEqual(len(self.refreshes()), 1)

    def test_the_idle_alone_still_ends_it(self):
        self.sidecar.on_iopub(status("idle", "warm-1", parent_type="execute_request"))
        self.assertIsNone(self.sidecar._warm_request)
        self.assertEqual(len(self.refreshes()), 1)

    def test_the_second_of_the_pair_does_nothing_more(self):
        self.sidecar.warm_up_finished("warm-1")
        self.sidecar._refresh_queued.clear()
        self.sidecar.on_iopub(status("idle", "warm-1", parent_type="execute_request"))
        self.assertEqual(len(self.refreshes()), 1)

    def test_another_requests_reply_leaves_the_warm_up_waiting(self):
        self.sidecar.warm_up_finished("someone-else")
        self.assertEqual(self.sidecar._warm_request, "warm-1")
        self.assertEqual(self.refreshes(), [])

    def test_the_forms_are_read_once_the_reply_has_ended_it(self):
        self.sidecar.kernel.answers = {"importing\"]).forms()": "[]"}
        self.sidecar.on_import_forms({"id": "import.forms#1"})
        self.assertIn(("import.forms", {"id": "import.forms#1", "forms": None}), self.channel.sent)

        self.sidecar.warm_up_finished("warm-1")
        self.sidecar.on_import_forms({"id": "import.forms#2"})
        self.assertIn(("import.forms", {"id": "import.forms#2", "forms": []}), self.channel.sent)


if __name__ == "__main__":
    unittest.main()
