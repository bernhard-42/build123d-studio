"""The debugged file's own process, and the wire to it.

## Two worlds

The file being debugged runs in a process of its own and the kernel is not
touched by any of it. ipykernel can be debugged in place - the Jupyter protocol
wraps DAP in a `debug_request` on the control channel - and that was tried
first: the handshake works, `dumpCell` maps a cell to a temp file, and an
explicit `breakpoint()` call genuinely stops the kernel. What could not be made
to work is the thing that matters, a breakpoint set through `setBreakpoints`
reporting itself verified and then being run straight past, on ipykernel 7.3.0.

It would have been the wrong shape even had it worked. Debugging in the kernel
puts the debugged file's names into the namespace the console shares, makes the
console unusable while execution is paused, and leaves behind whatever the
session got as far as. The cost of two worlds is one sentence and worth saying:
when the session ends the process dies and its objects go with it. In exchange
the kernel is exactly as it was, throughout and afterwards.

## The debuggee dials out

`debugpy --connect` rather than `--listen`, because this application configures
no ports. The sidecar binds port 0, the operating system picks the number, and
debugpy connects to it - the same arrangement as the model socket and for the
same reason. Measured against the pinned environment: 0.71 s from spawn to
connection.

`-Xfrozen_modules=off` because debugpy warns that frozen modules "may make the
debugger miss breakpoints". It worked without it here; a warning that names
*missed breakpoints* is not one to leave standing in a debugger.

The process is given the kernel's environment, which is what makes the whole
visual-debugging idea work: `show()` called in a paused frame reaches the same
viewer. Measured - a model of 1639 bytes of header and 1248 of payload arrived
at the model socket 0.02 s after an `evaluate` in a frame two deep.

## This is a relay, not a debug client

Nothing here understands DAP. It spawns the process, holds the socket, frames
messages in both directions, pipes stdout, and kills the process at the end.
Every piece of debug state - request ids, breakpoints, frames, the current
thread - lives in the frontend, because that is where the UI needs it and a
second copy here would be a second thing to keep in step. What that leaves is
the part a webview genuinely cannot do: open a listening TCP socket and start a
process.

One thing measurement forced: a `print()` in the debugged script does *not*
arrive as a DAP `output` event. It goes to the process's real stdout, so the
pipe is required rather than a convenience.
"""

import os
import socket
import subprocess
import sys
import threading
import time

from channel import log
from framing import encode, read_message

# How long the debuggee gets to dial back. Measured at 0.71 s; this is the
# bound on "something is wrong", not an expectation - a cold machine importing
# debugpy behind a virus scanner has every right to be slower.
CONNECT_TIMEOUT = 30


class DebugSession:
    """One debugged file, from spawn to exit.

    Answers rather than raises. A debugger is reached for when something is
    already wrong, so a session that cannot start has to say so and leave the
    application working.
    """

    def __init__(self, python, supervisor, on_message, on_output, on_exit):
        self._python = python
        self._supervisor = supervisor
        self._on_message = on_message
        self._on_output = on_output
        self._on_exit = on_exit

        self._process = None
        self._socket = None
        self._listener = None
        # Guards the write end. DAP framing is a header and a body, so two
        # threads writing at once would interleave them into one corrupt
        # message - the same hazard as the kernel's shell socket, and the same
        # answer.
        self._send_lock = threading.Lock()
        self._stopping = threading.Event()

    # --- lifecycle ---

    def start(self, path, env, cwd):
        """Run `path` under the debugger. Returns an error string, or None.

        Blocking, up to CONNECT_TIMEOUT: the caller runs it on a lane, and
        there is nothing useful to do between spawning the process and it
        connecting back.
        """
        if self.alive():
            return "a debug session is already running"
        if not os.path.isfile(path):
            return f"{path} is not a file"

        self._stopping.clear()
        try:
            self._listener = socket.socket()
            self._listener.bind(("127.0.0.1", 0))
            self._listener.listen(1)
            self._listener.settimeout(CONNECT_TIMEOUT)
            port = self._listener.getsockname()[1]
        except OSError as exc:
            self._close_listener()
            return f"could not open a debug port: {exc}"

        command = [
            self._python,
            # Through the supervisor, exactly as a Run File is, and for a reason
            # this process cannot solve for itself: measured, debugpy suspends
            # every thread at a breakpoint, so a watcher living *inside* the
            # debuggee cannot notice the sidecar going while execution is
            # paused - and a debuggee paused for ever is the worst thing to
            # leave behind, holding an interpreter with OCP loaded.
            #
            # debugpy's own `--parent-session-pid` looks like the answer and is
            # not: measured, it reaches pydevd as `ppid` and is used only to
            # report a launcher pid in a PydevdPythonInfo response. Nothing
            # monitors it.
            self._supervisor,
            self._python,
            "-Xfrozen_modules=off",
            "-m", "debugpy",
            "--connect", f"127.0.0.1:{port}",
            # Nothing runs until the frontend has set its breakpoints and sent
            # configurationDone. Without this the script would be most of the
            # way through before anyone could ask it to stop.
            "--wait-for-client",
            path,
        ]
        started = time.monotonic()
        try:
            self._process = subprocess.Popen(
                command, env=env, cwd=cwd,
                # The supervisor's contract: a pipe that is never written to, so
                # a read there returns EOF the moment this process goes. The
                # debuggee itself still gets DEVNULL, from the supervisor.
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
        except OSError as exc:
            self._close_listener()
            return f"could not start the debugger: {exc}"

        try:
            self._socket, _ = self._listener.accept()
        except OSError as exc:
            self.stop()
            return f"the debugger did not connect: {exc}"
        finally:
            self._close_listener()

        log(f"Debug session started on {path}, connected in "
            f"{time.monotonic() - started:.2f}s")
        threading.Thread(target=self._read_socket, name="dap-read", daemon=True).start()
        threading.Thread(target=self._read_output, name="dap-out", daemon=True).start()
        threading.Thread(target=self._watch_exit, name="dap-exit", daemon=True).start()
        return None

    def alive(self):
        return self._process is not None and self._process.poll() is None

    def stop(self):
        """End the session, and wait for the process to actually be gone.

        Waited for rather than signalled and forgotten: the sidecar's own exit
        is an os._exit that runs no cleanup, so a terminate nobody waits on
        leaves a Python process holding the user's geometry behind.

        The supervisor is asked by closing its pipe rather than by being killed,
        because killing it is the one thing that would strand the debuggee - its
        watcher would never get to act. It gives the debuggee SIGTERM, two
        seconds, then SIGKILL.
        """
        self._stopping.set()
        self._close_listener()

        connection, self._socket = self._socket, None
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass

        process, self._process = self._process, None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # Deliberately not killed. Killing the supervisor is the one action
            # that would leave the debuggee running, because its watcher would
            # never get to act - and if we are here, something is wrong enough
            # that the sweep at the next start is the right owner of it.
            log("The debug supervisor did not exit in time")
        except OSError:
            pass
        log("Debug session stopped")

    def _close_listener(self):
        listener, self._listener = self._listener, None
        if listener is not None:
            try:
                listener.close()
            except OSError:
                pass

    # --- the wire ---

    def send(self, message):
        """Relay one DAP message to the debuggee. True if it went."""
        connection = self._socket
        if connection is None:
            return False
        with self._send_lock:
            try:
                connection.sendall(encode(message))
            except OSError as exc:
                if not self._stopping.is_set():
                    log(f"Debug session stopped listening: {exc}")
                return False
        return True

    def _read_socket(self):
        """Relay everything the debuggee says, verbatim.

        The socket is wrapped as a file so it can share the language server's
        framing: DAP took Content-Length from LSP unchanged. Buffered, which
        matters - a message can arrive split across packets and the reader must
        block for the rest rather than treat a short read as the end.
        """
        connection = self._socket
        if connection is None:
            return
        stream = connection.makefile("rb")
        while True:
            message = read_message(stream)
            if message is None:
                break
            try:
                self._on_message(message)
            except Exception as exc:  # noqa: BLE001 - one bad frame is not the session
                log(f"Debug message handler failed: {exc}")
        if not self._stopping.is_set():
            log("The debug adapter closed its connection")

    def _read_output(self):
        """The script's own stdout and stderr, which DAP does not carry."""
        process = self._process
        if process is None or process.stdout is None:
            return
        for line in process.stdout:
            text = line.decode("utf-8", "replace")
            try:
                self._on_output(text)
            except Exception as exc:  # noqa: BLE001
                log(f"Debug output handler failed: {exc}")

    def _watch_exit(self):
        """Say the session is over, once, however it ended.

        The frontend cannot infer it: a script that runs to the end, one that
        raises, and one the user terminated all look the same from the socket,
        which simply stops.
        """
        process = self._process
        if process is None:
            return
        code = process.wait()
        if self._stopping.is_set():
            return
        log(f"The debugged process exited with code {code}")
        try:
            self._on_exit(code)
        except Exception as exc:  # noqa: BLE001
            log(f"Debug exit handler failed: {exc}")


def debug_python(env_root):
    """The interpreter to debug with: the application's own.

    The same one the kernel runs, so the script sees the same build123d - which
    is the only interpreter this application has ever promised anybody.
    """
    if sys.platform == "win32":
        return os.path.join(env_root, ".venv", "Scripts", "python.exe")
    return os.path.join(env_root, ".venv", "bin", "python")
