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
import os
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
    them. `evaluate` answers the two inspections a refresh makes, from a table
    a test fills.
    """

    def __init__(self):
        self.answers = {}
        # Request ids that are the sidecar's own - the warm-up, an inspection
        # - which is_internal keeps off the toolbar and away from the refresh.
        self.internal = set()

    def is_internal(self, message):
        return message["parent_header"].get("msg_id") in self.internal

    def evaluate(self, expression, timeout=None):
        for suffix, answer in self.answers.items():
            if expression.endswith(suffix):
                return answer
        return None


class RunQueueTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-queue-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)
        self.sidecar = Sidecar(env_root=root, app_dir=root, instance=instance, settings_path=os.path.join(root, "settings.json"))
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel
        self.sidecar.kernel = FakeKernel()

    def accept(self, msg_id):
        """What on_execute records when it has sent a run to the kernel."""
        self.sidecar._accept_run(msg_id)

    def queued(self):
        return self.sidecar.queued_runs()

    def test_nothing_is_waiting_when_nothing_was_sent(self):
        self.assertEqual(self.queued(), 0)

    def test_the_run_being_worked_on_is_not_waiting_for_itself(self):
        self.accept("a")
        self.sidecar.on_iopub(status("busy", "a"))

        self.assertEqual(self.queued(), 0)

    def test_a_run_handed_to_a_kernel_with_nothing_of_ours_running_is_the_running_one(self):
        """Not a waiting one: the kernel takes it next, and its own busy can
        arrive seconds later. Counted as waiting, the toolbar read "busy [+1]"
        for an import that had already started."""
        self.accept("a")
        self.assertEqual(self.queued(), 0)
        # The kernel's busy for it changes nothing.
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

    def test_an_idle_with_one_of_ours_still_waiting_is_reported_as_busy(self):
        """The kernel serves in order and the next run is already on its
        socket, so it is what runs next. Its own busy can arrive seconds late -
        an importer holding the GIL holds the IOPub thread that sends it - and
        the toolbar read idle for a whole STEP import in between."""
        self.accept("a")
        self.accept("b")
        self.sidecar.on_iopub(status("busy", "a"))
        self.sidecar.on_iopub(status("idle", "a"))

        last = [p for t, p in self.channel.sent if t == "kernel.status"][-1]
        self.assertEqual(last, {"state": "busy", "queued": 0})
        # And no refresh was booked between the two: it would only queue
        # behind the run that is now going.
        self.assertNotIn(("submit", {"lane": "inspect"}), self.channel.sent)

        self.sidecar.on_iopub(status("busy", "b"))
        self.sidecar.on_iopub(status("idle", "b"))
        last = [p for t, p in self.channel.sent if t == "kernel.status"][-1]
        self.assertEqual(last, {"state": "idle", "queued": 0})
        self.assertIn(("submit", {"lane": "inspect"}), self.channel.sent)

    def test_a_refresh_carries_the_viewer_defaults_beside_the_namespace(self):
        """The reset_camera shortcut reads the kernel's default on the same
        occasions the explorer reads the namespace; both come from one
        refresh, so neither can be stale against the other."""
        self.sidecar.kernel.answers = {
            ".variables()": "[]",
            ".viewer_defaults()": '{"reset_camera": "KEEP"}',
        }
        self.sidecar.refresh_variables()

        self.assertIn(("vars.data", {"variables": []}), self.channel.sent)
        self.assertIn(("viewer.defaults", {"reset_camera": "KEEP"}), self.channel.sent)

    def test_the_defaults_are_not_read_while_the_warm_up_imports(self):
        """The startup refresh runs during the warm-up and its namespace read
        merely times out; a defaults read then reached into a module the main
        thread was still initialising and wedged the kernel for good."""
        self.sidecar.kernel.answers = {
            ".variables()": "[]",
            ".viewer_defaults()": '{"reset_camera": "RESET"}',
        }
        self.sidecar._warm_request = "warm-1"
        self.sidecar.refresh_variables()

        self.assertIn(("vars.data", {"variables": []}), self.channel.sent)
        self.assertNotIn(("viewer.defaults", {"reset_camera": "RESET"}), self.channel.sent)

    def test_the_warm_up_finishing_books_the_first_refresh(self):
        """Every later refresh is booked by an execute idle; the warm-up is
        internal, so without this the shortcut showed nothing until the
        first run."""
        self.sidecar.kernel.internal = {"warm-1"}
        self.sidecar._warm_request = "warm-1"
        self.sidecar.on_iopub(status("idle", "warm-1", parent_type="execute_request"))
        self.assertIn(("submit", {"lane": "inspect"}), self.channel.sent)
        self.assertIsNone(self.sidecar._warm_request)

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
