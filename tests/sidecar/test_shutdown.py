"""The way out, which is where seven sidecars were lost.

On 2026-08-15 this machine was carrying seven sidecar trees whose application
had gone - each still holding a kernel, a console and a measurement backend, and
each of them had been asked to stop properly.

Two things did it, and both are held here. A quit asks twice by design
(`stopSidecar` sends the frame and then closes stdin, so a webview that dies
before the frame lands is still heard), and the whole teardown ran on both
threads at once. And the frame's thread is one the *interpreter* joins on the
way out - websockets creates its connection thread non-daemon - so when the two
runs met in the middle, nothing was left that could log it, let alone exit.

The subsystems are stubs. What is being tested is the ordering, the ownership
and the deadline, none of which is about what a kernel or a language server
does when asked to stop.
"""

import tempfile
import threading
import time
import unittest

import main
from instance import Instance
from main import Sidecar


class Recorder:
    """A subsystem that records being stopped, and can be told to be slow."""

    def __init__(self, name, stopped, delay=0.0, raises=None):
        self.name = name
        self._stopped = stopped
        self._delay = delay
        self._raises = raises

    def stop(self):
        self._stopped.append(self.name)
        if self._delay > 0:
            time.sleep(self._delay)
        if self._raises is not None:
            raise self._raises

    # The kernel and the channel and the instance are asked by other names.
    shutdown = stop
    close = stop

    def release(self, on_error=None):
        self.stop()


class ShutdownTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="studio-shutdown-")
        self.instance = Instance(self.root)
        self.instance.claim()
        self.sidecar = Sidecar(env_root=self.root, app_dir=self.root, instance=self.instance)
        self.addCleanup(self.instance.release)

        self.stopped = []
        self.sidecar.completer = Recorder("completer", self.stopped)
        self.sidecar.debug = Recorder("debug", self.stopped)
        self.sidecar.run = Recorder("run", self.stopped)
        self.sidecar.measurements = Recorder("measurements", self.stopped)
        self.sidecar.console = Recorder("console", self.stopped)
        self.sidecar.kernel = Recorder("kernel", self.stopped)
        self.sidecar.models = Recorder("models", self.stopped)
        self.sidecar.channel = Recorder("channel", self.stopped)
        self.sidecar.instance = Recorder("instance", self.stopped)

    def test_everything_is_stopped_once_in_order(self):
        self.sidecar.stop()
        self.assertEqual(self.stopped, [
            "completer", "debug", "run", "measurements",
            "console", "kernel", "models", "channel", "instance",
        ])

    def test_asking_twice_stops_everything_once(self):
        # Exactly what a quit does: the frame and the closed pipe.
        self.sidecar.stop()
        self.sidecar.stop()
        self.assertEqual(len(self.stopped), 9, self.stopped)

    def test_two_threads_asking_together_stop_everything_once(self):
        # The shape that produced the orphans. The first step is slow so the
        # two genuinely overlap rather than passing each other.
        self.sidecar.completer = Recorder("completer", self.stopped, delay=0.4)
        threads = [threading.Thread(target=self.sidecar.stop) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertFalse(any(thread.is_alive() for thread in threads), "a stop() never returned")
        self.assertEqual(len(self.stopped), 9, self.stopped)

    def test_the_second_caller_waits_rather_than_leaving_early(self):
        # It matters because that caller's next statement is os._exit: returning
        # while the first is half-way through would take the process with it.
        self.sidecar.completer = Recorder("completer", self.stopped, delay=0.5)
        first = threading.Thread(target=self.sidecar.stop)
        first.start()
        while len(self.stopped) == 0:
            time.sleep(0.01)

        self.sidecar.stop()
        self.assertEqual(len(self.stopped), 9, self.stopped)
        first.join(timeout=20)

    def test_a_step_that_raises_does_not_strand_the_ones_after_it(self):
        # A language server that will not die is no reason to leave a kernel
        # behind.
        self.sidecar.debug = Recorder("debug", self.stopped, raises=RuntimeError("no"))
        self.sidecar.stop()
        self.assertIn("instance", self.stopped)

    def test_a_step_that_hangs_is_named_and_left(self):
        """The deadline, and the sentence that makes the next one cheap.

        The real one calls os._exit, which cannot be tested from inside the
        process it exits - so what is held here is the half that has to be right
        for the log to be worth anything: that it fires, and that it knows which
        step it was on.
        """
        gave_up = []
        original = Sidecar._give_up_stopping
        Sidecar._give_up_stopping = lambda self: gave_up.append(self._stop_step)
        self.addCleanup(setattr, Sidecar, "_give_up_stopping", original)

        deadline = main.SHUTDOWN_DEADLINE
        main.SHUTDOWN_DEADLINE = 0.2
        self.addCleanup(setattr, main, "SHUTDOWN_DEADLINE", deadline)

        self.sidecar.measurements = Recorder("measurements", self.stopped, delay=1.5)
        self.sidecar.stop()

        self.assertEqual(gave_up, ["the measurement backend"], gave_up)


if __name__ == "__main__":
    unittest.main()
