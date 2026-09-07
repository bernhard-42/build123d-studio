"""The import check the splash runs, against the real environment.

Two claims, and both were broken on Windows until 2026-09-07. The script has to
exit 0 when the imports work - it did not, because unloading the OpenCascade DLL
set faults in interpreter teardown, and the caller reads only the exit code - and
it has to say when the two the application actually needs are in, because a
failure after that point is the user's optional cadquery and must not be reported
as an environment that cannot import anything.

Run as a subprocess, which is how the bootstrap runs it: an import in this
process would prove nothing about the exit, and the exit is the whole point.
"""

import os
import subprocess
import sys
import unittest

SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "sidecar", "verify_imports.py",
)

# The line src/bootstrap/setup.js watches for. Named here rather than imported
# from the script, because importing it would run it.
REQUIRED_READY = "OCP and build123d are ready"


class VerifyImportsTest(unittest.TestCase):
    def setUp(self):
        # Warm on a machine that has started the application, minutes on one
        # that has not: the first load of OCP is what this script exists to pay.
        self.result = subprocess.run(
            [sys.executable, SCRIPT],
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )

    def test_it_exits_cleanly_even_where_teardown_faults(self):
        # os._exit, deliberately. Measured on gauss: all three imports succeed
        # and the interpreter then dies with 0xC0000374 in teardown, so the
        # exit code described a run that had in fact done its whole job.
        self.assertEqual(
            self.result.returncode, 0,
            f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}",
        )

    def test_it_says_when_the_required_pair_is_in(self):
        self.assertIn(REQUIRED_READY, self.result.stdout)

    def test_each_import_announces_itself_before_it_blocks(self):
        # The splash is a log, and a line that appears after the wait is over
        # says nothing while somebody is waiting.
        self.assertIn("Importing OCP", self.result.stdout)
        self.assertLess(
            self.result.stdout.index("Importing OCP"),
            self.result.stdout.index(REQUIRED_READY),
        )
