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

    def test_stop_closes_stdin_and_the_process_goes(self):
        # Closing stdin is the shutdown signal, as it is for the sidecar itself:
        # it cannot be missed the way a message can.
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
