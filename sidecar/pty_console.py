"""Run the patched jupyter console under a pseudo-terminal.

The console pane is a real terminal, not a REPL widget, so the process on the
other end needs a tty: prompt_toolkit only turns on its full line editor,
history search and completion menus when it is talking to one. A plain pipe
would degrade IPython to a dumb readline-less prompt, which is exactly the
"not an IPython feeling" this design is avoiding.

Bytes flow to and from xterm.js in the webview, base64-wrapped because the
webview link is a text channel.
"""

import os
import signal
import sys
import threading
import time

from channel import log

IS_WINDOWS = sys.platform == "win32"

# Platform-specific, but still at module scope. These used to be imported inside
# the methods that need them, which was both against the project's import rule
# and an actual hazard: the measurement backend is imported on a background
# thread, and a second thread importing anything at the same time can deadlock
# on CPython's per-module import locks. Everything the sidecar needs is now
# resolved before any thread starts.
if IS_WINDOWS:
    import winpty
else:
    import fcntl
    import pty
    import struct
    import termios

READ_CHUNK = 65536


class PtyConsole:
    """A jupyter console process attached to a pty."""

    def __init__(self, python, console_module_dir, connection_file, on_output, on_exit):
        self.python = python
        self.console_module_dir = console_module_dir
        self.connection_file = connection_file
        self.on_output = on_output
        self.on_exit = on_exit

        self.pid = None
        self._fd = None
        self._winpty = None
        self._reader = None
        self._stopped = threading.Event()

        # Guards use of the pty handle against the close that ends it.
        #
        # write() and set_size() checked _stopped and then used _fd, and since
        # the lanes landed, stop() runs on a different thread from either: a
        # restart can close the descriptor in between. A closed descriptor
        # number is not inert, it is reissued to whatever this process opens
        # next - a file the user is editing, the log, a socket - so the failure
        # is not a lost keystroke but keystrokes written somewhere they were
        # never meant to go, and TIOCSWINSZ aimed at something that is not a
        # terminal.
        #
        # Small and never held across anything slow: one os.write to a pty
        # buffer, one ioctl, or the close itself.
        self._fd_lock = threading.Lock()

    def _command(self):
        return [
            self.python,
            "-m",
            "build123d_studio_console",
            "--existing",
            self.connection_file,
            # The kernel is owned by the sidecar; the console must not offer to
            # shut it down when the user types exit.
            "--no-confirm-exit",
        ]

    def _environment(self, columns, rows):
        env = dict(os.environ)
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            self.console_module_dir
            if existing == ""
            else self.console_module_dir + os.pathsep + existing
        )
        # xterm.js speaks xterm-256color; without this prompt_toolkit assumes a
        # dumb terminal and drops colour and the completion menu.
        env["TERM"] = "xterm-256color"
        env["COLUMNS"] = str(columns)
        env["LINES"] = str(rows)
        env["PYTHONUNBUFFERED"] = "1"
        return env

    def start(self, columns=120, rows=30):
        if IS_WINDOWS:
            self._start_windows(columns, rows)
        else:
            self._start_posix(columns, rows)

        # The handle goes to the reader as an argument, for the same reason the
        # kernel's pump takes a generation: stop() drops it from self, and a
        # thread that read the field afterwards would find None where it
        # expected a descriptor. Its own copy stays valid until the close makes
        # the read fail, which is exactly how this loop is meant to end.
        self._reader = threading.Thread(
            target=self._pump, args=(self._fd, self._winpty), name="pty", daemon=True
        )
        self._reader.start()
        log(f"Console started (pid {self.pid})")

    def _start_posix(self, columns, rows):
        pid, fd = pty.fork()
        if pid == 0:
            # Child: replace ourselves with the console. Any failure here has to
            # exit hard - returning would fork the sidecar's own logic.
            try:
                # execve with the environment passed explicitly, rather than
                # mutating os.environ and calling execv. Same result, but it
                # says where the child's environment comes from.
                os.execve(self.python, self._command(), self._environment(columns, rows))
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(f"Failed to start console: {exc}\r\n")
            finally:
                os._exit(1)

        self.pid = pid
        self._fd = fd
        self.set_size(columns, rows)

    def _start_windows(self, columns, rows):
        self._winpty = winpty.PtyProcess.spawn(
            self._command(),
            dimensions=(rows, columns),
            env=self._environment(columns, rows),
        )
        self.pid = self._winpty.pid

    def _pump(self, fd, winpty):
        """Read pty output until the console exits."""
        while not self._stopped.is_set():
            try:
                if IS_WINDOWS:
                    data = winpty.read(READ_CHUNK)
                    if data == "":
                        break
                    chunk = data.encode("utf-8", "replace")
                else:
                    chunk = os.read(fd, READ_CHUNK)
                    if chunk == b"":
                        break
            except OSError:
                # The pty closes with EIO on the master side when the child
                # exits; that is the normal end of this loop, not an error.
                break
            except EOFError:
                break

            try:
                self.on_output(chunk)
            except Exception as exc:  # noqa: BLE001
                log(f"Console output handler failed: {exc}")

        self._stopped.set()
        self._reap()
        try:
            self.on_exit()
        except Exception as exc:  # noqa: BLE001
            log(f"Console exit handler failed: {exc}")

    def _reap(self, timeout=2.0):
        """Collect the console process, so it does not linger as a zombie.

        Nothing used to wait on it: stop() sent SIGTERM and closed the fd, the
        pump broke on EIO, and the child stayed defunct until the sidecar itself
        exited. Every kernel restart replaces the console, so a long session
        accumulated one per restart - untidy, and enough to confuse anything
        counting processes by name, which is how the install script decides
        whether the app is running.

        Safe to call twice: the pump thread reaps when the console ends on its
        own, stop() reaps after killing it, and whichever loses gets
        ChildProcessError.
        """
        if IS_WINDOWS or self.pid is None:
            return

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                reaped, _ = os.waitpid(self.pid, os.WNOHANG)
            except (ChildProcessError, OSError):
                return
            if reaped != 0:
                return
            time.sleep(0.02)

        # SIGTERM was ignored, or the process is wedged somewhere uninterruptible.
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ChildProcessError, OSError):
            pass

    def write(self, data: bytes):
        """Send keystrokes from xterm.js to the console."""
        with self._fd_lock:
            if self._stopped.is_set():
                return
            try:
                if IS_WINDOWS:
                    if self._winpty is None:
                        return
                    self._winpty.write(data.decode("utf-8", "replace"))
                else:
                    if self._fd is None:
                        return
                    os.write(self._fd, data)
            except OSError as exc:
                log(f"Console write failed: {exc}")

    def set_size(self, columns, rows):
        """Propagate a pane resize so prompt_toolkit rewraps correctly."""
        with self._fd_lock:
            if self._stopped.is_set():
                return
            try:
                if IS_WINDOWS:
                    if self._winpty is None:
                        return
                    self._winpty.setwinsize(rows, columns)
                else:
                    if self._fd is None:
                        return
                    packed = struct.pack("HHHH", rows, columns, 0, 0)
                    fcntl.ioctl(self._fd, termios.TIOCSWINSZ, packed)
            except Exception as exc:  # noqa: BLE001
                log(f"Console resize failed: {exc}")

    def stop(self):
        self._stopped.set()
        # The handle is dropped before it is closed, and both happen under the
        # lock, so a writer either goes first with a live descriptor or arrives
        # afterwards and finds None. There is no third case in which it holds a
        # number that has stopped meaning this pty.
        with self._fd_lock:
            fd, self._fd = self._fd, None
            winpty, self._winpty = self._winpty, None
            try:
                if IS_WINDOWS:
                    # pywinpty holds the process handle and terminates it
                    # outright, so there is nothing to reap on this side.
                    if winpty is not None:
                        winpty.terminate(force=True)
                else:
                    if self.pid is not None:
                        os.kill(self.pid, signal.SIGTERM)
                    if fd is not None:
                        os.close(fd)
            except (OSError, ProcessLookupError):
                pass
        self._reap()
