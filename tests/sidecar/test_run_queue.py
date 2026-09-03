"""How many runs are waiting behind the one the kernel is working on.

Pressing Run while a cell runs queues it, and until this was counted nothing on
screen said so: the indicator already read "busy", and the console shows
`In [n]` only when the kernel *starts* a request - which on a long computation
is minutes later. Measured against a real kernel: a second Run produced one more
`kernel.status busy` and no console output for 7 s, so the press was
indistinguishable from a button that did nothing.

The count is the sidecar's because it is the only party that can know. It sent
those requests; the kernel publishes busy and idle for them on iopub, naming
each in `parent_header.msg_id`. A console line is deliberately not counted - it
goes straight to the kernel's shell socket and publishes nothing until it starts
- and does not need to be, since the console echoes it into its own pane at
once.
"""

import tempfile
import unittest

from instance import Instance
from main import Sidecar


class FakeChannel:
    def __init__(self):
        self.sent = []

    def send(self, message_type, **payload):
        self.sent.append((message_type, payload))

    def on(self, *args, **kwargs):
        pass

    def on_binary(self, *args, **kwargs):
        pass

    def submit(self, lane, work):
        # An idle after a run books a variable-explorer refresh on the inspect
        # lane. Recorded rather than run: what it does is another test's.
        self.sent.append(("submit", {"lane": lane}))


def status(state, parent_id, parent_type="execute_request"):
    """One iopub status message, as the kernel publishes it."""
    return {
        "header": {"msg_type": "status"},
        "parent_header": {"msg_type": parent_type, "msg_id": parent_id},
        "content": {"execution_state": state},
    }


class FakeKernel:
    """Enough kernel for on_iopub: nothing here is the sidecar's own request.

    `is_internal` is what keeps a completion's busy/idle off the toolbar, and
    every message in these tests is a user's run, so it answers no to all of
    them.
    """

    def is_internal(self, message):
        return False


class RunQueueTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-queue-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)
        self.sidecar = Sidecar(env_root=root, app_dir=root, instance=instance)
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel
        self.sidecar.kernel = FakeKernel()

    def accept(self, msg_id):
        """What on_execute records when it has sent a run to the kernel."""
        with self.sidecar._runs_lock:
            self.sidecar._pending_runs.append(msg_id)

    def queued(self):
        return self.sidecar.queued_runs()

    def test_nothing_is_waiting_when_nothing_was_sent(self):
        self.assertEqual(self.queued(), 0)

    def test_the_run_being_worked_on_is_not_waiting_for_itself(self):
        self.accept("a")
        self.sidecar.on_iopub(status("busy", "a"))

        self.assertEqual(self.queued(), 0)

    def test_a_second_run_is_waiting_while_the_first_is_worked_on(self):
        self.accept("a")
        self.sidecar.on_iopub(status("busy", "a"))
        self.accept("b")

        self.assertEqual(self.queued(), 1)

    def test_and_a_third(self):
        self.accept("a")
        self.sidecar.on_iopub(status("busy", "a"))
        self.accept("b")
        self.accept("c")

        self.assertEqual(self.queued(), 2)

    def test_the_queue_shortens_as_the_kernel_reaches_them(self):
        self.accept("a")
        self.sidecar.on_iopub(status("busy", "a"))
        self.accept("b")
        self.accept("c")

        self.sidecar.on_iopub(status("idle", "a"))
        self.sidecar.on_iopub(status("busy", "b"))
        self.assertEqual(self.queued(), 1)

        self.sidecar.on_iopub(status("idle", "b"))
        self.sidecar.on_iopub(status("busy", "c"))
        self.assertEqual(self.queued(), 0)

        self.sidecar.on_iopub(status("idle", "c"))
        self.assertEqual(self.queued(), 0)

    def test_a_run_queued_behind_the_console_is_waiting(self):
        """The console's request is not ours, so ours is not the one running."""
        self.sidecar.on_iopub(status("busy", "console-1"))
        self.accept("a")

        self.assertEqual(self.queued(), 1)

    def test_the_console_finishing_does_not_retire_one_of_ours(self):
        self.accept("a")
        self.sidecar.on_iopub(status("busy", "console-1"))
        self.sidecar.on_iopub(status("idle", "console-1"))

        self.assertEqual(len(self.sidecar._pending_runs), 1)

    def test_the_count_rides_on_the_status_frame(self):
        """One fact, one frame: two could be rendered in either order."""
        self.accept("a")
        self.sidecar.on_iopub(status("busy", "a"))
        self.accept("b")
        self.channel.sent.clear()

        self.sidecar.send_kernel_status("busy")

        self.assertEqual(self.channel.sent, [("kernel.status", {"state": "busy", "queued": 1})])


if __name__ == "__main__":
    unittest.main()
