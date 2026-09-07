"""Running a file - or a folder of tests - from disk, against real processes.

The claims worth holding are the ones that separate this from Run All: the
process is the application's own interpreter, its output arrives while it runs
rather than in a lump at the end, an exit is reported once with its code, and
Stop kills it without pretending the script finished.

Real subprocesses rather than fakes, because every one of those is a statement
about how Popen behaves - a fake would agree with whatever this file assumed.
"""

import importlib.util
import os
import sys
import tempfile
import threading
import time
import unittest

from runner import RunSession


class RunSessionTest(unittest.TestCase):
    def setUp(self):
        self.output = []
        self.exits = []
        self.exited = threading.Event()
        self.session = RunSession(
            python=sys.executable,
            supervisor=os.path.join(
                os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                "kernel", "build123d_studio", "_supervise.py",
            ),
            on_output=self.output.append,
            on_exit=self._record_exit,
        )
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.session.stop)

    def _record_exit(self, code):
        self.exits.append(code)
        self.exited.set()

    def write(self, source):
        path = os.path.join(self.directory.name, "script.py")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(source)
        return path

    def run_and_wait(self, source, timeout=20):
        error = self.session.start(self.write(source), env=dict(os.environ),
                                   cwd=self.directory.name)
        self.assertIsNone(error)
        self.assertTrue(self.exited.wait(timeout), "the run never reported an exit")
        return "".join(self.output)

    def test_it_runs_and_reports_a_clean_exit(self):
        self.assertIn("HELLO", self.run_and_wait("print('HELLO')\n"))
        self.assertEqual(self.exits, [0])

    def test_a_traceback_comes_back_with_the_output_that_led_to_it(self):
        # stderr is folded into stdout deliberately: a traceback interleaved
        # with the prints before it is what somebody is actually reading, and
        # two pipes would arrive in whichever order the threads were scheduled.
        text = self.run_and_wait("print('BEFORE')\nraise ValueError('BOOM')\n")
        self.assertLess(text.index("BEFORE"), text.index("BOOM"))
        self.assertEqual(self.exits, [1])

    def test_output_arrives_while_it_runs(self):
        # -u, and it is not a nicety. A script that prints its progress is the
        # ordinary case here, and block buffering would make every one of them
        # look hung until the moment it finished.
        path = self.write("import time\nprint('FIRST')\ntime.sleep(5)\nprint('LAST')\n")
        self.assertIsNone(self.session.start(path, env=dict(os.environ),
                                             cwd=self.directory.name))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "FIRST" not in "".join(self.output):
            time.sleep(0.05)
        self.assertIn("FIRST", "".join(self.output))
        self.assertNotIn("LAST", "".join(self.output))
        self.assertEqual(self.exits, [], "it reported an exit while still running")

    def test_stop_kills_it_and_says_nothing(self):
        # The frontend asked for this and is not waiting to be told what it
        # already knows, so no exit is announced - which is also what stops a
        # deliberate stop looking like a crash in the output.
        path = self.write("import time\ntime.sleep(30)\n")
        self.assertIsNone(self.session.start(path, env=dict(os.environ),
                                             cwd=self.directory.name))
        self.assertTrue(self.session.alive())

        self.session.stop()

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and self.session.alive():
            time.sleep(0.05)
        self.assertFalse(self.session.alive())
        self.assertEqual(self.exits, [])

    def test_only_one_at_a_time(self):
        path = self.write("import time\ntime.sleep(30)\n")
        self.assertIsNone(self.session.start(path, env=dict(os.environ),
                                             cwd=self.directory.name))
        self.assertEqual(
            self.session.start(path, env=dict(os.environ), cwd=self.directory.name),
            "something is already running",
        )

    def test_a_path_that_is_not_a_file_is_refused_before_anything_is_spawned(self):
        error = self.session.start(os.path.join(self.directory.name, "nope.py"),
                                   env=dict(os.environ), cwd=self.directory.name)
        self.assertIn("is not a file", error)
        self.assertFalse(self.session.alive())

    def test_it_runs_where_it_was_told_to(self):
        # The working directory is the kernel's, so a relative path in the
        # script means what it would have meant under Run All or the debugger.
        text = self.run_and_wait("import os\nprint('CWD', os.getcwd())\n")
        self.assertIn(os.path.realpath(self.directory.name), os.path.realpath(
            text.split("CWD", 1)[1].strip()))


class PytestTest(RunSessionTest):
    """Run -> Test, which is the same three lines with a different argv.

    Inherits the fixture rather than repeating it, because the claims that
    matter here are the ones about the argv: everything downstream - one child
    at a time, output while it runs, Stop, the exit code - is the file case,
    already covered above and shared by construction.
    """

    def folder_with_a_test(self, source):
        folder = os.path.join(self.directory.name, "tests")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "test_it.py"), "w", encoding="utf-8") as handle:
            handle.write(source)
        return folder

    def test_a_folder_that_is_not_there_is_refused_before_anything_is_spawned(self):
        error = self.session.start_pytest(
            os.path.join(self.directory.name, "nope"),
            env=dict(os.environ),
            cwd=self.directory.name,
        )
        self.assertIn("is not there", error)
        self.assertFalse(self.session.alive())

    def test_a_file_is_taken_too_because_Test_File_is_a_menu_item(self):
        # One check for both items rather than isfile and isdir separately:
        # pytest takes either, and the two differ only in which chooser the
        # frontend raised.
        error = self.session.start_pytest(
            self.write("def test_ok():\n    assert True\n"),
            env=dict(os.environ),
            cwd=self.directory.name,
        )
        self.assertIsNone(error)

    @unittest.skipUnless(
        importlib.util.find_spec("pytest") is not None,
        "pytest is not in this environment yet - it is declared in runtime/pyproject.toml "
        "and arrives with the next Update",
    )
    def test_it_runs_pytest_over_the_folder_and_reports_the_result(self):
        folder = self.folder_with_a_test("def test_two():\n    assert 1 + 1 == 2\n")
        self.assertIsNone(self.session.start_pytest(
            folder, env=dict(os.environ), cwd=self.directory.name,
        ))
        self.assertTrue(self.exited.wait(60), "the test run never reported an exit")
        text = "".join(self.output)
        self.assertIn("1 passed", text)
        # Exit 0 is what the frontend turns into "[finished]"; pytest's own
        # non-zero codes are how a failing suite reaches the same pane as a
        # traceback does.
        self.assertEqual(self.exits, [0])

    @unittest.skipUnless(
        importlib.util.find_spec("pytest") is not None,
        "pytest is not in this environment yet",
    )
    def test_a_failing_test_exits_non_zero_with_its_report(self):
        folder = self.folder_with_a_test("def test_no():\n    assert 1 == 2\n")
        self.assertIsNone(self.session.start_pytest(
            folder, env=dict(os.environ), cwd=self.directory.name,
        ))
        self.assertTrue(self.exited.wait(60), "the test run never reported an exit")
        self.assertIn("1 failed", "".join(self.output))
        self.assertEqual(self.exits, [1])

    @unittest.skipUnless(
        importlib.util.find_spec("pytest") is not None,
        "pytest is not in this environment yet",
    )
    def test_ignore_warnings_is_off_unless_settings_asks_for_it(self):
        # The observable difference, rather than the argv: pytest prints a
        # warnings summary when a test raises one, and -W ignore is the switch
        # in Settings -> Test that takes it away.
        folder = self.folder_with_a_test(
            "import warnings\n\n\n"
            "def test_warns():\n"
            "    warnings.warn('OLD', DeprecationWarning)\n"
        )
        self.assertIsNone(self.session.start_pytest(
            folder, env=dict(os.environ), cwd=self.directory.name,
        ))
        self.assertTrue(self.exited.wait(60), "the test run never reported an exit")
        self.assertIn("warnings summary", "".join(self.output))

    @unittest.skipUnless(
        importlib.util.find_spec("pytest") is not None,
        "pytest is not in this environment yet",
    )
    def test_and_with_it_on_the_warnings_are_gone(self):
        folder = self.folder_with_a_test(
            "import warnings\n\n\n"
            "def test_warns():\n"
            "    warnings.warn('OLD', DeprecationWarning)\n"
        )
        self.assertIsNone(self.session.start_pytest(
            folder,
            env=dict(os.environ),
            cwd=self.directory.name,
            ignore_warnings=True,
        ))
        self.assertTrue(self.exited.wait(60), "the test run never reported an exit")
        text = "".join(self.output)
        self.assertNotIn("warnings summary", text)
        # Still ran, which is the half that would make the assertion above true
        # for the wrong reason.
        self.assertIn("1 passed", text)


if __name__ == "__main__":
    unittest.main()
