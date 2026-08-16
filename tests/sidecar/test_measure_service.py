"""The measurement backend, in the process it now lives in.

Two things are being held here, and neither is about geometry - the integration
suite drives a real tessellation through a real viewer selection, which is
where the numbers are checked.

The first is that the sidecar no longer imports OCP at all. That is the whole
point of the split: loading a .pyd holds the Windows loader lock while CPython
holds the GIL, and every thread this process starts wants that lock, so the
import and any overlapping thread creation deadlock permanently. Measured, the
import costs 2.0 s on macOS, 3.3 s on a warm Windows start and 10.3 s cold.

The second is that a backend which dies, or never loads, must not take a
measure click down with it. It is the last thing a user reaches for and the
least important thing in the window.
"""

import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from measure_service import MeasurementService

SIDECAR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class MeasurementServiceTest(unittest.TestCase):
    def setUp(self):
        self.service = MeasurementService()
        self.addCleanup(self.service.stop)

    def test_it_answers_from_another_process(self):
        self.service.start()
        # Through the public warm-up, which is what startup calls: it cannot
        # return until the import has finished and the backend is constructed.
        self.service.warm()
        self.assertTrue(self.service._process.poll() is None)

    def test_the_sidecar_itself_never_imports_the_backend(self):
        """The claim the whole design rests on, checked where it is true.

        In a fresh interpreter, not this one: the suite shares a process and
        another test importing OCP would satisfy the assertion without the
        sidecar having anything to do with it. What matters is that importing
        main.py - everything the sidecar is - does not reach the native stack,
        because if it did, the Windows loader lock would be back in the process
        that starts threads and none of the rest of this would matter.
        """
        probe = (
            "import sys, main;"
            "print(','.join(n for n in ('measure', 'OCP', 'ocp_vscode.backend', 'build123d')"
            " if n in sys.modules))"
        )
        environment = dict(os.environ)
        environment["PYTHONPATH"] = os.path.join(SIDECAR, "sidecar")
        result = subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True, text=True, env=environment, cwd=SIDECAR, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(), "",
            f"importing the sidecar pulled in {result.stdout.strip()}",
        )

    def test_a_selection_with_nothing_shown_answers_nothing(self):
        # Not an error: opening a measure tool before any show() is ordinary,
        # and there is genuinely nothing to say about it.
        self.service.start()
        self.assertIsNone(self.service.handle_changes({"tool": "distance"}))

    def test_a_mapping_that_is_not_a_model_is_reported_rather_than_fatal(self):
        self.service.start()
        self.service.load(b'{"not": "a model"}')

        self.assertIsNone(self.service.handle_changes({"tool": "distance"}))
        # And the process is still there to answer the next one.
        self.service.warm()
        self.assertIsNone(self.service._process.poll())

    def test_a_backend_that_died_is_started_again(self):
        # It is a child process and a user can kill it, or it can run out of
        # memory indexing a large assembly. Losing measurement until the
        # application restarts would be a poor answer to either.
        self.service.start()
        self.service.warm()
        first = self.service._process.pid

        self.service._process.kill()
        self.service._process.wait(timeout=10)

        self.service.warm()
        self.assertIsNotNone(self.service._process)
        self.assertNotEqual(self.service._process.pid, first)

    def test_stop_takes_the_process_with_it(self):
        # Killed rather than asked, and the next test is why: asking politely
        # means closing stdin, closing a buffered writer flushes it, and a flush
        # into a backend that is not reading is exactly the thing a quit must
        # not wait for.
        self.service.start()
        self.service.warm()
        process = self.service._process

        self.service.stop()

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and process.poll() is None:
            time.sleep(0.05)
        self.assertIsNotNone(process.poll(), "the measurement process outlived stop()")

    def test_the_model_crosses_once_rather_than_once_per_show(self):
        # load() is called on every show() and a mapping is serialised BRep. It
        # is held here and sent when somebody measures, so a hundred shows cost
        # nothing and the first measurement pays one transfer.
        self.service.start()
        self.service.warm()

        for index in range(5):
            self.service.load(f'{{"show": {index}}}'.encode("utf-8"))
        self.assertFalse(self.service._sent, "a show sent the model across")

        self.service.handle_changes({"tool": "distance"})
        self.assertTrue(self.service._sent)

        # And it is not sent again for the next selection of the same model.
        self.service._sent = "watched"
        self.service.handle_changes({"tool": "distance"})
        self.assertEqual(self.service._sent, "watched")


    def test_the_transfer_and_the_answer_are_timed_separately(self):
        """Because 'measuring took 2.4 seconds' is three facts, not one.

        The gap between a model arriving and being indexed contains the mapping
        crossing the pipe, the backend walking it, and however long the user
        took to click. Only the first is new, and it was invisible - the model
        log line reports the header and the payload and has never reported the
        mapping's size.
        """
        lines = []
        import measure_service
        original = measure_service.log
        measure_service.log = lambda *parts: lines.append(" ".join(str(p) for p in parts))
        self.addCleanup(setattr, measure_service, "log", original)

        self.service.start()
        self.service.load(b'{"not": "a model"}')
        self.service.handle_changes({"tool": "distance"})

        sent = [line for line in lines if "Measurement model sent" in line]
        answered = [line for line in lines if "Measurement answered in" in line]
        self.assertEqual(len(sent), 1, lines)
        self.assertIn(f"{len(b'{\"not\": \"a model\"}')} B", sent[0])
        self.assertEqual(len(answered), 1, lines)

        # And the second selection of the same model does not send it again.
        self.service.handle_changes({"tool": "distance"})
        self.assertEqual(len([line for line in lines if "model sent" in line]), 1)


class SayingSoTest(unittest.TestCase):
    """A backend that dies and comes back must not do it silently.

    He killed the measurement process by hand to see the toolbar chip, and
    nothing happened at all - because the service notices on the next request,
    respawns, re-sends the mapping and answers, which is exactly what it is for.
    Measurement went on working and no part of the application ever said that a
    process of ours had been killed. That is the failure this whole health model
    exists for, one level down from where it was being looked for.
    """

    def setUp(self):
        self.said = []
        self.service = MeasurementService(on_state=lambda s, d: self.said.append((s, d)))
        self.addCleanup(self.service.stop)

    def test_a_backend_that_is_killed_says_so_and_says_when_it_is_back(self):
        self.service.start()
        self.service.warm()
        self.assertEqual(self.said, [("ready", "")])

        self.service._process.kill()
        self.service._process.wait(timeout=10)

        # The next measurement is what notices - nothing is watching the process.
        self.service.load(b'{"not": "a model"}')
        self.service.handle_changes({"tool": "distance"})

        states = [state for state, _ in self.said]
        self.assertEqual(states, ["ready", "degraded", "ready"], self.said)
        self.assertIn("restarted", self.said[1][1])

    def test_a_backend_that_cannot_come_back_ends_up_failed(self):
        """His question: what if it cannot be started any more?

        Two shapes, and they used to behave differently. If the *spawn* fails -
        no interpreter, no script - it is reported at once. If it spawns and
        dies on its import, which is what a half-finished package upgrade looks
        like, the spawn succeeds and only the round trip knows: that path
        announced `degraded` for the respawn and then nothing at all, so the
        chip sat on amber for ever while every measurement produced nothing.
        """
        handle = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        handle.write("import sys\n"
                     "print('ModuleNotFoundError: No module named OCP', file=sys.stderr)\n"
                     "raise SystemExit(1)\n")
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        self.service._script = handle.name

        self.service.start()
        self.service.load(b'{"not": "a model"}')
        for _ in range(3):
            self.assertIsNone(self.service.handle_changes({"tool": "distance"}))

        self.assertEqual(self.said[-1][0], "failed", self.said)
        self.assertIn("stopped answering", self.said[-1][1])
        # And it stays there rather than flapping between degraded and failed as
        # each doomed replacement is spawned and dies.
        self.assertEqual([state for state, _ in self.said].count("failed"), 1, self.said)

    def test_a_measurement_with_nothing_shown_clears_a_failure_too(self):
        """The chip read `failed` while measurement plainly worked.

        Because the splash can be measured now, and the branch that made it
        measurable returned straight out of the request - past the line that
        announces recovery. So with a model shown the state came back to
        `ready`, and with nothing shown the same working measurement left
        `failed` on screen. One exit, so a measurement means the same thing
        whatever is on screen.
        """
        self.service.start()
        self.service.warm()

        real = self.service._script
        self.service._script = "/no/such/measure_process.py"
        self.service._process.kill()
        self.service._process.wait(timeout=10)
        # Deliberately no load(): nothing has been shown, so this measures the
        # splash the backend loaded for itself.
        self.assertIsNone(self.service.handle_changes({"tool": "distance"}))
        self.assertEqual(self.said[-1][0], "failed", self.said)

        self.service._script = real
        self.service.handle_changes({"tool": "distance"})
        self.assertEqual(self.said[-1][0], "ready", self.said)

    def test_the_way_out_is_not_reported_as_a_fault(self):
        # stop() kills it, which is the same broken round trip seen from the
        # inside - and a subsystem report into a channel that is closing is
        # noise about a process nobody expects to be alive.
        self.service.start()
        self.service.warm()
        self.service.stop()
        self.assertEqual([state for state, _ in self.said], ["ready"], self.said)

    def test_it_does_not_say_the_same_thing_twice(self):
        # Ordinary use is a measurement per mouse move while a tool is active.
        # Announcing `ready` on each would be a frame per click and a line per
        # drag, which is how a chip that means something becomes wallpaper.
        self.service.start()
        self.service.warm()
        self.service.load(b'{"not": "a model"}')
        for _ in range(5):
            self.service.handle_changes({"tool": "distance"})

        self.assertEqual(self.said, [("ready", "")], self.said)


class DeafBackendTest(unittest.TestCase):
    """A backend that never reads its input, which is what hung a quit.

    Seven sidecars were found on this machine outliving the application that
    started them, each still holding a kernel, a console and a measurement
    backend. The measurement half of that is here: a request holds the service
    lock for its whole round trip, a mapping is megabytes against a 64 kB pipe
    buffer, and both the old stop() and the old watchdog assumed the only place
    a round trip can get stuck is the reply.

    A process that sleeps and reads nothing is the whole fake needed. Nothing
    here is about geometry.
    """

    def setUp(self):
        handle = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        handle.write("import time\ntime.sleep(300)\n")
        handle.close()
        self.script = handle.name
        self.addCleanup(os.unlink, self.script)
        self.service = MeasurementService(script=self.script)
        self.addCleanup(self.service.stop)

    def _mapping_too_big_for_the_pipe(self):
        # Four megabytes against a 64 kB buffer: the write cannot complete, and
        # it cannot complete for reasons that have nothing to do with timing.
        return b'{"junk": "' + b"x" * (4 << 20) + b'"}'

    def test_a_write_nobody_reads_is_bounded(self):
        # The watchdog used to be armed after the write it was meant to bound.
        self.service.REPLY_TIMEOUT = 1
        self.service.start()
        self.service.load(self._mapping_too_big_for_the_pipe())

        started = time.monotonic()
        self.assertIsNone(self.service.handle_changes({"tool": "distance"}))
        self.assertLess(time.monotonic() - started, 20, "the write was never given up on")

    def test_stop_does_not_wait_for_a_request_in_flight(self):
        self.service.start()
        self.service.load(self._mapping_too_big_for_the_pipe())

        blocked = threading.Thread(
            target=self.service.handle_changes, args=({"tool": "distance"},), daemon=True
        )
        blocked.start()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not self.service._lock.locked():
            time.sleep(0.01)
        self.assertTrue(self.service._lock.locked(), "the request never started")
        # Long enough to be sure it is stuck in the write rather than on its way
        # there. It has nowhere else to be: the backend reads nothing.
        time.sleep(0.5)
        self.assertTrue(blocked.is_alive(), "the write was not blocked, so this proves nothing")

        started = time.monotonic()
        self.service.stop()
        waited = time.monotonic() - started

        self.assertLess(waited, 5, f"stop() waited {waited:.1f}s for a blocked request")
        blocked.join(timeout=10)
        self.assertFalse(blocked.is_alive(), "the blocked request never came back")


class MeasureProcessTest(unittest.TestCase):
    """The child on its own, without the service in front of it."""

    def test_it_exits_when_its_input_closes(self):
        # The sidecar's shutdown depends on this: no signal, no message, just a
        # closed pipe.
        process = subprocess.Popen(
            [sys.executable, "-u", os.path.join(SIDECAR, "sidecar", "measure_process.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=os.path.join(SIDECAR, "sidecar"),
        )
        process.stdin.close()
        self.assertEqual(process.wait(timeout=60), 0)

    def test_it_creates_no_threads(self):
        # The property that makes the import safe on Windows, asserted where it
        # can be checked rather than left in a comment. A thread started in this
        # process would need the loader lock the import is holding.
        source = open(os.path.join(SIDECAR, "sidecar", "measure_process.py")).read()
        self.assertNotIn("threading", source)
        self.assertNotIn("Thread(", source)


if __name__ == "__main__":
    unittest.main()

class RealMeasurementTest(unittest.TestCase):
    """A measurement of a real model, through the real process.

    Every other case here feeds the service a mapping that is not a model, which
    is why this class exists: those never reach the code that *answers*, and the
    defect this catches lives there.

    The shared backend prints what it is doing - "Identifiers received
    '/Group/Solid/edges/edges_4'" - because in OCP CAD Viewer that stream is a
    terminal somebody watches. In this host stdout is the protocol: length-
    prefixed JSON, one reply per request. A single printed sentence is read as a
    length prefix, and from then on the answers are garbage or never come at
    all. Measurements silently stop working, and because the blocked read holds
    the lock a freshly shown model needs, the next show() can block with it.

    The fixture is a real tessellation's mapping, captured from `Box(1, 2, 3)`
    through the shipped pipeline - serialised BREP, which is what makes the
    backend take a real measurement rather than refuse the input.
    """

    def setUp(self):
        self.service = MeasurementService()
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "fixtures", "box-mapping.json")
        with open(path, "rb") as handle:
            self.mapping = handle.read()

    def tearDown(self):
        self.service.stop()

    def test_a_distance_between_two_edges_comes_back(self):
        self.service.start()
        self.service.warm()
        self.service.load(self.mapping)

        self.assertIsNone(
            self.service.handle_changes({"activeTool": "DistanceMeasurement"}),
            "activating a tool is not a measurement",
        )
        answer = self.service.handle_changes({
            "selectedShapeIDs": [
                "/Group/Solid/edges/edges_0",
                "/Group/Solid/edges/edges_1",
                False,
            ],
        })

        self.assertIsNotNone(answer, "the measurement produced no answer at all")
        self.assertEqual(answer.get("type"), "backend_response")
        self.assertTrue(any("distance" in entry for entry in answer.get("result", [])),
                        f"no distance in the answer: {answer}")

    def test_properties_of_one_face_come_back(self):
        """The other handler that prints, and so the other way the stream breaks."""
        self.service.start()
        self.service.warm()
        self.service.load(self.mapping)

        self.service.handle_changes({"activeTool": "PropertiesMeasurement"})
        answer = self.service.handle_changes({
            "selectedShapeIDs": ["/Group/Solid/faces/faces_0", False],
        })

        self.assertIsNotNone(answer, "the measurement produced no answer at all")
        self.assertEqual(answer.get("subtype"), "tool_response")

    def test_the_splash_is_measurable_before_anything_is_shown(self):
        """The logo is a real model, so it can be measured like one.

        It was not, for as long as this host had a measurement backend of its
        own: the service refused to ask about anything before a model had been
        sent, which was right when the only geometry the process could hold was
        geometry this side had given it. The shared backend loads the splash at
        startup - `ViewerBackend.start()` - so "nothing has been shown" stopped
        meaning "nothing to measure".
        """
        self.service.start()
        self.service.warm()

        self.service.handle_changes({"activeTool": "PropertiesMeasurement"})
        answer = self.service.handle_changes({
            "selectedShapeIDs": ["/Group/OCP/faces/faces_0", False],
        })

        self.assertIsNotNone(answer, "the splash could not be measured")
        self.assertEqual(answer.get("shape_type"), "Face")
