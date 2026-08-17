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

import os
import shutil
import signal
import subprocess
import sys
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
            "kernel", "completer", "debug", "run", "measurements",
            "console", "models", "channel", "instance",
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

    def test_a_frame_arriving_during_the_teardown_starts_nothing(self):
        """The lanes keep delivering while stop() walks its steps.

        A frame queued before the teardown began is dispatched during it, and a
        handler that spawns answers it by starting a process whose stop step has
        already run. Each is collected in the end by a parent-death contract -
        a poller, a pty, a pipe - so they are orphans of seconds rather than
        leaks, which is exactly why they are worth refusing: those contracts are
        what this teardown exists so as not to depend on.

        Un-applied by removing the _refusing checks: the run starts.
        """
        started = []

        class Runner(Recorder):
            def start(self, *args, **arguments):
                started.append("run")

        self.sidecar.run = Runner("run", self.stopped)
        self.sidecar.stop()

        self.sidecar.on_run_start({"path": "/p/part.py"})

        self.assertEqual(started, [], "a run was started after its stop step")

    def test_a_step_that_raises_does_not_strand_the_ones_after_it(self):
        # A language server that will not die is no reason to leave a kernel
        # behind.
        self.sidecar.debug = Recorder("debug", self.stopped, raises=RuntimeError("no"))
        self.sidecar.stop()
        self.assertIn("instance", self.stopped)

    def test_the_kernel_is_gone_before_the_deadline_can_fire(self):
        """The kernel goes first because its fallback is the weakest.

        Every other child holds a contract that takes it with us if stop()
        never reaches it - a pty that closes, a pipe that ends, a process id it
        was told to watch. The kernel's is a Python thread polling for its
        parent, and a user computation inside one long OCCT call holds the GIL
        for its whole duration, so that thread cannot run and the kernel cannot
        notice we have gone. Left running it holds a loaded geometry kernel and
        whatever the namespace was carrying.

        So the property is not "the kernel is stopped" - it was, eventually,
        sixth. It is that it is already stopped at the moment the deadline
        fires, whatever else is holding things up.

        Un-applied by putting the kernel back after the language server: the
        snapshot taken when the watchdog fires does not contain it.
        """
        stopped = self.stopped
        fired = []

        class Watched(Sidecar):
            def _give_up_stopping(self):
                # The real one calls os._exit, which cannot be tested from
                # inside the process it exits. What is captured instead is what
                # had been stopped by the time it fired.
                fired.append(list(stopped))

        sidecar = Watched(env_root=self.root, app_dir=self.root, instance=self.instance)
        for name in ["completer", "debug", "run", "measurements",
                     "console", "kernel", "models", "channel", "instance"]:
            setattr(sidecar, name, Recorder(name, stopped))
        # The language server is what used to spend the whole budget, and it is
        # the step that sat in front of the kernel.
        sidecar.completer = Recorder("completer", stopped, delay=1.5)

        deadline = main.SHUTDOWN_DEADLINE
        main.SHUTDOWN_DEADLINE = 0.2
        self.addCleanup(setattr, main, "SHUTDOWN_DEADLINE", deadline)

        sidecar.stop()

        self.assertEqual(len(fired), 1, "the deadline never fired, so this proves nothing")
        self.assertIn("kernel", fired[0], f"the kernel was still running: {fired[0]}")

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


class StartupAbandonedTest(unittest.TestCase):
    """A stop that arrives during startup has to stop the startup as well.

    `shutdown` is registered with no lane, so the frame is handled inline on the
    channel's receive thread - while start() is still working down the main one.
    The two used to pass each other in the middle: stop() walked the subsystems
    that existed at that instant, start() went on to bring up the ones that did
    not, and the kernel and console spawned afterwards had already had their
    shutdown step run. os._exit then took the sidecar and left them behind, held
    only by their own parent-death contracts - which is precisely what the
    teardown exists so as not to depend on.

    Un-applied by removing the `_abandoning_startup` checks from start(): the
    kernel and the console are brought up after the stop and both assertions
    below fail.

    The two spawning steps are overridden rather than stubbed on the instance,
    so what runs is the shipped start() and the shipped stop().
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="studio-startup-")
        self.instance = Instance(self.root)
        self.instance.claim()
        self.addCleanup(self.instance.release)
        self.started = []
        self.stopped = []

    def _sidecar(self):
        started = self.started

        class Recording(Sidecar):
            """The two steps that spawn a process, recorded instead."""

            def kernel_start(self):
                started.append("kernel")
                return {"connection_file": "", "transport": "tcp"}

            def console_start(self):
                started.append("console")

        return Recording(env_root=self.root, app_dir=self.root, instance=self.instance)

    def test_nothing_further_is_brought_up_once_a_stop_has_begun(self):
        sidecar = self._sidecar()
        started = self.started

        class StopsAsItComesUp:
            """The model channel, with the shutdown frame landing on its heels."""

            port = 0
            token = "token"

            def start(self):
                started.append("models")
                # Where the receive thread would have run it.
                sidecar.stop()
                return 0

            def stop(self):
                pass

        class Channel(Recorder):
            def send(self, *args, **arguments):
                pass

            def submit(self, lane, work):
                started.append("submitted")

        class Measurements(Recorder):
            # Records rather than refusing, so that without the guard this test
            # reaches its own assertion instead of dying on a missing attribute.
            def start(self):
                started.append("measurements")

            def warm(self):
                pass

        class Completer(Recorder):
            def warm(self):
                started.append("completer warmed")

        sidecar.models = StopsAsItComesUp()
        sidecar.completer = Completer("completer", self.stopped)
        sidecar.debug = Recorder("debug", self.stopped)
        sidecar.run = Recorder("run", self.stopped)
        sidecar.measurements = Measurements("measurements", self.stopped)
        sidecar.channel = Channel("channel", self.stopped)
        sidecar.instance = Recorder("instance", self.stopped)

        sidecar.start()

        self.assertEqual(started, ["models"], f"startup carried on past the stop: {started}")
        self.assertIsNone(sidecar.kernel, "a kernel was started after its shutdown step")
        self.assertIsNone(sidecar.console, "a console was started after its shutdown step")

    def test_an_ordinary_startup_is_not_abandoned(self):
        # The other direction, so the guard cannot pass by refusing everything.
        sidecar = self._sidecar()
        started = self.started

        class Models:
            port = 0
            token = "token"

            def start(self):
                started.append("models")
                return 0

            def stop(self):
                pass

        class Channel(Recorder):
            def send(self, *args, **arguments):
                pass

            def submit(self, lane, work):
                pass

        class Measurements(Recorder):
            def start(self):
                started.append("measurements")

            def warm(self):
                pass

        sidecar.models = Models()
        sidecar.measurements = Measurements("measurements", self.stopped)
        sidecar.channel = Channel("channel", self.stopped)

        sidecar.start()

        self.assertEqual(started, ["models", "measurements", "kernel", "console"])


class StdinDuringStartupTest(unittest.TestCase):
    """A quit that lands mid-launch, against the real process.

    The other tests here drive stop() directly. This one is about *when* stdin
    is read, which is a property of main() and of nothing smaller: the read
    used to be reached only once startup had returned, so a sidecar told to go
    while it was still launching a kernel carried on launching it. Sixty
    seconds of wait_for_ready sit inside that window, and a first run - cold
    imports, a slow machine - is exactly when somebody gives up and closes it.

    So it spawns the shipped entry point and closes its stdin. The sidecar is
    held in startup by having nobody connect: it announces its port and then
    waits for a webview, which is where a real one would be during a launch.

    Un-applied by moving watch_stdin() back below sidecar.start(): nothing
    reads stdin until the wait for a client times out, and the assertion below
    fails on the clock.
    """

    # Comfortably inside the sidecar's own wait for a client, so arriving
    # under it cannot be that timeout being mistaken for a shutdown.
    HEARD = 10.0

    def test_a_signal_runs_the_teardown_rather_than_skipping_it(self):
        """SIGTERM must not be the one way out that stops nothing.

        Without a handler the default disposition ends the process and stop()
        never runs, so every child falls back to its own contract. That is fine
        for the ones held by a pipe or a pty and it is not fine for the kernel:
        its contract is a Python thread polling for its parent, and a user
        computation inside one long OCCT call holds the GIL for the whole of it.
        The kernel cannot notice we have gone until the call returns - never,
        for a runaway one - while holding a loaded geometry kernel.

        Reachable by `kill <sidecar-pid>`, and by a Linux logout that SIGTERMs
        before it SIGKILLs.

        Un-applied by removing take_signals(): the process still dies, so what
        this asserts is the exit *code*, which only the handler produces.
        """
        repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        root = tempfile.mkdtemp(prefix="studio-signal-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)

        process = subprocess.Popen(
            [sys.executable, os.path.join(repo, "sidecar", "main.py"),
             "--env-root", root, "--app-dir", repo],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self._reap, process)

        announced = process.stdout.readline()
        self.assertIn(b"listening", announced, f"no handshake: {announced!r}")
        self.assertIsNone(process.poll(), "it exited before it was signalled")

        started = time.monotonic()
        process.send_signal(signal.SIGTERM)
        try:
            code = process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.fail("the sidecar did not act on SIGTERM")
        heard = time.monotonic() - started

        self.assertLess(heard, 10, f"SIGTERM took {heard:.1f}s")
        # The handler's own exit. The default disposition would be -SIGTERM.
        self.assertEqual(code, 0, "the teardown did not run; the default disposition did")

    def test_the_sidecar_goes_when_stdin_closes_during_startup(self):
        repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        root = tempfile.mkdtemp(prefix="studio-stdin-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)

        process = subprocess.Popen(
            [sys.executable, os.path.join(repo, "sidecar", "main.py"),
             "--env-root", root, "--app-dir", repo],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self._reap, process)

        # The handshake line means bound and announced, so the next thing it
        # does is wait for the client that this test never provides.
        announced = process.stdout.readline()
        self.assertIn(b"listening", announced, f"no handshake: {announced!r}")

        # Still running when stdin is closed, or the timing below measures a
        # sidecar that had already fallen over for some reason of its own.
        self.assertIsNone(process.poll(), "the sidecar exited before it was asked to")

        started = time.monotonic()
        process.stdin.close()
        try:
            process.wait(timeout=self.HEARD * 3)
        except subprocess.TimeoutExpired:
            self.fail("the sidecar never noticed its stdin close")
        heard = time.monotonic() - started

        self.assertLess(heard, self.HEARD, f"stdin took {heard:.1f}s to be heard")

    def _reap(self, process):
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        for stream in (process.stdout, process.stdin):
            try:
                stream.close()
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
