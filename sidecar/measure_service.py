"""Talks to the measurement backend, which lives in a process of its own.

`measure` imports ocp_vscode.backend, which drags in build123d and OCP. Measured:
2.0 s on macOS, 3.3 s on a warm start on a ten-year-old Windows machine, and
10.3 s on a cold Windows start. That used to happen in the sidecar, on the main
thread, before the accept loop started - because loading a .pyd holds the
Windows loader lock while CPython holds the GIL, and every thread a process
starts needs that lock for DLL_THREAD_ATTACH, so any overlapping thread
creation deadlocks against it permanently.

Sequencing around that worked and was never comfortable. The sidecar creates
threads constantly - one per connection to the accept loop, three for a debug
session, two for a Run File, several for a kernel restart - and only the startup
ordering kept them apart. The cold Windows log records how thin the margin was:
a Run was pressed inside the 10.3 second window, and the application survived
because the kernel's own build123d import happened to release the shell channel
103 ms after the sidecar's import finished.

Now it happens somewhere that creates no threads at all, so there is nothing to
sequence and nothing to assert. What is left here is a client: spawn it, keep
the mapping, forward a request when one arrives. Nothing waits for the spawn -
it runs alongside the kernel start, which on that same Windows machine takes
3.13 s of its own, so the two costs overlap instead of adding up.

**The mapping is held rather than forwarded.** load() is called on every show()
and a mapping is serialised BRep, which is not small on a real assembly. It
crosses only when somebody actually measures, so shows pay nothing and the
first measurement of a model pays one transfer. That also covers a model shown
from a Debug File or Run File session: those run in their own process and the
kernel never sees their shapes, but this does.
"""

import os
import struct
import subprocess
import sys
import threading
import time

import orjson

from channel import log

LENGTH = struct.Struct("<I")


class MeasurementService:
    """The measurement process, and the model it has been told about."""

    def __init__(self, python=None, script=None, on_state=None):
        # Told how it is doing, rather than only writing it into the log: a
        # backend that never answers is invisible otherwise, and everything
        # downstream of it then fails in a shape that points elsewhere.
        self.on_state = on_state
        self._python = python or sys.executable
        self._script = script or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "measure_process.py"
        )
        self._process = None
        self._started = None

        # The mapping of the model on screen, and whether the process has been
        # given it. Two facts rather than one: a show() replaces the mapping and
        # makes what the process holds stale, without sending anything.
        self._mapping = None
        self._sent = False

        # The last thing said about it, so that saying it again says nothing.
        # See _announce.
        self._state = None
        # Set on the way out, so that killing it then is not reported as a
        # fault. See _exchange.
        self._stopping = threading.Event()

        self._next_id = 0
        # One request in flight at a time, which is what makes the reply on the
        # pipe unambiguously this request's. The measure lane serves the warm-up
        # and viewer changes in turn, but `load` arrives on the model socket's
        # thread and `stop` on whichever thread is quitting, so this is not
        # theoretical.
        self._lock = threading.Lock()

    # --- lifecycle ---

    def start(self):
        """Spawn it and return at once, unless we are on the way out.

        Nothing waits for this. The import inside costs seconds and the sidecar
        has a kernel to start; by the time a model has been shown and a measure
        tool clicked, it has long since finished.

        The refusal is here as well as in _request because start() is reachable
        after the stop step has run - a queued frame on the measure lane, or the
        point-check window in Sidecar.start(). Spawning then means a fresh OCP
        import, seconds of it, behind a shutdown that has already walked past
        this process.
        """
        if self._stopping.is_set():
            log("Not starting the measurement backend: the sidecar is stopping")
            return
        with self._lock:
            self._spawn()

    def _spawn(self):
        """Start the process. The caller holds the lock."""
        self._started = time.monotonic()
        try:
            self._process = subprocess.Popen(
                # -u so its replies are not sitting in a buffer while the
                # sidecar waits for them.
                [self._python, "-u", self._script],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                # Its log lines, relayed into ours below, so a backend that
                # fails to import says so rather than vanishing.
                stderr=subprocess.PIPE,
                cwd=os.path.dirname(self._script),
            )
        except OSError as exc:
            self._process = None
            log(f"Measurement backend could not be started: {exc}")
            return
        # What it has been told is a fact about the process, not about the
        # model, so a respawn has to be told again.
        self._sent = False
        threading.Thread(
            target=self._relay_errors, args=(self._process,), name="measure-log", daemon=True
        ).start()

    def _relay_errors(self, process):
        try:
            for line in process.stderr:
                log(f"measure: {line.decode('utf-8', 'replace').rstrip()}")
        finally:
            # The loop ends at EOF, which is the process exiting however it
            # exited. Left open, every respawn leaks a descriptor - which is
            # what the tests noticed as a ResourceWarning.
            process.stderr.close()

    def warm(self):
        """Ask it for nothing, and time how long the answer took to come.

        The answer is the point rather than the question: it cannot come back
        until the import has finished and the backend has been constructed, so
        this is what turns "the first measurement costs ten seconds" into
        "nobody ever waits". Run when the console is up, like the kernel's own
        warm-up, and reported the way the completer reports its own.
        """
        started = self._started
        if self._request({"command": "ping"}) is not None:
            if started is not None:
                log(f"Measurement backend ready in {time.monotonic() - started:.2f}s")
            self._announce("ready", "")
        else:
            # It did not answer, which is the case worth saying out loud: every
            # measurement afterwards silently produces nothing, and until now
            # the only trace was this line's absence.
            self._announce("failed", "the backend did not answer its first ping")

    def state(self):
        """What the backend is doing, for a report about a stall.

        ``busy`` is the lock rather than a flag of our own: the lock is held for
        exactly one round trip, so holding it *is* being mid-request, and a flag
        beside it could only ever disagree.
        """
        process = self._process
        return {
            "alive": process is not None and process.poll() is None,
            "busy": self._lock.locked(),
            "model": "sent" if self._sent else ("held" if self._mapping is not None else "none"),
        }

    def _announce(self, state, detail):
        """Say how the backend is doing, and only when the answer changes.

        Deduplicated because two of the three callers are on paths that repeat:
        every request that finds a healthy backend would otherwise announce
        `ready` again, which is a frame per measurement and a line per click
        while somebody drags a camera about.
        """
        if state == self._state:
            return
        self._state = state
        if self.on_state is not None:
            self.on_state(state, detail)

    def stop(self):
        """Stop it now, without waiting for anything in flight.

        **The lock is deliberately not taken**, and closing stdin is no longer
        the signal. Both were how a quit became an orphan: a request holds the
        lock for its whole round trip, and the write inside it goes into a pipe
        that the backend may not be reading - a mapping is megabytes, the pipe
        buffer is 64 kB - so `with self._lock` here waits on the one thing in
        this file that can block for as long as it likes. Closing stdin has the
        same shape one level down, because closing a buffered writer flushes it.

        Killed instead. This process holds nothing anybody will miss: it answers
        questions about geometry it was handed, and the next start hands it the
        geometry again.
        """
        self._stopping.set()
        process, self._process = self._process, None
        if process is None:
            return
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except Exception:  # noqa: BLE001 - this runs on the way out
            pass
        # Both ends, and after the kill: a flush that would have blocked now
        # fails with a broken pipe instead, which _close swallows. stderr closes
        # itself in the relay thread when the process ends.
        _close(process.stdin)
        _close(process.stdout)

    # --- what the sidecar calls ---

    def load(self, mapping_bytes):
        """Take a freshly shown model's mapping. Sends nothing.

        One assignment, so there is no window in which this describes a mixture
        of two models - the same property the backend's own load() has.
        """
        with self._lock:
            self._mapping = mapping_bytes
            self._sent = False

    def handle_changes(self, changes):
        """Answer a viewer selection, sending the model first if it is new."""
        reply = self._request({"command": "changes", "changes": changes})
        if reply is None:
            return None
        error = reply.get("error")
        if error is not None:
            log(f"Measurement failed: {error}")
            return None
        return reply.get("response")

    # --- the pipe ---

    def _request(self, message):
        """One round trip, starting the process again if it has died."""
        with self._lock:
            if self._stopping.is_set():
                # A frame queued before the teardown began, dispatched during
                # it. Starting the backend here means a fresh OCP import -
                # seconds of it - behind a stop step that has already run.
                return None
            if self._process is None or self._process.poll() is not None:
                died = self._process is not None
                if died:
                    log("Measurement backend had exited; starting it again")
                    _close(self._process.stdin)
                    _close(self._process.stdout)
                self._spawn()
                if self._process is None:
                    self._announce("failed", "the backend could not be started")
                    return None
                if died:
                    # Recovering silently is what this is not allowed to do.
                    # The measurement still works - that is what the respawn is
                    # for - but something killed a process of ours, the next
                    # answer costs a fresh OCP import and the model crosses the
                    # pipe again, and until now the only trace was one log line
                    # nobody was looking at. `ready` comes back below, when the
                    # replacement actually answers.
                    self._announce("degraded", "the backend exited and was restarted")

            # Nothing has been *shown* is not the same as nothing to measure:
            # the backend loads the splash logo at startup, and the logo is real
            # BREP, so a distance across it is a distance. That case simply has
            # no mapping to send and falls through to the exchange below.
            #
            # It used to `return self._exchange(message)` from inside this
            # branch, and the early exit is what put the chip wrong: measuring
            # the splash worked, went past the line that announces recovery, and
            # left `failed` on screen next to a measurement that had just
            # answered. One exit, so what is true of a measurement is true of
            # every measurement.
            if message.get("command") == "changes" and not self._sent and self._mapping is not None:
                # Timed and sized, because this is the only cost the split
                # added and nobody knew how big a mapping gets on a real
                # assembly - the model log line reports the header and the
                # payload and has never reported this. Once per model, so a
                # line per measurement session rather than per click.
                started = time.monotonic()
                size = len(self._mapping)
                if self._exchange({
                    "command": "load",
                    "mapping": self._mapping.decode("utf-8", "replace"),
                }) is None:
                    return None
                self._sent = True
                log(f"Measurement model sent: {size} B in "
                    f"{(time.monotonic() - started) * 1000:.0f} ms")

            started = time.monotonic()
            reply = self._exchange(message)
            # Only the first selection of a model pays for indexing; the rest
            # are lookups. Both are worth seeing, and the difference between
            # them is the thing somebody would otherwise guess at.
            #
            # And which of the two it was, because "answered in 50 ms" was being
            # written for a round trip that produced nothing at all - a line
            # that says the opposite of what happened is worse than none.
            if reply is None:
                log(f"Measurement got no answer after {(time.monotonic() - started) * 1000:.0f} ms")
            else:
                log(f"Measurement answered in {(time.monotonic() - started) * 1000:.0f} ms")
            # An answer is the only evidence that the backend is well, so it is
            # what clears a `degraded` or a `failed`. Deduplicated in _announce,
            # so this costs nothing on the ordinary path.
            if reply is not None:
                self._announce("ready", "")
            return reply

    # How long one measurement may take before the process is presumed wedged.
    # Generous: indexing a large assembly's BREP is real work. What it bounds is
    # not slowness but silence - a reply that never comes at all, which used to
    # block this thread for ever while holding the lock a freshly shown model
    # needs, so the next show() blocked behind a measurement nobody was waiting
    # for any more.
    REPLY_TIMEOUT = 60

    def _exchange(self, message):
        """Write one message, read its reply. The caller holds the lock."""
        self._next_id += 1
        process = self._process
        if process is None:
            # stop() cleared it while this request was being prepared. It clears
            # without the lock deliberately - see stop() - so this is the one
            # place that has to notice.
            return None
        # A watchdog rather than a timeout on the read, because a pipe cannot be
        # polled portably - select does not take one on Windows. Killing the
        # process makes a blocked read return EOF and a blocked write fail,
        # both of which the code below already handles, and the next request
        # starts a fresh backend.
        #
        # Armed before the write, not after it. The write is where the biggest
        # thing this pipe carries goes - a mapping of serialised BREP, against a
        # 64 kB buffer - so a backend that has stopped reading blocks *there*,
        # and a watchdog covering only the reply covered the half that cannot
        # get stuck without the half that can.
        watchdog = threading.Timer(self.REPLY_TIMEOUT, self._presume_wedged, (process,))
        watchdog.start()
        try:
            body = orjson.dumps({**message, "id": self._next_id})
            process.stdin.write(LENGTH.pack(len(body)))
            process.stdin.write(body)
            process.stdin.flush()
            return self._read_reply(process)
        except Exception as exc:  # noqa: BLE001 - a broken pipe must not raise into a lane
            log(f"Measurement backend stopped answering: {exc}")
            self._process = None
            # Said out loud, because this is the one that stays broken.
            #
            # Measured, with a backend that dies on its import - which is what a
            # half-finished package upgrade looks like: the spawn succeeds, so
            # nothing here calls it a failure, and the respawn on the next click
            # reports `degraded` and then dies the same way. The chip sat on
            # amber for ever while every measurement silently produced nothing.
            # A round trip that broke is the only place that knows.
            #
            # Not while stopping: killing it on the way out is exactly this
            # shape, and a subsystem report into a channel that is closing is
            # noise about a process nobody expects to be alive.
            if not self._stopping.is_set():
                self._announce("failed", f"the backend stopped answering: {exc}")
            return None
        finally:
            watchdog.cancel()

    def _presume_wedged(self, process):
        """Give up on a backend that has stopped answering.

        Said out loud, because the alternative is what this was found by: a
        measurement that never returns, a lock nobody can take, and an
        application that appears to hang minutes later doing something else
        entirely.
        """
        log(f"Measurement backend did not answer in {self.REPLY_TIMEOUT}s; restarting it")
        self._announce("failed", f"no answer in {self.REPLY_TIMEOUT}s, restarted")
        try:
            process.kill()
        except Exception as exc:  # noqa: BLE001 - it may have gone already
            log(f"Could not stop the measurement backend: {exc}")

    def _read_reply(self, process):
        prefix = _read_exactly(process.stdout, LENGTH.size)
        if prefix is None:
            raise EOFError("the measurement backend closed its output")
        body = _read_exactly(process.stdout, LENGTH.unpack(prefix)[0])
        if body is None:
            raise EOFError("the measurement backend closed mid-reply")
        return orjson.loads(body)


def _close(stream):
    try:
        stream.close()
    except Exception:  # noqa: BLE001 - closing on the way out must not raise
        pass


def _read_exactly(stream, count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)
