"""Says what this process was doing when something took too long.

Written after an afternoon spent on a two-minute stall whose entire record was
one line: ``Kernel warm-up started: importing build123d``, with no matching
finish. Everything queued behind it, five Runs landed at once when it cleared,
and the diagnosis came from timestamps and a ``sample`` of the process - none of
which a user can be asked for.

The rule this encodes: **a log line that records something starting is only half
a sentence.** If the other half does not arrive, the log should say so, and say
what the rest of the machinery looked like at that moment - because that is
precisely the picture that cannot be reconstructed afterwards.

It costs nothing when nothing is wrong: one timer per watched thing, cancelled
on the way past, and not a line written. When something *is* wrong it reports
once early and then at intervals, because a stall that is growing a queue and
one that is simply slow look identical in a single sample.
"""

import threading
import time

# When a thing that should be quick has taken long enough to be worth a
# sentence. Five seconds: longer than any warm-up on any machine measured here,
# short enough to be in the log before a person has finished wondering.
FIRST_REPORT = 5.0

# And how often to say it again while it continues. Half a minute, so a stall
# that lasts two produces four lines rather than a wall - and four is enough to
# see whether the queues are growing.
REPEAT_REPORT = 30.0


class StallWatch:
    """One thing that is supposed to finish, and what to say if it does not."""

    def __init__(self, what, describe, report, first=FIRST_REPORT, repeat=REPEAT_REPORT):
        # ``describe`` is called only when something has already gone wrong, so
        # it may be as expensive as it needs to be - and it is called again on
        # each repeat, because the answer changing is the interesting part.
        self.what = what
        self._describe = describe
        self._report = report
        self._first = first
        self._repeat = repeat

        self._lock = threading.Lock()
        self._started = None
        self._timer = None
        self._reported = False

    def start(self):
        with self._lock:
            self._started = time.monotonic()
            self._arm(self._first)
        return self

    def finish(self):
        """It arrived. Say how long it took, but only if anybody was told."""
        with self._lock:
            if self._started is None:
                return
            waited = time.monotonic() - self._started
            self._started = None
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            reported = self._reported
        # Outside the lock: reporting writes a log line, and a log line is not
        # something to hold a lock across.
        if reported:
            self._report(f"{self.what} finished after {waited:.0f}s")

    def _arm(self, delay):
        """Caller holds the lock."""
        timer = threading.Timer(delay, self._fire)
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _fire(self):
        with self._lock:
            if self._started is None:
                return
            waited = time.monotonic() - self._started
            self._reported = True
            self._arm(self._repeat)
        try:
            picture = self._describe()
        except Exception as exc:  # noqa: BLE001 - a report must not raise into a timer
            picture = f"(could not describe the sidecar: {exc})"
        self._report(f"{self.what} has not finished after {waited:.0f}s - {picture}")
