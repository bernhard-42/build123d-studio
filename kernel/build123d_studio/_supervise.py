"""Run a file, and take it with us when the process that started this one goes.

Invoked by path rather than with `-m`, deliberately: importing the
`build123d_studio` package runs its `__init__`, which imports ocp_vscode and
OCP behind it - seconds and hundreds of megabytes that a Run File has no use
for before it starts. Running a file directly imports no package at all, so
this module must stay on the standard library alone.

**The contract is the pipe on stdin.** The sidecar holds the write end open and
never writes to it, so a read here blocks for the whole run and returns EOF the
moment the sidecar goes - however it goes, including a kill it could not catch.
That is the same signal the sidecar itself takes from the frontend: closing
stdin cannot be missed, where a socket or a status message can.

**It supervises rather than wraps.** The script runs in a process of its own, as
plain `python -u <file>`, so its traceback, `__file__`, `sys.argv` and exit code
are exactly what they would be if this file did not exist. Wrapping it with
runpy in this process would have saved a few megabytes and put six frames of our
own on top of every error the user makes.

Output is not relayed: the child inherits this process's stdout and stderr,
which are the sidecar's pipes, so nothing here sits between a print and the
console.
"""

import os
import signal
import subprocess
import sys
import threading

# What a script gets between being asked to stop and being made to. A Run File
# in the middle of an export_step should finish its write; one ignoring SIGTERM
# should not delay a quit for longer than this.
GRACE_SECONDS = 2.0


def _stop_child(child):
    if child.poll() is not None:
        return
    try:
        child.terminate()
    except OSError:
        return
    try:
        child.wait(timeout=GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            child.kill()
        except OSError:
            pass


def _watch_parent(child):
    """Block until stdin reports EOF, then take the child with us."""
    try:
        while os.read(0, 1) != b"":
            pass
    except OSError:
        # A broken pipe reads as an error rather than as EOF on some platforms,
        # and means the same thing here.
        pass
    _stop_child(child)
    # _exit rather than sys.exit: this runs on a thread, and an exception on the
    # main one must not be able to leave the child running.
    os._exit(1)


def main():
    if len(sys.argv) < 2:
        print("usage: _supervise.py <command> [args...]", file=sys.stderr)
        return 2

    # The command verbatim, so the caller decides what runs: `python -u <file>`
    # for a Run File, and the whole debugpy invocation for a debug session. The
    # two need the same contract and differ in nothing else.
    child = subprocess.Popen(
        sys.argv[1:],
        # The run has no console to read from, and the pipe this process watches
        # is ours rather than the child's.
        stdin=subprocess.DEVNULL,
    )

    threading.Thread(target=_watch_parent, args=(child,), name="parent-watch",
                     daemon=True).start()

    def on_signal(_signum, _frame):
        _stop_child(child)
        os._exit(1)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, on_signal)
        except (OSError, ValueError):
            pass

    return child.wait()


if __name__ == "__main__":
    sys.exit(main())
