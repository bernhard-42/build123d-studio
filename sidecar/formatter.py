"""Format a buffer with ruff.

Through `ruff format -` rather than in process, because ruff is a Rust binary
and the wheel exposes no Python formatting API: `find_ruff_bin()` - what the
package's own `__main__` calls - says where the executable is, and everything
else is a pipe. The process start is the whole cost, and it is small: measured
against the pinned ruff 0.16.3, 8 ms for an ordinary file and 17 ms for 6000
lines.

`--isolated`, so the width in Settings is the width used. Without it ruff reads
the project's own pyproject.toml or ruff.toml, and a project that configures a
different line length would quietly beat the setting the user just changed.

Bytes rather than text mode, both ways. Text mode would decode with the
platform's encoding - cp1252 on Windows, which mangles every buffer this
application is likely to hold - and would translate newlines on the way in, so
a file with CRLF endings would come back rewritten. Measured: with bytes, UTF-8
survives and CRLF endings are preserved.

The seam is unchanged: source in, source out. If a third formatter ever arrives,
this module is still the only thing that has to know about it.
"""

import subprocess

from ruff import find_ruff_bin

# A GUI process spawning a console application flashes a console window on
# Windows, and Shift-Alt-F would do it on every keystroke. Absent everywhere
# else, where a 0 means "no extra flags".
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Long enough that no real buffer reaches it - 6000 lines is 17 ms - and short
# enough that a ruff which never answers does not hold the lane for ever.
TIMEOUT_SECONDS = 30

try:
    RUFF = find_ruff_bin()
except FileNotFoundError:
    # An environment without ruff must still start. Formatting is one feature;
    # the kernel, the console and the completions are the rest of this process.
    RUFF = None


def format_source(source, line_length):
    """The formatted text and a line saying what happened.

    A pair, always: the text - or None when there is nothing to write back -
    and a sentence for the log, because "nothing changed" and "it would not
    parse" look identical from the caller's side and only one of them is worth
    a reader's attention.

    None covers both "already formatted" and "cannot be parsed", and they are
    deliberately the same answer to the caller. An unparseable buffer is the
    ordinary state of a file being typed into, and the squiggle from the
    language server has already said so in the place the user is looking - a
    second complaint from the formatter would be the application telling them
    twice about a mistake they are in the middle of making.

    The distinction is not lost, only kept out of the way: which of the two it
    was goes to the log.
    """
    if RUFF is None:
        return None, "not formatted, ruff is not in this environment"

    try:
        finished = subprocess.run(
            [RUFF, "format", "-", "--isolated", "--line-length", str(line_length)],
            input=source.encode("utf-8"),
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            creationflags=NO_WINDOW,
        )
    except subprocess.TimeoutExpired:
        return None, f"ruff did not answer within {TIMEOUT_SECONDS}s"
    except OSError as exc:
        # The binary is named in the environment but cannot be run - a partial
        # install, or a permission the operating system has taken away.
        return None, f"ruff could not be run: {exc}"

    if finished.returncode != 0:
        detail = _first_line(finished.stderr) or f"exit {finished.returncode}"
        if "Failed to parse" in detail:
            return None, f"not formatted, the buffer does not parse: {detail}"
        # Anything else is ruff failing at something this application cannot
        # anticipate, and the buffer is the user's work. Report and change
        # nothing.
        return None, f"ruff failed: {detail}"

    formatted = finished.stdout.decode("utf-8")
    if formatted == source:
        return None, "already formatted"
    return formatted, "formatted"


def _first_line(stderr):
    """The first line of what ruff said, for the log."""
    text = stderr.decode("utf-8", errors="replace").strip()
    lines = text.splitlines()
    return lines[0] if len(lines) > 0 else ""
