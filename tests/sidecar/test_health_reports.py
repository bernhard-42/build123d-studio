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

    def send_binary(self, kind, payload, header_bytes=b""):
        self.sent.append(("binary", {"kind": kind, "payload": payload, "header": header_bytes}))

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
        """True for "it restarted", which is what the real one answers.

        Not None. The real Kernel.restart refuses when a quit has already begun
        and says so with False, and on_restart reads that answer to decide
        whether to start a console - so a fake that returns nothing stands for a
        refusal, and this whole class stands for a kernel that came back.
        """
        self.restarts += 1
        if self.fails:
            raise RuntimeError("the kernel would not come back")
        return True


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


class SplashUntilSomethingIsDrawnTest(unittest.TestCase):
    """The logo's camera must not survive into the first real model.

    The core resets the camera while a splash is up and keeps it afterwards, and
    it asks this process which of the two is true - the frontend draws the logo,
    so no other process can know. The flag therefore retires on the first
    *model*, and `show_clear()` is not one: it travels the same socket so that it
    stays ordered against the models it clears, and retiring the splash for it
    left the logo's position, target and rotation in force for the next show.
    Reported against 0.3.0.dev186, where the file template's first cell calls
    show_clear() and the box that followed came up at the logo's camera.
    """

    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-splash-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)

        self.sidecar = Sidecar(env_root=root, app_dir=root, instance=instance)
        self.sidecar.channel = FakeChannel()

    def test_a_model_retires_the_splash(self):
        self.sidecar.on_model(b'{"type": "data"}', b"geometry")

        self.assertFalse(self.sidecar._splash)

    def test_but_a_clear_leaves_it_alone(self):
        self.sidecar.on_model(b'{"type": "clear"}', b"")

        self.assertTrue(self.sidecar._splash, "a clear retired the splash")

    def test_and_a_clear_after_a_real_model_does_not_bring_it_back(self):
        # The other direction, which is the one that would put a reset back on
        # a session the user has been posing by hand: clearing an emptied pane
        # is not the logo coming back.
        self.sidecar.on_model(b'{"type": "data"}', b"geometry")
        self.sidecar.on_model(b'{"type": "clear"}', b"")

        self.assertFalse(self.sidecar._splash)


class ViewerMessagesArePassedOnWholeTest(unittest.TestCase):
    """The core builds the page's message; this host only carries it.

    `set_viewer_config` reaches the core, which wraps the settings as
    `{"type": "ui", "config": {...}}` in its own comms and hands the whole
    object to this host's send_config. Wrapping it again made the page apply the
    outer envelope - it logged "ui: no setter for 'type'" and "no setter for
    'config'", and not one real setting arrived. Reported against 0.3.0.dev187.

    The shared page has one dispatch and every host feeds it the same objects,
    so a host that rewrites them is a host whose viewer behaves differently from
    the others - which is the whole thing the core/host split exists to prevent.
    """

    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-viewer-msg-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)

        self.sidecar = Sidecar(env_root=root, app_dir=root, instance=instance)
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel

    def sent(self):
        return [payload["message"] for kind, payload in self.channel.sent if kind == "viewer.message"]

    def test_a_ui_message_arrives_exactly_as_the_core_built_it(self):
        message = {"type": "ui", "config": {"axes": True, "grid": [True, False, False]}}

        self.sidecar.on_viewer_config(message)

        self.assertEqual(self.sent(), [message])

    def test_and_its_settings_are_not_buried_one_level_deeper(self):
        # The failure in the form the page saw it: the settings must be the
        # config, not a message nested inside it.
        self.sidecar.on_viewer_config({"type": "ui", "config": {"axes": True}})

        config = self.sent()[0]["config"]
        self.assertEqual(config, {"axes": True})
        self.assertNotIn("type", config)
