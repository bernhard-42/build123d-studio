"""Run a file from disk, in a process of its own, with no debugger in it.

The other half of the two worlds the debugger established. Run All sends the
buffer's text to the kernel and leaves its names in the namespace the console
shares; Run File runs the *file*, in a process that is gone when it ends. What
that buys is the same thing debugging buys: the run cannot leave anything
behind, and what ran is exactly what is on disk.

It is deliberately not DebugSession with a flag. Everything that makes that
class delicate - binding a port, waiting for debugpy to dial back, relaying DAP
both ways, the ordering rule about `initialized` - exists only because there is
a debugger on the other end. Take it away and what is left is spawn, read, wait,
kill, which is short enough to read in one go and has no protocol to get wrong.

What is shared is the part that must not diverge: the interpreter, from
debug_python, and the environment, which is the kernel's - so a `show()` in the
file reaches the same viewer, exactly as it does from a paused frame.
"""

import os
import subprocess
import threading

from channel import log
from debugger import debug_python  # noqa: F401 - re-exported for main.py's use


class RunSession:
    """One running file. At most one at a time, like a debug session."""

    def __init__(self, python, supervisor, on_output, on_exit):
        self._python = python
        self._supervisor = supervisor
        self._on_output = on_output
        self._on_exit = on_exit
        self._process = None
        # Set while stop() is deliberately killing it, so the exit watcher can
        # tell "the user pressed Stop" from "the script ended".
        self._stopping = threading.Event()

    def start(self, path, env, cwd):
        """Start the file. Returns an error string, or None.

        Does not block on anything: unlike the debugger there is nobody to dial
        back, so the process is running the moment Popen returns.
        """
        if self.alive():
            return "something is already running"
        if not os.path.isfile(path):
            return f"{path} is not a file"

        self._stopping.clear()
        try:
            self._process = subprocess.Popen(
                # Through the supervisor, which is what makes the script die
                # with us. It runs the file as plain `python -u <file>` in a
                # process of its own - -u so output arrives while it runs rather
                # than in a lump at the end, because a script printing its
                # progress is the ordinary case and block buffering makes every
                # one of them look hung until it finishes.
                [self._python, self._supervisor, self._python, "-u", path],
                env=env,
                cwd=cwd,
                # A pipe rather than DEVNULL, and never written to. It is the
                # whole contract: the supervisor blocks reading it, and gets EOF
                # the moment this process goes, whatever took it. The script
                # itself still sees an empty stdin - the supervisor gives it
                # DEVNULL of its own.
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
        except OSError as exc:
            return f"could not start it: {exc}"

        log(f"Running {path}")
        threading.Thread(target=self._read_output, name="run-out", daemon=True).start()
        threading.Thread(target=self._watch_exit, name="run-exit", daemon=True).start()
        return None

    def alive(self):
        return self._process is not None and self._process.poll() is None

    def stop(self):
        """Close the pipe, and say nothing on the way out.

        Closing rather than killing, because killing the supervisor is the one
        thing that would leave the script running - its watcher would never get
        to act. EOF is the same signal it takes when this process dies, so Stop
        and a crash go down identical paths.

        Deliberately does not wait. The supervisor gives the script SIGTERM, two
        seconds, then SIGKILL, and none of that is worth holding a quit for: if
        this process exits first, the pipe closes anyway and the outcome is the
        same.

        _stopping is set first so the exit watcher stays quiet: the frontend
        asked for this and is not waiting to be told what it already knows.
        """
        process = self._process
        self._process = None
        if process is None or process.poll() is not None:
            return
        self._stopping.set()
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError as exc:
            log(f"Could not signal the running file to stop: {exc}")

    def _read_output(self):
        """Everything the file printed, stderr folded into stdout.

        One stream rather than two, because a traceback interleaved with the
        prints that led to it is what somebody is actually reading, and two
        pipes would arrive in whatever order the reader threads happened to be
        scheduled in.
        """
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            for line in process.stdout:
                try:
                    self._on_output(line.decode("utf-8", "replace"))
                except Exception as exc:  # noqa: BLE001
                    log(f"Run output handler failed: {exc}")
        finally:
            # Closed here rather than in stop(), which would be closing it under
            # this thread mid-read. The loop ends on EOF, and killing the process
            # produces one - so both the ordinary end and Stop arrive here. Left
            # open, every run leaks a descriptor, which is what the tests
            # noticed as a ResourceWarning.
            process.stdout.close()

    def _watch_exit(self):
        process = self._process
        if process is None:
            return
        code = process.wait()
        if self._stopping.is_set():
            return
        log(f"The run exited with code {code}")
        try:
            self._on_exit(code)
        except Exception as exc:  # noqa: BLE001
            log(f"Run exit handler failed: {exc}")
