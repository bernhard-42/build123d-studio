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

import unittest

from completer import Completer

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
        cls.completer = Completer("/tmp")
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
        cls.completer = Completer("/tmp")
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


if __name__ == "__main__":
    unittest.main()
