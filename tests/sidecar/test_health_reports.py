"""What each subsystem says about itself, and whether it can ever take it back.

Written because of one report and it is the more useful half of it: killing the
kernel put `failed` in the toolbar, correctly, and restarting the kernel from
the application left it there for the rest of the session while everything -
Runs, measurements, completion - worked perfectly.

**A state that can go bad and has no way back is worse than no state at all**,
because it teaches the reader to ignore the one indicator meant to be worth
looking at. So what is held here is not the wording of any report but the shape
of the state machine: every path that reaches `failed` is followed to see
whether something can reach `ready` again.

The subsystems are stubs. None of this is about what a kernel does when it is
restarted - `test_kernel_restart.py` holds that - only about what is said.
"""

import tempfile
import unittest

from instance import Instance
from main import Sidecar


class FakeChannel:
    """The webview link, reduced to what went out on it."""

    def __init__(self):
        self.sent = []

    def send(self, message_type, **payload):
        self.sent.append((message_type, payload))

    def error(self, context, exc):
        self.sent.append(("error", {"context": context, "exc": str(exc)}))

    def on(self, *args, **kwargs):
        pass

    def on_binary(self, *args, **kwargs):
        pass

    def open_lane(self, name):
        pass


class FakeKernel:
    def __init__(self, fails=False):
        self.fails = fails
        self.restarts = 0

    def restart(self):
        self.restarts += 1
        if self.fails:
            raise RuntimeError("the kernel would not come back")


class HealthReportTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-health-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)

        self.sidecar = Sidecar(env_root=root, app_dir=root, instance=instance)
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel
        self.sidecar.console = None
        # The replacement console is a real pty in production; starting one here
        # would spawn a process to test a sentence.
        self.sidecar.console_start = lambda: None

    def states(self, name):
        return [
            payload["state"]
            for message_type, payload in self.channel.sent
            if message_type == "subsystem" and payload["name"] == name
        ]

    def test_a_restart_says_starting_and_then_ready(self):
        self.sidecar.kernel = FakeKernel()
        self.sidecar.on_restart({})
        self.assertEqual(self.states("kernel"), ["starting", "ready"])

    def test_a_kernel_that_died_and_was_restarted_ends_up_ready(self):
        """His report, in the order he did it.

        `failed` while it is dead is right; `failed` afterwards is the defect,
        and it lasted for the rest of the session because nothing else ever
        spoke for the kernel again.
        """
        self.sidecar.kernel = FakeKernel()
        self.sidecar.on_kernel_died()
        self.assertEqual(self.states("kernel"), ["failed"])

        self.sidecar.on_restart({})
        self.assertEqual(self.states("kernel"), ["failed", "starting", "ready"])

    def test_a_restart_that_fails_says_so_and_does_not_claim_ready(self):
        self.sidecar.kernel = FakeKernel(fails=True)
        self.sidecar.on_restart({})
        self.assertEqual(self.states("kernel"), ["starting", "failed"])
        self.assertIn(
            "kernel.restart_failed",
            [message_type for message_type, _ in self.channel.sent],
        )

    def test_starting_is_not_a_fault_so_the_chip_goes_at_once(self):
        # The frontend decides that with health.js's severities; what matters
        # here is that the restart's first word is `starting` and not silence,
        # because the seconds it takes are seconds of a chip reading `failed`
        # at a user who is already fixing it.
        self.sidecar.kernel = FakeKernel()
        self.sidecar.on_kernel_died()
        before = len(self.channel.sent)
        self.sidecar.on_restart({})
        first = next(
            payload["state"]
            for message_type, payload in self.channel.sent[before:]
            if message_type == "subsystem"
        )
        self.assertEqual(first, "starting")


if __name__ == "__main__":
    unittest.main()
