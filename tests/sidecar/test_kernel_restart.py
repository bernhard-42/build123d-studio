"""The restart races - M3, §3.3.7, and the internal-request record.

These are the three fixes from `8730a3a` and `a5f2a4b`'s neighbourhood that the
Phase 2 notes are honest about never having reproduced. They were fixed by
reading the code and reasoning about it, which is the weakest kind of fix there
is: nothing distinguishes a race that was cured from one that merely stopped
showing up. The whole point of this file is to remove that distinction.

**Race widening** is what makes it possible. A race whose window is a few
microseconds cannot be caught by running the code more often - the Windows
session established that by trying, and the pre-fix code passed 3/3 against a
46 MB assembly. What works is making the window enormous on purpose: hold the
thread exactly where the real one would have been unlucky, then do the thing the
race needs. The window stops being a matter of luck and becomes an instruction.

Every widening here goes through a seam the production code already has - a
client that blocks where a real one waits on a socket, an iopub callback that
blocks where channel.send would have blocked on _send_lock. Kernel.new_manager
is overridden so no kernel process is started; everything above it is the
shipped code. Nothing is patched.

What each test reproduces, verified by un-applying the fix and watching it fail:

* **M3** - `restart()` used to set one shared stop flag, join the pump with a
  two second timeout, and then *clear* that flag. A pump that had not finished
  in two seconds - one blocked in channel.send, which holds _send_lock for the
  length of an entire model frame - woke up afterwards, found the flag clear
  because the replacement had cleared it, and carried on reading `self.client`:
  the new one. Two threads on one zmq socket, which is the fault that produced
  "Invalid Signature: b'<IDS|MSG>'".
* **§3.3.7** - `shutdown()` closed the channels without holding the shell lock,
  so it could do that underneath a thread part-way through a send. Phase 3c
  replaced the lock with one owning thread, so what these two now hold is the
  ordering that took its place: retire the sender, *then* close what it was
  sending on. The property asserted is unchanged, which is the point - it
  survived the rewrite, and the test is how that is known rather than hoped.
* **the restart swap** - `restart()` rebuilds `self.client`, and since the lanes
  landed it does so on a different thread from the one a Run arrives on. Held
  after 3c by `_ready`, which makes a Run that arrives mid-restart wait for the
  replacement instead of being refused or reaching a torn-down client.
* **_internal_lock** - the request id was recorded *after* the send returned, so
  the kernel could publish a status for a request the pump then failed to
  recognise as internal. The explorer treated its own refresh as user activity
  and queued another. This is the one the Windows session measured: 617
  misclassified statuses before the fix, 2 after.
"""

import threading
import time
import unittest

from fakes import TestableKernel
from kernel import KernelUnavailable
from support import SETTLE

# How long to let a straggler thread misbehave before concluding it will not.
# It only has to lose one race, and it is released before this starts.
MISBEHAVE_WINDOW = 1.0


class RestartRaceTest(unittest.TestCase):
    def setUp(self):
        self.delivered = []
        self.held = threading.Event()
        self.holding = threading.Event()
        self.hold_the_pump = False

    def on_iopub(self, message):
        self.delivered.append((threading.current_thread().name, message))
        if self.hold_the_pump:
            # Where the real pump blocks: channel.send holds _send_lock for the
            # length of an entire model frame, and with nobody draining the
            # socket that is unbounded. The pump waits here instead.
            self.holding.set()
            self.held.wait(timeout=SETTLE * 4)

    def test_a_pump_left_over_from_a_restart_never_touches_the_new_client(self):
        """M3, widened until the straggler is a certainty rather than a chance.

        The old pump is held inside on_iopub across the whole restart, then
        released. If it can reach the replacement, it now will: it wakes up with
        a fresh kernel in place and every reason to keep reading.

        Asserted as "no client was ever read by two threads", which is the fault
        itself - a zmq socket is not thread safe - rather than one of the
        symptoms it produces.
        """
        kernel = TestableKernel(on_iopub=self.on_iopub)
        self.hold_the_pump = True
        kernel.start()
        self.addCleanup(kernel.shutdown)

        first = kernel.clients[0]
        first.deliver()
        self.assertTrue(self.holding.wait(timeout=SETTLE), "the pump never blocked")

        # The restart runs with the old pump stuck. Its join times out, which is
        # the case the whole generation scheme exists for.
        kernel.restart()
        self.assertEqual(len(kernel.clients), 2)
        second = kernel.clients[1]

        # Now let the straggler go, with the replacement already running.
        self.held.set()
        time.sleep(MISBEHAVE_WINDOW)

        for client in (first, second):
            self.assertLessEqual(
                len(client.readers), 1,
                f"{client.name} was read by {sorted(client.readers)} - two threads "
                "on one client is the fault that produces 'Invalid Signature'",
            )
        self.assertEqual(
            second.readers & first.readers, set(),
            "the same thread read both generations' clients",
        )
        self.assertTrue(first.channels_stopped, "the old client was left open")

    def test_the_old_client_is_closed_before_the_replacement_is_read(self):
        """The other half of what makes a straggler harmless.

        A pump that never exits is only safe because the client it holds has
        been closed and its stop flag stays set. If the close were skipped the
        generation scheme would still contain the *reference* while leaving a
        live socket for the straggler to read.
        """
        kernel = TestableKernel(on_iopub=self.on_iopub)
        kernel.start()
        self.addCleanup(kernel.shutdown)
        first = kernel.clients[0]

        kernel.restart()
        self.assertTrue(first.channels_stopped)
        self.assertEqual(kernel.clients[0].name, "gen0")
        self.assertFalse(kernel.clients[1].channels_stopped)

    def test_a_run_arriving_during_a_restart_never_reaches_a_torn_down_client(self):
        """The restart swap, hammered from another thread.

        Restart used to run on the receive thread, which is also where an
        execute came from, so the two could not overlap. It runs on its own lane
        now, so a Run can land while the client is being replaced.

        Two things have to hold. The Run must not reach a torn-down client, and
        a Run that does land in the gap must be *told* so rather than
        disappearing - a frame accepted, queued and never mentioned again is the
        worst of the three outcomes.

        It is refused rather than held for the replacement, deliberately. The
        held version was written first and could not be reached: the frontend
        covers the window with a full-screen overlay, and Run's keybindings need
        editor focus that clicking Restart has already taken. What it did reach
        was the failure path, where a kernel that never came back left every
        later request waiting out a ninety second grace period.

        Widened by hammering rather than by blocking, because this window is
        opened by the restart itself and is already milliseconds wide - the
        widening that matters is the number of attempts landing inside it.
        """
        kernel = TestableKernel(on_iopub=lambda message: None)
        kernel.start()
        self.addCleanup(kernel.shutdown)

        stop = threading.Event()
        refused = []
        surprises = []

        def keep_running_code():
            while not stop.is_set():
                try:
                    kernel.execute("1 + 1")
                except KernelUnavailable as exc:
                    # The correct answer for a Run that lands in the gap.
                    refused.append(str(exc))
                except Exception as exc:  # noqa: BLE001 - recorded, not raised
                    surprises.append(repr(exc))

        runner = threading.Thread(target=keep_running_code, name="run-hammer")
        runner.start()
        try:
            for _ in range(5):
                kernel.restart()
        finally:
            stop.set()
            runner.join(timeout=SETTLE)

        stopped = [
            (client.name, client.executed_after_stop)
            for client in kernel.clients
            if len(client.executed_after_stop) > 0
        ]
        self.assertEqual(stopped, [], f"a Run reached a client whose channels were closed: {stopped}")
        # Anything other than a clear refusal is the failure this is watching
        # for: a Run must not die of something the user cannot be told about.
        self.assertEqual(surprises, [])

    def test_shutdown_waits_for_a_send_that_is_already_in_flight(self):
        """§3.3.7, which was fixed on the strength of an argument alone.

        stop() is called on the way out of the process, where an inspection on
        the inspect lane or a Run on the execute lane can still be part-way
        through a send. Closing the socket underneath one of them is the same
        fault as two threads sharing it, at the least convenient moment - benign
        only because os._exit(0) follows, and "benign because of what happens
        next" is not a property to leave lying around in threaded code.

        Held by a lock when this was written and by an ordering since 3c -
        retire the only sender, then close. The test did not change, which is
        what makes it worth having: it is stated in terms of what must be true
        rather than of the mechanism that happened to be true at the time.

        Widened by blocking inside the shell channel's send, which is where the
        real one is inside a zmq send.
        """
        in_send = threading.Event()
        release = threading.Event()

        def block_once(_msg_id):
            if not in_send.is_set():
                in_send.set()
                release.wait(timeout=SETTLE * 2)

        kernel = TestableKernel(on_iopub=lambda message: None, on_execute=block_once)
        kernel.start()
        client = kernel.clients[0]

        sender = threading.Thread(target=lambda: kernel.execute("x"), name="sender")
        sender.start()
        self.assertTrue(in_send.wait(timeout=SETTLE), "the send never started")

        closed_early = []

        def shut_down():
            kernel.shutdown()

        closer = threading.Thread(target=shut_down, name="closer")
        closer.start()

        # The send is still in flight. Nothing may have closed the channels.
        time.sleep(MISBEHAVE_WINDOW)
        if client.channels_stopped:
            closed_early.append("stop_channels ran while a send was in flight")

        release.set()
        sender.join(timeout=SETTLE)
        closer.join(timeout=SETTLE)

        self.assertEqual(closed_early, [])
        self.assertTrue(client.channels_stopped, "the shutdown never completed")


class InternalRequestRecordTest(unittest.TestCase):
    """_internal_lock: the gap between sending a request and calling it ours.

    The id used to be recorded after the send returned. The kernel can answer
    inside that gap - it publishes busy for a request the pump then fails to
    recognise as internal - and the refresh that follows every idle is the one
    that hits it. A leaked pair is visible in any Windows log of the period as a
    busy and an idle a millisecond apart, right after the warm-up. The toolbar
    flickers, and the explorer treats its own refresh as user activity and
    queues another: the exact loop the deque exists to prevent, arrived at by
    losing a race rather than by forgetting.

    Widened by asking the question from inside the shell channel's send - which
    is to say, at the precise moment the kernel would be answering. That turns a
    microsecond window into every single iteration.
    """

    ROUNDS = 100

    # Long enough for the asking thread to reach _internal_lock, which is all the
    # widening needs: from there the fix makes it wait and the defect lets it
    # through. Not a synchronisation - just enough head start that it arrives
    # inside the window on every round instead of one round in thousands.
    HEAD_START = 0.002

    def test_a_status_arriving_during_the_send_is_still_recognised_as_internal(self):
        answers = []
        answers_lock = threading.Lock()
        askers = []

        def ask_from_inside_the_send(msg_id):
            # The kernel, answering while the sender has not yet returned. In
            # production this thread is the iopub pump and the window is however
            # long a zmq send takes.
            answer = kernel.is_internal({"parent_header": {"msg_id": msg_id}})
            with answers_lock:
                answers.append(answer)

        def on_execute(msg_id):
            # Started and deliberately *not* joined here. Joining would wait for
            # _internal_lock, which this very thread is holding - so with the fix
            # in place the test would deadlock against its own correctness, and
            # the only version that ran quickly would be the broken one.
            asker = threading.Thread(
                target=ask_from_inside_the_send, args=(msg_id,), name="fake-kernel"
            )
            asker.start()
            askers.append(asker)
            time.sleep(self.HEAD_START)

        kernel = TestableKernel(on_iopub=lambda message: None, on_execute=on_execute)
        kernel.start()
        self.addCleanup(kernel.shutdown)

        for _ in range(self.ROUNDS):
            kernel.evaluate("1", timeout=0.02)
        for asker in askers:
            asker.join(timeout=SETTLE)

        missed = len([answer for answer in answers if answer is not True])
        self.assertEqual(len(answers), self.ROUNDS, "the widening did not run every round")
        self.assertEqual(
            missed, 0,
            f"{missed}/{self.ROUNDS} internal requests were misread as user activity, "
            "each of which is a spurious variable-explorer refresh and a toolbar flicker",
        )


class LaunchWindowTest(unittest.TestCase):
    """The window between spawning a kernel and being able to name it.

    `shutdown()` guards every step on `if self.manager is not None`, and
    `start()` used to assign `self.manager` only once the process was already
    running - the manager was built and its kernel launched inside one call,
    and the result assigned afterwards. So for the whole length of a launch
    there was a live kernel process that a concurrent stop could not see, and
    left behind. `wait_for_ready` sits inside that same window and allows sixty
    seconds of it.

    Reached from two directions. A restart comes back through `start()`, so a
    stop landing during one found None and left the fresh kernel running - which
    is where it was first read. And once teardown can begin before startup has
    finished, an ordinary quit reaches it too.

    Un-applied by moving the assignment back below `spawn()`: `self.manager` is
    None while the process starts, and both assertions below fail.

    Publishing it is necessary and was not sufficient. A stop landing between
    the assignment and the spawn finds a manager with no kernel behind it: it
    cannot stop what does not exist, and spawning afterwards would put a kernel
    behind a shutdown that has already run. So start() asks again once the
    manager is published, and refuses. Both halves are held below.
    """

    def test_the_manager_is_nameable_before_the_process_is_started(self):
        seen = []

        class Watching(TestableKernel):
            def spawn(self, manager):
                seen.append(self.manager)
                super().spawn(manager)

        kernel = Watching(on_iopub=lambda message: None)
        self.addCleanup(kernel.shutdown)
        kernel.start()

        self.assertEqual(len(seen), 1, "the process was not started through spawn()")
        self.assertIsNotNone(seen[0], "the kernel was spawned before it could be named")
        self.assertIs(seen[0], kernel.manager, "a different manager was published")

    def test_a_kernel_is_not_spawned_after_a_shutdown_has_run(self):
        """Publishing the manager is not the same as being able to stop it.

        The window is real rather than theoretical: `stop()` runs on the
        channel's receive thread while a restart runs on a lane, so a quit
        arriving during one lands here. Before this the shutdown found a manager
        with no kernel, could stop nothing, and the spawn a moment later put a
        live kernel behind a shutdown step that had already run - collected only
        by the parent poller, which is the contract the teardown exists so as
        not to depend on.

        Un-applied by removing the check between the assignment and spawn():
        the process is started and the test says so.
        """
        started = []

        class StoppingMidLaunch(TestableKernel):
            def new_manager(self):
                manager = super().new_manager()
                # Exactly the instant the manager is published and the process
                # does not exist yet.
                self.shutdown()
                return manager

            def spawn(self, manager):
                started.append("spawn")
                super().spawn(manager)

        kernel = StoppingMidLaunch(on_iopub=lambda message: None)
        self.addCleanup(kernel.shutdown)

        kernel.start()

        self.assertEqual(started, [], "a kernel was spawned after its shutdown ran")
        self.assertIsNone(kernel.manager, "a manager with no kernel was left published")

    def test_the_process_is_started_after_the_manager_is_published(self):
        # The other half, and the one that would catch a fix that published the
        # manager by starting the kernel earlier instead of later.
        order = []

        class Recording(TestableKernel):
            def spawn(self, manager):
                order.append("spawn")
                super().spawn(manager)

            def new_manager(self):
                order.append("build")
                return super().new_manager()

        kernel = Recording(on_iopub=lambda message: None)
        self.addCleanup(kernel.shutdown)
        kernel.start()

        self.assertEqual(order, ["build", "spawn"])
        self.assertTrue(kernel.manager.started, "the kernel process was never started")


class QuitDuringRestartTest(unittest.TestCase):
    """M22, and the second fault under it.

    Found by hand on 2026-08-17, macOS: Restart Kernel followed immediately by a
    quit left the sidecar running with no kernel and no console, but with the
    measurement backend and the language server still under it. `sample` on the
    stuck process put the receive thread inside `zmq_ctx_term`, holding
    Sidecar.stop()'s first step.

    The mechanism, and it is upstream rather than subtle: jupyter_client's
    cleanup_resources calls `context.destroy(linger=100)`, and pyzmq documents
    that destroy closes sockets, which is not thread safe - "if there are active
    sockets in other threads, this must not be called". `term()` then waits for
    every socket in the context to be closed, with no timeout and nothing to
    interrupt it. restart() and shutdown() both reach `_shutdown()`, and nothing
    made them exclusive, so a quit landing inside a restart's start() destroyed
    a context the control lane was still building on.

    Widened the way the rest of this file does it, through a seam the production
    code already has: the replacement client blocks inside `wait_for_ready`,
    which is where a real one waits up to sixty seconds for its kernel to
    answer. The quit then arrives while the restart is provably mid-build,
    instead of when it happens to be unlucky.

    Un-applied by taking `_lifecycle` out of restart(), start() and shutdown():
    the quit runs straight through the held start, and `cleaned_mid_build` says
    so - which in the real one is the term() that never returns.
    """

    def setUp(self):
        self.building = threading.Event()
        self.release = threading.Event()

    def _held_replacement(self, client):
        # The first kernel comes up normally; only the restart's replacement is
        # held, so the test's own setup cannot be what blocks.
        if client.name == "gen0":
            return
        self.building.set()
        self.release.wait(timeout=SETTLE * 4)

    def test_a_quit_landing_inside_a_restart_does_not_tear_down_what_it_is_building(self):
        kernel = TestableKernel(on_iopub=lambda message: None, on_ready=self._held_replacement)
        kernel.start()

        restarter = threading.Thread(target=kernel.restart, name="lane-control")
        restarter.start()
        self.assertTrue(self.building.wait(timeout=SETTLE), "the restart never reached its wait")

        replacement = kernel.clients[1]
        manager = kernel.managers[1]

        quit_done = threading.Event()
        quitter = threading.Thread(
            target=lambda: (kernel.shutdown(), quit_done.set()), name="receive",
        )
        quitter.start()

        # The restart is still inside start(). Nothing may reach into what it is
        # building, and the quit must be waiting rather than working.
        time.sleep(MISBEHAVE_WINDOW)
        touched = []
        if manager.cleaned_mid_build:
            touched.append("the context was destroyed while the restart was building on it")
        if replacement.channels_stopped:
            touched.append("the replacement's channels were closed underneath its own start")
        if quit_done.is_set():
            touched.append("the quit tore down a kernel that was still being built")

        self.release.set()
        restarter.join(timeout=SETTLE * 2)
        self.assertTrue(quit_done.wait(timeout=SETTLE * 2), "the quit never finished")
        quitter.join(timeout=SETTLE)

        self.assertEqual(touched, [])
        # And it did finish the job rather than merely staying out of the way:
        # the kernel the restart built is stopped, and by the quit.
        self.assertTrue(replacement.channels_stopped, "the replacement was left running")
        self.assertTrue(manager.cleaned, "the replacement's resources were never released")
        self.assertFalse(manager.cleaned_mid_build, "it was cleaned up mid-build after all")

    def test_a_restart_that_arrives_after_the_quit_does_not_spawn_one(self):
        """The other order, which the same lock makes answerable.

        A restart queued on the control lane can be dispatched after stop() has
        run - the lanes keep delivering while the teardown walks its steps, and
        Sidecar refuses the ones it knows about for exactly this reason. Here it
        is refused at the kernel itself, so the answer does not depend on which
        caller remembered to ask.
        """
        kernel = TestableKernel(on_iopub=lambda message: None)
        kernel.start()
        self.assertEqual(len(kernel.clients), 1)

        kernel.shutdown()
        restarted = kernel.restart()

        self.assertEqual(len(kernel.clients), 1, "a kernel was started after the shutdown")
        self.assertFalse(restarted, "it claimed to have restarted")


if __name__ == "__main__":
    unittest.main()
