"""Kernel lifecycle and the editor's execution path.

One ipykernel process is shared by everything: code run from the Monaco pane,
the jupyter console in the bottom-left pane, and the variable explorer. They all
see the same namespace, which is the entire point - you can run a script and
then poke at its objects in the console.

Transport: TCP on ephemeral loopback ports, on every platform.

ZeroMQ's ipc:// would avoid the ports entirely on macOS and Linux, and this used
to use it, but it bought little and cost real fragility. AF_UNIX paths are capped
near 104 bytes, and jupyter_client derives the socket paths from the connection
file, so whether the kernel got Unix sockets or TCP depended on how long the
install path happened to be - ipc in a development tree, tcp under
"~/Library/Application Support". Behaviour that differs between the configuration
that gets tested and the one users run is worse than a few ports. Windows could
never use it in any case.

What matters is that no port is ever *configured*: every one is OS-assigned, so
nothing can collide. The channels are HMAC-signed with the key in the connection
file, which is written 0600, so loopback reachability is not authority.
"""

import ast
import collections
import os
import queue
import sys
import threading
import time

from jupyter_client.manager import KernelManager

from channel import log

# How long one receive may hold the shell lock. Short enough that a Run never
# waits noticeably behind an in-flight inspection, long enough not to spin.
SHELL_POLL = 0.25

class Kernel:
    """Owns the kernel process and the sidecar's client to it."""

    def __init__(self, env_root, app_dir, model_port, model_token, on_iopub, isolation_port):
        self.env_root = env_root
        self.app_dir = app_dir
        self.model_port = model_port
        self.model_token = model_token
        self.on_iopub = on_iopub
        self.isolation_port = isolation_port

        # A stable, discoverable location: an external `jupyter console
        # --existing <path>` can attach to the very same namespace.
        self.connection_file = os.path.join(env_root, "kernel.json")

        # Where the kernel runs. Follows the open file; home until there is one,
        # and whenever the buffer has never been saved anywhere.
        self.working_dir = os.path.expanduser("~")

        self.manager = None
        self.client = None
        self._iopub_thread = None
        self._stop = threading.Event()

        # Requests this class makes on its own behalf - warm-up and namespace
        # inspection. A silent execute_request still publishes status busy/idle
        # on iopub, so without this the variable explorer's own refresh would
        # look like new user activity and trigger another refresh, for ever.
        # Bounded: only recent ids can still be referenced by in-flight traffic.
        self._internal_requests = collections.deque(maxlen=64)

        # evaluate() reads the shell channel, and is reached from both the iopub
        # pump (on idle) and the channel thread (on an explicit refresh). Two
        # readers would steal each other's replies.
        self._evaluate_lock = threading.Lock()

        # Every touch of the shell socket - send or receive - goes through this.
        #
        # A zmq socket is not thread-safe, and four threads reach this class:
        # the channel thread (Run, and an explicit variable refresh), the iopub
        # pump (the refresh that follows every idle), the pty reader (warm_up,
        # fired by the console's first byte) and the 5 s fallback Timer (warm_up
        # again). Two of them sending at once interleaves the frames of two
        # messages on the wire, and the kernel then reads one message's frames
        # as another's: "Invalid Signature: b'<IDS|MSG>'" - it took the
        # delimiter for the signature - followed by "DELIM not in msg_list" for
        # the frames left over. Reproduced by firing executes while warm_up
        # runs; three corrupt messages inside two kernel restarts.
        #
        # Held for one send, or for one short receive poll, never across a wait
        # for a reply - see _evaluate.
        self._shell_lock = threading.Lock()

    def _send_execute(self, code, **kwargs):
        """The only place an execute_request is put on the shell socket.

        Every caller funnels through here so that no two threads can be inside
        client.execute() at once. See _shell_lock.
        """
        with self._shell_lock:
            return self.client.execute(code, **kwargs)

    def kernel_environment(self):
        """Environment for the kernel process.

        PYTHONPATH exposes the app's kernel-side package, so user code can just
        `from build123d_studio import show`. The model variables tell that package where
        to deliver tessellated models, and prove it is entitled to.
        """
        env = dict(os.environ)
        kernel_path = os.path.join(self.app_dir, "kernel")
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            kernel_path if existing == "" else kernel_path + os.pathsep + existing
        )
        # Bytecode caches must not land in the application bundle. The kernel
        # imports our package from inside it, and on macOS that would litter
        # build123d Studio.app with __pycache__ directories - which also breaks
        # a code signature and fails outright on a read-only install.
        env["PYTHONPYCACHEPREFIX"] = os.path.join(self.env_root, "pycache")

        env["BUILD123D_STUDIO_MODEL_PORT"] = str(self.model_port)
        env["BUILD123D_STUDIO_MODEL_TOKEN"] = self.model_token

        # Isolate ocp_vscode's viewer discovery.
        #
        # _convert() reaches config.workspace_config(), which calls get_port()
        # and then opens a websocket to whatever ocp_vscode viewer it finds, to
        # read that viewer's settings. With a VS Code OCP viewer running on the
        # default 3939, build123d-studio's show() would silently query *that* - a real
        # cross-talk bug, and slower for it.
        #
        # Pointing OCP_PORT at the sidecar's own socket makes the discovery a
        # no-op that can only ever reach a port we own: the connection is
        # refused by the token check, ocp_vscode falls back to its defaults, and
        # no other process on the machine is contacted. Picking some port
        # believed to be closed would be a guess; this is a certainty.
        env["OCP_PORT"] = str(self.isolation_port)
        return env

    def start(self):
        self.manager = KernelManager(
            kernel_name="python3",
            connection_file=self.connection_file,
            transport="tcp",
        )
        # The open file's directory, so relative paths behave the way they do
        # when a script is run from a terminal: export_step(part, "bracket.step")
        # lands beside bracket.py, not somewhere the user has to go looking.
        #
        # Never inherited from the sidecar, which the frontend spawns with the
        # application's own directory. That is inside the .app bundle - writes
        # would go into the application, read-only in a proper install - and
        # replacing the bundle while the app runs deletes it out from under the
        # process, after which os.getcwd() raises FileNotFoundError and
        # jupyter_client cannot launch a kernel at all.
        self.manager.start_kernel(env=self.kernel_environment(), cwd=self.working_dir)

        self.client = self.manager.client()
        self.client.start_channels()
        self.client.wait_for_ready(timeout=60)

        self._stop.clear()
        self._iopub_thread = threading.Thread(
            target=self._pump_iopub, name="iopub", daemon=True
        )
        self._iopub_thread.start()

        log(f"Kernel started, connection file {self.connection_file}")
        # warm_up() is deliberately not called here. See Sidecar.warm_kernel.
        return {
            "transport": "tcp",
            "connection_file": self.connection_file,
        }

    def warm_up(self):
        """Import the heavy modules while the user is still reading the screen.

        Call this only once the console has finished its own handshake: the
        kernel serves shell-channel requests serially, so this import blocks
        whatever is queued behind it - see Sidecar.warm_kernel.

        `import build123d` takes over two seconds, almost all of it loading
        OCP's native OCCT libraries. Left alone it is paid on the first Run,
        which is exactly when it is most noticeable - the kernel meanwhile has
        been idle since app start.

        Done with silent=True and store_history=False, so nothing appears in the
        console and the In[n] counter is untouched. __import__ is used rather
        than a plain import statement to avoid binding module names into the
        user's namespace, where the variable explorer would show them; the
        modules land in sys.modules either way, which is what makes the user's
        own `from build123d import *` return instantly.
        """
        msg_id = self._send_execute(
            "\n".join(
                [
                    '__import__("importlib").import_module("build123d")',
                    '__import__("importlib").import_module("build123d_studio")',
                    '__import__("importlib").import_module("build123d_studio.inspector")',
                ]
            ),
            silent=True,
            store_history=False,
        )
        self._internal_requests.append(msg_id)

    def is_internal(self, message):
        """True for iopub traffic caused by this class rather than by the user."""
        return message["parent_header"].get("msg_id") in self._internal_requests

    def _pump_iopub(self):
        """Forward every iopub message to the sidecar.

        This sees messages caused by *all* clients, which is what lets the
        variable explorer refresh after console input as well as editor runs.
        """
        while not self._stop.is_set():
            try:
                message = self.client.get_iopub_msg(timeout=0.5)
            except queue.Empty:
                continue
            except Exception as exc:  # noqa: BLE001
                if not self._stop.is_set():
                    log(f"iopub pump stopped: {exc}")
                return
            try:
                self.on_iopub(message)
            except Exception as exc:  # noqa: BLE001
                log(f"iopub handler failed: {exc}")

    def execute(self, code, silent=False, store_history=True, user_expressions=None):
        """Run code in the kernel. Returns the request's msg_id.

        The reply is not awaited, and nothing here reads the shell channel:
        _evaluate is its only consumer, and it drops replies that are not its
        own. Anything that ever needs *its* execute_reply has to take that up
        with _evaluate first, or the two will steal from each other depending on
        timing - see the discard count logged there.
        """
        return self._send_execute(
            code,
            silent=silent,
            store_history=store_history,
            user_expressions=user_expressions or {},
        )

    def evaluate(self, expression, timeout=15):
        """Evaluate one expression without disturbing the session.

        Uses an empty, silent execute_request carrying a user_expression. The
        result comes back on the shell channel in the reply, so it never touches
        iopub: nothing is echoed into the console, the In[n] counter does not
        move, and the user's Out history is untouched. That is what lets the
        variable explorer refresh after every execution without being visible.
        """
        with self._evaluate_lock:
            return self._evaluate(expression, timeout)

    def _evaluate(self, expression, timeout):
        msg_id = self._send_execute(
            "",
            silent=True,
            store_history=False,
            user_expressions={"value": expression},
        )
        self._internal_requests.append(msg_id)

        deadline = time.monotonic() + timeout
        discarded = 0
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            # Polled in slices rather than waiting for the whole timeout in one
            # call, because the shell socket is shared: holding the lock for the
            # full fifteen seconds would stall every Run behind an inspection
            # the user never asked for. A slice bounds that to SHELL_POLL.
            try:
                with self._shell_lock:
                    reply = self.client.get_shell_msg(timeout=min(SHELL_POLL, remaining))
            except queue.Empty:
                continue
            if reply["parent_header"].get("msg_id") != msg_id:
                # Replies to other requests legitimately land here - a Run's
                # execute_reply, which nobody awaits - so dropping them is
                # correct and far too common to log one by one. Counted instead,
                # and reported only if this call then fails to find its own
                # reply, which is the case where "who ate it?" is the question.
                discarded += 1
                continue

            result = reply["content"].get("user_expressions", {}).get("value")
            if result is None:
                return None
            if result.get("status") == "error":
                log(f"Inspection failed: {result.get('ename')}: {result.get('evalue')}")
                return None
            text = result.get("data", {}).get("text/plain")
            if text is None:
                return None
            # user_expressions return a repr, so a JSON string arrives quoted
            # and escaped exactly as Python would print it.
            return ast.literal_eval(text)

        log(
            f"Inspection timed out after {timeout}s"
            + (f", having discarded {discarded} unrelated shell replies" if discarded else "")
        )
        return None

    def set_working_dir(self, path):
        """Point the kernel at a directory, now and across future restarts.

        The running kernel is moved with a silent chdir rather than by being
        restarted - opening a file must not throw away the namespace the user
        has built up. store_history=False and the internal-request record keep
        it out of the console transcript, out of In[n], and from looking like
        user activity to the variable explorer.

        __import__ rather than a plain import, so "os" is not bound into the
        user's namespace where the variable explorer would list it.
        """
        if path is None or path == "":
            path = os.path.expanduser("~")
        if not os.path.isdir(path):
            return
        self.working_dir = path
        if self.client is None:
            return
        msg_id = self._send_execute(
            f"__import__('os').chdir({path!r})", silent=True, store_history=False
        )
        self._internal_requests.append(msg_id)

    def interrupt(self):
        if self.manager is not None:
            self.manager.interrupt_kernel()

    def restart(self):
        self._stop.set()
        if self._iopub_thread is not None:
            self._iopub_thread.join(timeout=2)

        # Stop completely and start again, rather than KernelManager.restart_kernel.
        #
        # restart_kernel reuses the same ports, and that is what made restarting
        # unreliable: the sidecar's client reconnects to an endpoint the dying
        # kernel has not finished letting go of, so an execute_request sent
        # shortly afterwards is accepted by the socket and never run. No error,
        # no reply - the Run button simply did nothing. It reproduced on roughly
        # one restart in two, which is exactly the signature of a race.
        #
        # Ports and keys were identical across the working and broken runs, so
        # there is nothing to check for and nothing to retry; the only reliable
        # answer is to leave no old endpoint to reconnect to. A fresh kernel on
        # fresh ports also means restart follows precisely the same path as
        # startup, so anything start() sets up - the inspector binding the
        # variable explorer needs, among others - is set up again rather than
        # being quietly absent afterwards.
        self.shutdown(now=True)
        self.start()
        log("Kernel restarted")

    def shutdown(self, now=False):
        """Stop the kernel.

        now=True kills rather than asking politely, which is what a restart
        wants: restart is what a user reaches for precisely when the kernel is
        wedged in an infinite loop or a blocking call, and a graceful shutdown
        waits for exactly the thing that is never going to finish. At app exit
        the polite form is right, so it stays the default.
        """
        self._stop.set()
        try:
            if self.client is not None:
                self.client.stop_channels()
            if self.manager is not None:
                self.manager.shutdown_kernel(now=now)
        except Exception as exc:  # noqa: BLE001
            log(f"Kernel shutdown: {exc}")
        # jupyter_client removes the ipc socket files itself, but only for
        # connections it wrote - be explicit so nothing is left behind.
        try:
            if self.manager is not None:
                self.manager.cleanup_resources()
        except Exception:  # noqa: BLE001
            pass
