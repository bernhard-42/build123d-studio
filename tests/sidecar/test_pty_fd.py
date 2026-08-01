"""M8: the pty descriptor, and what a keystroke must never be written to.

`write()` and `set_size()` used to check `_stopped` and then use `_fd`, and since
the lanes landed, `stop()` runs on a different thread from either - a restart can
close the descriptor in between. A closed descriptor number is not inert. It is
reissued to whatever this process opens next: a file the user is editing, the
log, a socket. So the failure is not a lost keystroke but keystrokes written
somewhere they were never meant to go, and a TIOCSWINSZ aimed at something that
is not a terminal.

Fixed in `8730a3a` by reasoning, never reproduced, and named in the Phase 2 notes
as one of the three that were not. This file reproduces it.

The widening is the interesting part, because the natural approach does not work.
There is no seam inside `write()` to hold a thread between the check and the use,
and hammering it hoping to land in a window a few instructions wide is exactly
the kind of test that passes against the broken code - which the restart-under-
load case already did once in this project.

So the lock is driven from outside instead. `_fd_lock` is what the fix added, and
a test can hold it: with it held, a correct `write()` must block, and an
incorrect one goes straight through to the descriptor. That turns a race into an
ordinary assertion with no timing in it at all - the thread either got past a
held lock or it did not.

**What is not here, and why.** There was a sixth test that took the consequence
end to end: hammer `write()` from four threads across a `stop()`, claim the
freed descriptor number with 64 fresh files, and assert no keystroke turned up in
any of them. It was deleted because it passed 8 times out of 8 against the
un-fixed code, which means it measured nothing.

The reason is worth keeping. `stop()` sets `_stopped` before it closes anything,
so once it has returned every writer takes the early return whether the lock is
there or not. The harmful interleaving needs a thread suspended between the
`_stopped` check and the `os.write` while the close *and* a reopen both happen -
two instructions apart, with no seam to hold it in. Reproducing that from outside
would need a widening point inserted into `write()` itself, which would mean
shipping test scaffolding on the hottest path in the application to demonstrate
something the lock tests below already establish.

So: the lock discipline is reproduced, the consequence of losing it is argued.
That is a weaker claim than the kernel tests make, and it is stated here rather
than left for someone to infer from a green suite.

POSIX only. Windows drives a pywinpty handle rather than a descriptor, and its
own failure mode is different enough that pretending one test covers both would
be worse than saying so.
"""

import sys
import tempfile
import threading
import unittest

from pty_console import PtyConsole
from support import SETTLE, is_windows

# How long to give a thread that is supposed to be blocked. If it finishes inside
# this it was not blocked, which is the whole assertion.
BLOCKED_FOR = 0.5

KEYSTROKE = b"this-should-never-reach-a-file\r"


class SleepingConsole(PtyConsole):
    """A console that is a pty and nothing else.

    Only _command is overridden, so the fork, the descriptor, the reader thread,
    the lock and stop() are all the shipped code. The child sleeps rather than
    running jupyter console: this file is about the descriptor, and starting a
    real console would need a kernel to attach to.
    """

    def _command(self):
        return [self.python, "-c", "import time; time.sleep(60)"]


@unittest.skipIf(is_windows(), "pywinpty drives a handle, not a descriptor")
class PtyDescriptorTest(unittest.TestCase):
    def setUp(self):
        self.output = []
        self.console = SleepingConsole(
            python=sys.executable,
            console_module_dir=tempfile.gettempdir(),
            connection_file="unused",
            on_output=self.output.append,
            on_exit=lambda: None,
        )
        self.console.start()
        self.addCleanup(self.console.stop)

    def test_a_write_cannot_proceed_while_the_descriptor_is_being_closed(self):
        """The fix, asserted without any timing in it.

        Holding _fd_lock is standing in for stop() holding it, which is what it
        does for the length of the close. A write() that respects the lock waits;
        the check-then-use version walks straight past and reaches a descriptor
        that is about to stop meaning this pty.
        """
        with self.console._fd_lock:
            writer = threading.Thread(
                target=lambda: self.console.write(KEYSTROKE), name="keystroke"
            )
            writer.start()
            writer.join(timeout=BLOCKED_FOR)
            got_through = not writer.is_alive()

        writer.join(timeout=SETTLE)
        self.assertFalse(
            got_through,
            "write() reached the descriptor while the close held the lock - which is "
            "the moment the number stops meaning this pty",
        )

    def test_a_resize_cannot_proceed_while_the_descriptor_is_being_closed(self):
        """set_size() is the same check-then-use, and worse when it loses.

        A TIOCSWINSZ aimed at a recycled number is an ioctl against whatever now
        holds it, not a lost resize.
        """
        with self.console._fd_lock:
            resizer = threading.Thread(
                target=lambda: self.console.set_size(80, 24), name="resize"
            )
            resizer.start()
            resizer.join(timeout=BLOCKED_FOR)
            got_through = not resizer.is_alive()

        resizer.join(timeout=SETTLE)
        self.assertFalse(got_through, "set_size() reached the descriptor mid-close")

    def test_stop_waits_for_a_write_that_is_already_in_flight(self):
        """The same lock from the other side: stop() must respect it too.

        Otherwise the lock in write() protects nothing - a close that does not
        take it can still land in the middle of one.
        """
        with self.console._fd_lock:
            stopper = threading.Thread(target=self.console.stop, name="stopper")
            stopper.start()
            stopper.join(timeout=BLOCKED_FOR)
            got_through = not stopper.is_alive()

        stopper.join(timeout=SETTLE)
        self.assertFalse(got_through, "stop() closed the descriptor without taking the lock")

    def test_stop_drops_the_descriptor_before_closing_it(self):
        """No third case.

        A writer either goes first with a live descriptor, or arrives afterwards
        and finds None. What must not exist is a writer holding a number that has
        stopped meaning this pty, and the handle being dropped inside the lock -
        before the close - is what rules it out.
        """
        self.console.stop()
        self.assertIsNone(self.console._fd, "stop() left a stale descriptor number behind")
        self.assertIsNone(self.console._winpty)


if __name__ == "__main__":
    unittest.main()
