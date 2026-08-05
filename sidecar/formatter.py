"""Format a buffer with black.

In process rather than through `python -m black -`, and the difference is not
subtle: measured against the pinned black 26.5.1, `format_str` on an ordinary
file is 2.2 ms, where a subprocess would pay an interpreter start and black's
own import on every keystroke of Shift-Alt-F. black is a dependency of this
environment like any other, so importing it here costs nothing a subprocess
would not also pay, once, at startup instead of every time.

The scaling is worth knowing before it surprises somebody: about 0.25 ms per
line, so 6000 lines is 1.5 s. That is why main.py gives formatting a lane of its
own - a big file must not hold up the completions being typed beside it.

black is the only formatter here and there is no plugin point for another. If
that ever changes, the seam is this module: it takes source and returns source.
"""

import black


def format_source(source, line_length):
    """The formatted text, or None when there is nothing to change.

    None covers both "already formatted" and "cannot be parsed", and they are
    deliberately the same answer to the caller. An unparseable buffer is the
    ordinary state of a file being typed into, and the squiggle from the
    language server has already said so in the place the user is looking - a
    second complaint from the formatter would be the application telling them
    twice about a mistake they are in the middle of making.

    The distinction is not lost, only kept out of the way: which of the two it
    was goes to the log.
    """
    try:
        formatted = black.format_str(source, mode=black.Mode(line_length=line_length))
    except black.InvalidInput as exc:
        log_line = str(exc).splitlines()[0] if str(exc) else "unparseable"
        return None, f"not formatted, the buffer does not parse: {log_line}"
    except Exception as exc:  # noqa: BLE001 - a formatter must not kill the lane
        # Anything else is black failing at something this application cannot
        # anticipate, and the buffer is the user's work. Report and change
        # nothing.
        return None, f"black failed: {type(exc).__name__}: {exc}"

    if formatted == source:
        return None, "already formatted"
    return formatted, "formatted"
