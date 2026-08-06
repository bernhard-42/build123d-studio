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

    def __init__(self, python=None, script=None):
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

        self._next_id = 0
        # One request in flight at a time, which is what makes the reply on the
        # pipe unambiguously this request's. The inspect lane serves viewer
        # changes while the warm-up runs on another, so this is not theoretical.
        self._lock = threading.Lock()

    # --- lifecycle ---

    def start(self):
        """Spawn it and return at once.

        Nothing waits for this. The import inside costs seconds and the sidecar
        has a kernel to start; by the time a model has been shown and a measure
        tool clicked, it has long since finished.
        """
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
        if self._request({"command": "ping"}) is not None and started is not None:
            log(f"Measurement backend ready in {time.monotonic() - started:.2f}s")

    def stop(self):
        with self._lock:
            process = self._process
            self._process = None
        if process is None:
            return
        try:
            # Closing stdin is the shutdown signal, as it is for the sidecar
            # itself: the read loop ends and the process returns. It cannot be
            # missed the way a message can.
            process.stdin.close()
            process.wait(timeout=2)
        except Exception:  # noqa: BLE001 - this runs on the way out
            try:
                process.kill()
            except OSError:
                pass
        finally:
            # stderr closes itself in the relay thread when the process ends.
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
            if self._process is None or self._process.poll() is not None:
                if self._process is not None:
                    log("Measurement backend had exited; starting it again")
                    _close(self._process.stdin)
                    _close(self._process.stdout)
                self._spawn()
                if self._process is None:
                    return None

            if message.get("command") == "changes" and not self._sent:
                if self._mapping is None:
                    # Nothing has been shown, so there is nothing to measure.
                    return None
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
            log(f"Measurement answered in {(time.monotonic() - started) * 1000:.0f} ms")
            return reply

    def _exchange(self, message):
        """Write one message, read its reply. The caller holds the lock."""
        self._next_id += 1
        process = self._process
        try:
            body = orjson.dumps({**message, "id": self._next_id})
            process.stdin.write(LENGTH.pack(len(body)))
            process.stdin.write(body)
            process.stdin.flush()
            return self._read_reply(process)
        except Exception as exc:  # noqa: BLE001 - a broken pipe must not raise into a lane
            log(f"Measurement backend stopped answering: {exc}")
            self._process = None
            return None

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
