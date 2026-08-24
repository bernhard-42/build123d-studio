"""Static completion, held to the cases that made it necessary.

These run basedpyright against the application's real environment - the same
build123d the user has - because that is the whole claim being made. A fixture
would only say that the wrapper passes strings around; what needs holding is
that a file which has never been run still completes, and that is a statement
about the language server's ability to follow build123d's annotations rather
than about this code.

The case that decided which server to use is
test_the_builder_pattern_completes: jedi was tried first and infers `bd` from
`with BuildPart() as bd:` as the base class, so `part` - the property the whole
builder pattern exists to produce - was not offered at all.

The other property worth stating is the span. The server returns items without a
textEdit and leaves the range to the client, so this code computes it, and a
wrong span silently corrupts the buffer: accepting "part" in "bd.pa" writes
"bpart" or "bd.papart" and nothing says so. Every completion case below asserts
on the text that accepting it produces, not on the name being present.
"""

import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import completer

from completer import Completer, LanguageServer

# The application tree, so the server can resolve build123d_studio the way
# it does in production - the kernel-side package lives in <app_dir>/kernel.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The file as somebody would have it on screen, having typed it and not yet run
# anything. The kernel's namespace is empty at this point and stays empty; every
# answer here comes from reading these lines.
SOURCE = """from build123d import *
from build123d_studio import show, show_clear

with BuildPart() as bd:
    Box(1, 2, 34)
"""


class StaticCompletionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # One server for the class. Starting it is seconds and analysing
        # build123d is a second more, and paying that per test would measure the
        # warm-up rather than the behaviour.
        cls.completer = Completer("/tmp", REPO)
        cls.completer.warm()

    @classmethod
    def tearDownClass(cls):
        cls.completer.stop()

    def accepting(self, typed, name):
        """What the line reads after accepting ``name``, or None if not offered.

        The question every completion has to answer, and the only one that
        cannot be got right by accident.
        """
        source = SOURCE + typed
        line = len(source.splitlines())
        column = len(typed)
        entries = self.completer.complete(source, line, column)
        match = next((entry for entry in entries if entry["text"] == name), None)
        if match is None:
            return None
        return typed[:match["start"]] + name + typed[match["end"]:]

    def test_the_builder_pattern_completes(self):
        """bd.part, from `with BuildPart() as bd:` - and the reason for the server.

        build123d annotates __enter__ -> Self, so the type of bd is BuildPart
        and part is one of its properties. jedi binds Self to the class that
        defines the method and offers Builder's members only.
        """
        self.assertEqual(self.accepting("bd.pa", "part"), "bd.part")

    def test_a_star_import_completes_before_anything_has_run(self):
        """"b = Bo" on a cold kernel, which is where this started."""
        self.assertEqual(self.accepting("b = Bo", "Box"), "b = Box")

    def test_a_keyword_argument(self):
        """The brackets: what Box takes, before Box exists anywhere."""
        self.assertEqual(self.accepting("c = Box(le", "length="), "c = Box(length=")

    def test_an_attribute_of_an_inferred_type(self):
        """A name assigned in the file, never executed."""
        source = SOURCE + "b = Box(1, 2, 3)\nb.ce"
        entries = self.completer.complete(source, len(source.splitlines()), 4)

        self.assertIn("center", [entry["text"] for entry in entries])

    def test_a_completion_at_the_start_of_a_line_replaces_nothing_before_it(self):
        """The span's other edge: there is no word to the left of column zero."""
        self.assertEqual(self.accepting("Bo", "Box"), "Box")

    def test_types_arrive_in_the_vocabulary_the_frontend_maps(self):
        """The server's kinds are numbers; the frontend has one table.

        A kind that arrives untranslated costs that row its icon, and the
        frontend cannot tell the difference between "no type" and "a type this
        did not convert".
        """
        entries = self.completer.complete(SOURCE + "b = Bo", 6, 6)
        known = {"module", "class", "instance", "function", "param", "path", "keyword",
                 "statement"}

        self.assertTrue(entries, "nothing to check")
        for entry in entries:
            self.assertIn(entry["type"], known)

    def test_half_written_code_costs_its_own_suggestions_and_no_more(self):
        """Which is the normal input: completion is asked for mid-expression.

        The property is that it answers rather than raising - a handler that
        raised here would take the frame with it.
        """
        for typed in ["b = Box(((", "def (", "class :", "b = [1, 2,", "@"]:
            with self.subTest(typed=typed):
                source = SOURCE + typed
                entries = self.completer.complete(source, len(source.splitlines()), len(typed))
                self.assertIsInstance(entries, list)

    def test_a_position_outside_the_file_is_answered_rather_than_raised(self):
        self.assertIsInstance(self.completer.complete("x = 1", 99, 99), list)
        self.assertIsInstance(self.completer.complete("x = 1", 1, 99), list)

    def test_an_edited_buffer_is_re_read(self):
        """The document sync, which is the one piece of state this holds.

        The frontend sends the whole buffer every time and the server has to be
        told it changed. Without the didChange the second answer describes the
        first buffer - which is invisible until somebody renames something and
        the old name keeps being offered.
        """
        first = self.completer.complete("wobble = 1\nwob", 2, 3, "/tmp/sync-test.py")
        second = self.completer.complete("wibble = 1\nwib", 2, 3, "/tmp/sync-test.py")

        self.assertIn("wobble", [entry["text"] for entry in first])
        self.assertIn("wibble", [entry["text"] for entry in second])
        self.assertNotIn("wobble", [entry["text"] for entry in second])


class SignatureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.completer = Completer("/tmp", REPO)
        cls.completer.warm()

    @classmethod
    def tearDownClass(cls):
        cls.completer.stop()

    def signature(self, typed):
        source = SOURCE + typed
        return self.completer.signatures(source, len(source.splitlines()), len(typed))

    def test_the_call_the_cursor_is_inside(self):
        help_ = self.signature("c = Box(")

        self.assertIsNotNone(help_)
        self.assertIn("length", help_["signatures"][0]["label"])
        self.assertTrue(help_["signatures"][0]["parameters"], "no parameters listed")

    def test_the_parameters_carry_their_types(self):
        """Which is most of the point on this API.

        Box(10, 10, 10) is three numbers, and nothing on screen otherwise says
        which is length and which is height.
        """
        parameters = self.signature("c = Box(")["signatures"][0]["parameters"]

        self.assertEqual(parameters[0], "length: float")

    def test_outside_a_call_there_is_no_signature(self):
        self.assertIsNone(self.signature("b"))

    def test_the_documentation_is_one_paragraph(self):
        """The popup sits over the code being written.

        build123d's docstrings run to a paragraph per argument, and a popup that
        long covers the thing it is describing.
        """
        documentation = self.signature("c = Box(")["signatures"][0]["documentation"]

        self.assertNotIn("\n", documentation)


class HoverTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.completer = Completer("/tmp", REPO)
        cls.completer.warm()

    @classmethod
    def tearDownClass(cls):
        cls.completer.stop()

    def test_what_a_name_holds(self):
        """The question a CAD script raises constantly.

        build123d's operations return Part, Sketch, Curve and Compound and look
        alike doing it, and which one decides what the next line may do. Neither
        of these is written down anywhere in the file: bd's type comes from
        __enter__ and part's from a property annotation.
        """
        over_the_builder = self.completer.hover(SOURCE + "bd.part", 6, 1)
        over_the_property = self.completer.hover(SOURCE + "bd.part", 6, 4)

        self.assertIn("BuildPart", over_the_builder["value"])
        self.assertIn("Part", over_the_property["value"])

    def test_nothing_under_the_pointer_is_nothing(self):
        self.assertIsNone(self.completer.hover(SOURCE + "    ", 6, 2))


class DiagnosticsTest(unittest.TestCase):
    """Squiggles, and the noise that had to be turned off before they were worth
    drawing.

    The configuration is the substance here. On this file the defaults report
    nine problems, seven of which are wrong about idioms this application ships
    in its own New File template - and two real mistakes among seven false ones
    is how people learn to ignore a gutter. The settings are checked by their
    effect rather than by reading them back, because an answer of the wrong
    shape is accepted silently and changes nothing: four configurations produced
    four identical results until the workspace/configuration reply was made
    section-aware.
    """

    # A builder block, a couple of shapes, and exactly two mistakes.
    FILE = """from build123d import *
from build123d_studio import show

with BuildPart() as bd:
    Box(10, 10, 10)

show(bd.part)

plate = Box(50, 30, 2.5)
plate.nonexistent_attribute
undefined_name + 1
"""

    def setUp(self):
        self.published = threading.Event()
        self.diagnostics = []

        def collect(path, key, diagnostics):
            self.diagnostics = diagnostics
            self.published.set()

        self.completer = Completer("/tmp", REPO, on_diagnostics=collect)
        self.addCleanup(self.completer.stop)
        self.completer.warm()

    def analyse(self, source, path="/tmp/diag-test.py"):
        self.published.clear()
        self.completer.sync(source, path, "buffer-1")
        self.assertTrue(self.published.wait(timeout=30), "nothing was published")
        return self.diagnostics

    def rules(self, diagnostics):
        return sorted(str(item.get("code")) for item in diagnostics)

    def test_the_real_mistakes_are_reported(self):
        found = self.analyse(self.FILE)

        self.assertEqual(
            self.rules(found), ["reportAttributeAccessIssue", "reportUndefinedVariable"]
        )

    def test_and_nothing_else_is(self):
        """The idioms that are correct code, named one by one.

        Each of these was reported by the defaults: the wildcard import is line
        one of the New File template, Box(...) inside a builder is called for
        its effect and its result is meant to be unused, and build123d_studio is
        the kernel-side package this application puts on PYTHONPATH itself -
        which the server can only know because it is told where to look.
        """
        found = self.analyse(self.FILE)
        reported = self.rules(found)

        for rule in ["reportWildcardImportFromLibrary", "reportUnusedCallResult",
                     "reportMissingImports", "reportUnknownMemberType"]:
            self.assertNotIn(rule, reported)

    def test_a_clean_file_publishes_an_empty_list(self):
        """Which is what takes the previous squiggles away.

        The server republishes everything it knows about a document each time,
        so a file that has just been fixed is an empty list rather than silence
        - and silence would leave the old marks on screen for ever.
        """
        self.analyse(self.FILE)
        self.assertEqual(self.analyse("from build123d import *\nb = Box(1, 2, 3)\n"), [])

    def test_a_diagnostic_names_the_buffer_it_belongs_to(self):
        """Two unsaved buffers have the same path, which is none.

        Without the key they would share one document in the server, and each
        one's squiggles would be drawn on the other.
        """
        seen = []
        done = threading.Event()

        def collect(path, key, diagnostics):
            seen.append((path, key, len(diagnostics)))
            done.set()

        completer = Completer("/tmp", REPO, on_diagnostics=collect)
        self.addCleanup(completer.stop)
        completer.warm()

        done.clear()
        completer.sync("undefined_one + 1\n", None, "buffer-a")
        self.assertTrue(done.wait(timeout=30))
        done.clear()
        completer.sync("x = 1\n", None, "buffer-b")
        self.assertTrue(done.wait(timeout=30))

        keys = {key for _, key, _ in seen}
        self.assertEqual(keys, {"buffer-a", "buffer-b"})
        self.assertEqual({key for _, key, count in seen if count > 0}, {"buffer-a"})


class DeafLanguageServerTest(unittest.TestCase):
    """A server that stopped reading, which is what a quit would wait on.

    The measurement backend's half of this is `DeafBackendTest` in
    test_measure_service.py, and its docstring explains the shape: a write into
    a 64 kB pipe that nobody is reading cannot complete, and closing a buffered
    writer flushes it. That file's stop() was fixed to kill first and say so;
    this one kept the old order, and it is the *first* step of the sidecar's
    teardown - so a server that wedges spends the whole shutdown budget here and
    every later step, including the kernel's kill escalation, never runs.

    A process that sleeps and reads nothing is the whole fake needed. Nothing
    here is about completion.
    """

    def setUp(self):
        handle = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        handle.write("import time\ntime.sleep(300)\n")
        handle.close()
        self.script = handle.name
        self.addCleanup(os.unlink, self.script)
        self.processes = []

    def _deaf_process(self):
        """A child that never reads, with room to buffer a write before it.

        bufsize is what makes this deterministic rather than timed: the write
        below stays in Python's own buffer instead of reaching the pipe, which
        is the state the real writer is left in by a flush that got part way.
        """
        process = subprocess.Popen(
            [sys.executable, self.script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=8 << 20,
        )
        self.processes.append(process)
        self.addCleanup(self._reap, process)
        return process

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

    def _more_than_the_pipe_holds(self):
        # Four megabytes against a 64 kB buffer: the flush cannot complete, and
        # it cannot complete for reasons that have nothing to do with timing.
        return b"x" * (4 << 20)

    def test_stop_does_not_wait_for_a_flush_nobody_reads(self):
        # The control. Closing the writer is what stop() used to do first, and
        # against a deaf child it does not come back. Without this the test
        # would pass just as well against a fake that never had anything to
        # block on, and would be measuring nothing.
        control = self._deaf_process()
        control.stdin.write(self._more_than_the_pipe_holds())

        def close_the_control():
            # Reaped at cleanup, which unblocks this with EPIPE. The thread is
            # here to be stuck, so arriving at all is the uninteresting case.
            try:
                control.stdin.close()
            except OSError:
                pass

        closing = threading.Thread(target=close_the_control, daemon=True)
        closing.start()
        closing.join(timeout=2)
        self.assertTrue(closing.is_alive(), "the flush was not blocked, so this proves nothing")

        server = LanguageServer(sys.executable)
        # Held here as well, because stop() clears the attribute - the process
        # has to still be nameable after the thing that was meant to end it.
        deaf = self._deaf_process()
        server._process = deaf
        deaf.stdin.write(self._more_than_the_pipe_holds())

        stopping = threading.Thread(target=server.stop, daemon=True)
        started = time.monotonic()
        stopping.start()
        stopping.join(timeout=15)
        waited = time.monotonic() - started

        self.assertFalse(stopping.is_alive(), f"stop() was still blocked after {waited:.1f}s")
        self.assertLess(waited, 12, f"stop() waited {waited:.1f}s for a flush nobody reads")
        self.assertIsNotNone(deaf.poll(), "the language server outlived stop()")


if __name__ == "__main__":
    unittest.main()


class TreeKillCommandTest(unittest.TestCase):
    """Which platform needs a tree killed, and with what.

    basedpyright's server is a grandchild - a launcher runs Python, which runs
    node - so on Windows a terminate reaches the launcher and leaves node
    holding `site-packages/basedpyright/dist`, which is what stopped the runtime
    directory being deleted after a quit at 0.4.1. Pure, because the platform
    that needs it is not the one this suite runs on.
    """

    def test_windows_gets_a_tree_kill(self):
        command = completer.tree_kill_command(4242, platform="win32")

        self.assertEqual(command, ["taskkill", "/F", "/T", "/PID", "4242"])

    def test_and_the_T_is_the_point(self):
        # Without it taskkill takes the launcher and leaves the grandchild,
        # which is the bug rather than the fix.
        self.assertIn("/T", completer.tree_kill_command(1, platform="win32"))

    def test_the_others_are_left_to_their_signals(self):
        # Where EOF and the initialize processId do reach the grandchild, a
        # tree kill would only take away the server's chance to exit cleanly.
        self.assertIsNone(completer.tree_kill_command(4242, platform="darwin"))
        self.assertIsNone(completer.tree_kill_command(4242, platform="linux"))
