"""A console that exits on its own is replaced; the kernel is not touched.

Reported: Ctrl-D in the console pane printed "[console exited]" and the only
way back was Restart Kernel, which discarded every name in the session for a
client that had merely quit.
"""

import os
import tempfile
import threading
import unittest

import main as sidecar_main
from instance import Instance
from main import Sidecar


class FakeChannel:
    def __init__(self):
        self.sent = []
        self.submitted = []

    def send(self, message_type, **payload):
        self.sent.append((message_type, payload))

    def submit(self, lane, work):
        self.submitted.append((lane, work))

    def send_binary(self, *args, **kwargs):
        pass

    def error(self, context, exc):
        self.sent.append(("error", {"context": context, "exc": str(exc)}))

    def on(self, *args, **kwargs):
        pass

    def on_binary(self, *args, **kwargs):
        pass

    def open_lane(self, name):
        pass


class FakeConsole:
    """A console process as the sidecar sees it: it starts, draws, and one day exits."""

    def __init__(self, on_output, on_exit):
        self.on_output = on_output
        self.on_exit = on_exit
        self.started = False
        self.stopped = False
        self.typed = threading.Event()

    def prompt(self):
        """What a console that came up does: it draws something."""
        self.on_output(b"In [1]: ")

    def write(self, data):
        # As the real one: a keystroke is remembered by the console it reached.
        self.typed.set()

    def start(self, *size):
        self.started = True

    def stop(self):
        self.stopped = True

    def resize(self, *size):
        pass


class FakeKernel:
    connection_file = "/nowhere/kernel.json"


class ConsoleRespawnTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-console-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)
        self.sidecar = Sidecar(env_root=root, app_dir=root, instance=instance,
                               settings_path=os.path.join(root, "settings.json"))
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel
        self.sidecar.kernel = FakeKernel()
        self.sidecar.console = None
        self.consoles = []
        self.sidecar._new_console = self._new_console
        # The warm-up timer console_start arms would fire a real request.
        self.addCleanup(lambda: self.sidecar._warm_timer and self.sidecar._warm_timer.cancel())
        # Time, as the sidecar reads it. Advanced by the test rather than waited for.
        self.now = 1000.0
        self._real_monotonic = sidecar_main.time.monotonic
        sidecar_main.time.monotonic = lambda: self.now
        self.addCleanup(lambda: setattr(sidecar_main.time, "monotonic", self._real_monotonic))

    def _new_console(self, on_output, on_exit):
        console = FakeConsole(on_output, on_exit)
        self.consoles.append(console)
        return console

    def exits(self):
        return [payload for kind, payload in self.channel.sent if kind == "console.exit"]

    def test_a_console_somebody_typed_into_is_replaced_and_the_pane_told(self):
        self.sidecar.console_start()
        first = self.consoles[0]
        self.assertTrue(first.started)
        first.prompt()
        self.sidecar.on_console_input(b"\x04")  # Ctrl-D

        # Two seconds in: a fourth Ctrl-D right after the banner is ordinary.
        self.now += 2
        first.on_exit()

        self.assertEqual(self.exits(), [{"respawning": True}])
        self.assertEqual(len(self.channel.submitted), 1)
        lane, work = self.channel.submitted[0]
        self.assertEqual(lane, sidecar_main.CONTROL)

        work()

        self.assertEqual(len(self.consoles), 2, "no replacement was started")
        self.assertIs(self.sidecar.console, self.consoles[1])
        self.assertTrue(self.consoles[1].started)
        self.assertIn(("console.restarted", {}), self.channel.sent)

    def test_a_console_nobody_typed_into_is_not_replaced(self):
        # It died on its own - could not start, or drew its banner and
        # crashed - and replacing it would replace it for ever. Drawing a
        # prompt is not enough; a keystroke is what a person contributes.
        self.sidecar.console_start()
        self.consoles[0].prompt()
        self.now += 60
        self.consoles[0].on_exit()

        self.assertEqual(self.exits(), [{"respawning": False}])
        self.assertEqual(self.channel.submitted, [])
        self.assertEqual(len(self.consoles), 1)

    def test_a_chain_of_ctrl_ds_half_a_second_apart_is_replaced_every_time(self):
        # His test: four in two seconds. Timing guards refused the fourth;
        # each one is a keystroke, so each one earns a replacement.
        self.sidecar.console_start()
        for _ in range(6):
            console = self.consoles[-1]
            console.prompt()
            self.sidecar.on_console_input(b"\x04")
            self.now += 0.5
            console.on_exit()
            self.assertEqual(self.exits()[-1], {"respawning": True})
            _, work = self.channel.submitted[-1]
            work()
        self.assertEqual(len(self.consoles), 7)

    def test_input_to_the_old_console_does_not_count_for_the_new_one(self):
        self.sidecar.console_start()
        first = self.consoles[0]
        first.prompt()
        self.sidecar.on_console_input(b"x")
        first.on_exit()
        _, work = self.channel.submitted[-1]
        work()

        second = self.consoles[1]
        second.prompt()
        second.on_exit()

        self.assertEqual(self.exits()[-1], {"respawning": False})

    def test_a_restart_that_got_there_first_wins(self):
        # The exit is queued behind a restart on the same lane; by the time it
        # runs, the console it was about is no longer the current one.
        self.sidecar.console_start()
        first = self.consoles[0]
        first.prompt()
        self.sidecar.on_console_input(b"\x04")
        self.now += 60
        first.on_exit()
        _, work = self.channel.submitted[0]

        self.sidecar.console = None
        self.sidecar.console_start()  # what a kernel restart does
        replacement = self.sidecar.console

        work()

        self.assertIs(self.sidecar.console, replacement)
        self.assertEqual(len(self.consoles), 2, "a third console was started")

    def test_an_exit_of_a_superseded_console_says_nothing(self):
        # A restart stopped it on purpose; its late exit is not news.
        self.sidecar.console_start()
        first = self.consoles[0]
        first.prompt()
        self.sidecar.on_console_input(b"x")
        self.sidecar.console = None
        self.sidecar.console_start()
        self.now += 60

        first.on_exit()

        self.assertEqual(self.exits(), [])
        self.assertEqual(self.channel.submitted, [])
