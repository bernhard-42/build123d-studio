"""Formatting, against the real ruff rather than a fixture.

The same argument as test_completer: what is being claimed is not that this
module passes strings around, it is that the pinned ruff turns the code this
application is written for into the code the user expects back. A fake formatter
would only ever agree with itself.

Two properties matter more than the formatting itself and neither is obvious
from reading format_source. A buffer that does not parse must come back
unchanged, because that is the ordinary state of a file being typed into and
Format on Save runs on every Cmd-S. And an already-formatted buffer must answer
"nothing to change" rather than "here is the same text" - the frontend turns any
answer into an edit, and an edit that replaces the text with itself moves the
cursor, dirties the tab and pushes an undo stop.
"""

import unittest

from formatter import format_source

MESSY = "b   =  Box( 1,2,   3 )\ndef f(a,b):\n  return  a+b\n"
TIDY = "b = Box(1, 2, 3)\n\n\ndef f(a, b):\n    return a + b\n"


class FormatSourceTest(unittest.TestCase):
    def test_it_formats(self):
        formatted, why = format_source(MESSY, 88)
        self.assertEqual(formatted, TIDY)
        self.assertEqual(why, "formatted")

    def test_already_formatted_is_nothing_to_change(self):
        formatted, why = format_source(TIDY, 88)
        self.assertIsNone(formatted)
        self.assertEqual(why, "already formatted")

    def test_a_buffer_that_does_not_parse_is_left_alone(self):
        # Every keystroke of a half-typed line looks like this, and Format on
        # Save means the formatter meets it constantly. Silence is the answer:
        # the language server has already put a squiggle where the mistake is.
        formatted, why = format_source("def f(:\n    pass\n", 88)
        self.assertIsNone(formatted)
        self.assertIn("does not parse", why)

    def test_the_line_length_is_obeyed(self):
        # The setting's whole purpose, and the one thing a caller can get wrong
        # in a way that looks like it worked - ruff accepts any width and the
        # difference only shows on a line near the boundary.
        source = "result = some_function(argument_one, argument_two, argument_three, arg_four)\n"
        self.assertEqual(format_source(source, 88)[0], None)

        narrow, why = format_source(source, 60)
        self.assertEqual(why, "formatted")
        self.assertTrue(
            all(len(line) <= 60 for line in narrow.splitlines()),
            f"a line came back longer than 60 columns:\n{narrow}",
        )

    def test_an_empty_buffer_is_nothing_to_change(self):
        self.assertIsNone(format_source("", 88)[0])

    def test_build123d_idiom_survives_formatting(self):
        # The formatter must not fight the code this editor exists for. A
        # builder block with a bare expression in it is correct build123d and is
        # exactly the shape the diagnostics settings were tuned around.
        source = (
            "with BuildPart() as bd:\n"
            "    Box(1, 2, 3)\n"
            "    fillet(bd.edges(), radius=0.2)\n"
        )
        formatted, why = format_source(source, 88)
        self.assertIsNone(formatted, f"ruff rewrote a builder block: {formatted}")
        self.assertEqual(why, "already formatted")

    def test_text_survives_the_pipe(self):
        # The formatter is a subprocess now, so the buffer crosses a pipe twice.
        # Text mode would decode it with the platform's encoding - cp1252 on
        # Windows - and a file with an accent in a string would come back
        # mangled or not at all. Bytes, both ways, and this is what says so.
        source = "name  =  'caf\u00e9 \u00b5 \u4e2d'\n"
        formatted, why = format_source(source, 88)

        self.assertEqual(why, "formatted")
        self.assertEqual(formatted, 'name = "caf\u00e9 \u00b5 \u4e2d"\n')


if __name__ == "__main__":
    unittest.main()
