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
import concurrent.futures
import os
import queue
import threading
import time

from jupyter_client.manager import KernelManager

from channel import log

# What one kernel's worth of state looks like to the thread that reads it. See
# Kernel._generation.
Generation = collections.namedtuple("Generation", "manager client stop shell")

# How long a restart waits for the previous pump to notice it should stop. The
# pump polls iopub in half-second slices, so it normally exits well inside this;
# the timeout is for the case where it is stuck in a handler, and proceeding
# anyway is safe because the generation it holds is already closed.
PUMP_JOIN_TIMEOUT = 5

# How long the shell thread waits for a reply before looking at its outbox
# again. This is the one latency the owning-thread design adds: a request
# submitted the instant after a poll begins waits this long before it is sent.
# Twenty milliseconds is well under anything a person notices, and the poll
# itself is a zmq wait rather than a spin.
SHELL_TICK = 0.02

# How long a caller waits for the shell thread to actually put its request on
# the socket. Not the kernel's answer - only the queueing - so it is generous
# purely to distinguish "the outbox is deep" from "the shell thread is wedged".
SEND_TIMEOUT = 30

# Default for an inspection the user asked for, where waiting is better than
# answering "unknown". Callers that inspect on the application's own initiative
# pass something shorter - see IDLE_REFRESH_TIMEOUT.
EVALUATE_TIMEOUT = 15

# How long a completion waits. Short on purpose: a suggestion list is only
# useful while the user is still typing the word it belongs to, and one that
# arrives five seconds later describes a cursor position that has moved on. An
# idle kernel answers a complete_request in single-digit milliseconds - measured
# against ipykernel 7.3.0 - so anything approaching this means the kernel is
# busy with something else, and the honest answer then is no suggestions rather
# than late ones.
COMPLETE_TIMEOUT = 5

# The two kinds of shell request this application sends. A kind rather than two
# outboxes: the ordering guarantee is per socket, not per message type, and one
# owning thread is the whole design - see ShellChannel.
KIND_EXECUTE = "execute"
KIND_COMPLETE = "complete"


class KernelUnavailable(RuntimeError):
    """Raised when there is no kernel to send to, and waiting will not help."""


class Request:
    """One shell request, and somewhere to put what comes back.

    Two futures rather than one, because they answer different questions.
    ``sent`` resolves when the owning thread has put the request on the socket
    and carries the msg_id; ``reply`` resolves when the kernel answers. Callers
    that only need the request to have gone - a Run, a chdir - wait on the
    first and never create the second.

    Splitting them also puts the timeouts where they belong. An inspection's
    fifteen seconds is the kernel's time to answer, not time spent queued behind
    another request, and measuring it from the send is what makes the number
    mean what its name says.

    ``kind`` says which message type this is. Everything here used to be an
    execute_request, and code completion is the first thing that is not: it is a
    complete_request, on the same socket, answered on the same channel and
    routed by the same msg_id. The kind is carried rather than inferred because
    the only place that may act on it is the owning thread.
    """

    __slots__ = ("kind", "code", "kwargs", "internal", "msg_id", "sent", "reply")

    def __init__(self, code, kwargs, internal, want_reply, kind=KIND_EXECUTE):
        self.kind = kind
        self.code = code
        self.kwargs = kwargs
        self.internal = internal
        self.msg_id = None
        self.sent = concurrent.futures.Future()
        self.reply = concurrent.futures.Future() if want_reply else None


class ShellChannel:
    """The only thread that ever touches one kernel's shell socket.

    This replaces a lock. Every caller used to take _shell_lock and use the
    socket itself - the channel thread for a Run, the iopub pump for the refresh
    that follows an idle, the pty reader and a fallback Timer for the warm-up -
    and correctness rested on all four remembering to. A zmq socket is not
    thread safe, and two of them inside client.execute() at once interleaves the
    frames of two messages on the wire: the kernel reads one message's frames as
    another's and answers "Invalid Signature: b'<IDS|MSG>'", then "DELIM not in
    msg_list" for the frames left over.

    A lock makes that a rule to follow. One owning thread makes it a property of
    the design: there is no way to reach the socket except by putting a request
    in the outbox, so a future caller cannot get it wrong by not knowing.

    It also removes the reply stealing. Reading was serialised but not *routed* -
    whoever held the lock took whatever reply arrived, so an inspection could
    swallow a reply meant for another and had to poll in slices, discarding what
    was not its own and hoping the real consumer came back for it. Here the
    thread that reads is the thread that dispatches, replies go to the future
    that asked for them, and an unclaimed reply is counted rather than eaten.

    One instance per kernel generation, handed to the pump's Generation and
    retired with it, so a straggler cannot reach the replacement's socket. See
    Kernel._generation for what that scoping is worth.
    """

    def __init__(self, client, send):
        self._client = client
        # How to actually put a request on the socket. Supplied by Kernel so
        # that recording an internal request stays where its reasoning lives.
        self._send = send
        self._outbox = queue.Queue()
        self._pending = {}
        # Guards _pending, and gates submit against stop so that a request
        # cannot be accepted into an outbox nobody will ever drain.
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        # Replies nobody was waiting for. A Run's execute_reply is the ordinary
        # case and is not a problem; a number that climbs when it should not is
        # the evidence that something else has started reading this socket.
        self.unclaimed = 0

    def start(self):
        self._thread = threading.Thread(target=self._run, name="shell", daemon=True)
        self._thread.start()

    def submit(self, request):
        """Queue a request. Safe from any thread; that is the whole point."""
        with self._lock:
            if self._stop.is_set():
                raise KernelUnavailable("this kernel has been retired")
            self._outbox.put(request)
        return request

    def forget(self, request):
        """Stop waiting for a reply, so a timed-out request is not remembered.

        Without this the pending map grows by one entry for every inspection
        that ever times out, and each holds a Future nobody will look at again.
        """
        if request.msg_id is None:
            return
        with self._lock:
            self._pending.pop(request.msg_id, None)

    def stop(self, reason):
        """Retire this channel, and answer everything still waiting on it.

        Joined without a timeout, deliberately. The shell lock this replaces was
        held across a whole restart and every caller waited on it unboundedly,
        so this is the same guarantee rather than a new one: the socket is not
        closed while a send is in flight. The thread polls in SHELL_TICK slices
        and a zmq send is not a blocking operation in any ordinary sense, so the
        wait is milliseconds unless something is genuinely wedged - in which
        case a restart hanging is what happened before this change too.
        """
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        self._abandon(reason)

    def _run(self):
        while not self._stop.is_set():
            self._drain_outbox()
            self._collect_reply()
        # Anything queued between the last drain and the stop.
        self._drain_outbox()

    def _drain_outbox(self):
        while True:
            try:
                request = self._outbox.get_nowait()
            except queue.Empty:
                return
            if self._stop.is_set():
                self._fail(request, KernelUnavailable("this kernel has been retired"))
                continue
            try:
                msg_id = self._send(self._client, request)
            except Exception as exc:  # noqa: BLE001 - reported to the caller, not raised here
                self._fail(request, exc)
                continue
            request.msg_id = msg_id
            if request.reply is not None:
                with self._lock:
                    self._pending[msg_id] = request
            request.sent.set_result(msg_id)

    def _collect_reply(self):
        try:
            reply = self._client.get_shell_msg(timeout=SHELL_TICK)
        except queue.Empty:
            return
        except Exception as exc:  # noqa: BLE001
            if not self._stop.is_set():
                log(f"Shell channel stopped reading: {exc}")
            self._stop.set()
            return

        msg_id = reply["parent_header"].get("msg_id")
        with self._lock:
            request = self._pending.pop(msg_id, None)
        if request is None:
            # Legitimate and common: a Run's execute_reply, which nobody awaits.
            self.unclaimed += 1
            return
        request.reply.set_result(reply)

    def _abandon(self, reason):
        """Fail everything outstanding, rather than leaving it to time out.

        An inspection whose kernel is replaced underneath it would otherwise sit
        on its full fifteen seconds waiting for an answer that cannot arrive,
        holding the inspect lane for all of it - and the variable explorer row
        would say "loading" for that whole time for no reason.
        """
        with self._lock:
            pending, self._pending = self._pending, {}
        for request in pending.values():
            self._fail(request, KernelUnavailable(reason))
        while True:
            try:
                request = self._outbox.get_nowait()
            except queue.Empty:
                return
            self._fail(request, KernelUnavailable(reason))

    def _fail(self, request, exc):
        if not request.sent.done():
            request.sent.set_exception(exc)
        if request.reply is not None and not request.reply.done():
            request.reply.set_exception(exc)

class Kernel:
    """Owns the kernel process and the sidecar's client to it."""

    def __init__(self, env_root, app_dir, model_port, model_token, on_iopub, on_died,
                 isolation_port):
        self.env_root = env_root
        self.app_dir = app_dir
        self.model_port = model_port
        self.model_token = model_token
        self.on_iopub = on_iopub
        self.on_died = on_died
        self.isolation_port = isolation_port

        # Said once per kernel, not once per half-second. Cleared by start(), so
        # a replacement kernel can report its own death later.
        self._death_reported = False

        # A stable, discoverable location: an external `jupyter console
        # --existing <path>` can attach to the very same namespace.
        self.connection_file = os.path.join(env_root, "kernel.json")

        # Where the kernel runs. Follows the open file; home until there is one,
        # and whenever the buffer has never been saved anywhere.
        self.working_dir = os.path.expanduser("~")

        self.manager = None
        self.client = None
        self._iopub_thread = None

        # One generation of kernel, client and stop flag, handed to the pump as
        # arguments rather than read off self.
        #
        # A restart used to set a single shared _stop, join the pump with a two
        # second timeout, and then *clear* that same flag in start(). A pump
        # that had not finished in two seconds - one blocked in channel.send,
        # which holds _send_lock for the length of an entire model frame - woke
        # up afterwards, found the flag clear because the replacement had
        # cleared it, and carried on reading self.client: the new one. Two
        # threads on one zmq socket, which is the fault that produced "Invalid
        # Signature: b'<IDS|MSG>'" the first time this application met it.
        #
        # Scoped this way, a straggler is harmless whatever it does. It holds
        # its own stop flag, which stays set, and its own client, which has been
        # closed - so it cannot touch the replacement even if it never exits at
        # all. That is what makes the join below a courtesy rather than a
        # correctness requirement, and why it can afford a timeout.
        self._generation = None

        # Requests this class makes on its own behalf - warm-up and namespace
        # inspection. A silent execute_request still publishes status busy/idle
        # on iopub, so without this the variable explorer's own refresh would
        # look like new user activity and trigger another refresh, for ever.
        # Bounded: only recent ids can still be referenced by in-flight traffic.
        self._internal_requests = collections.deque(maxlen=64)

        # Guards the deque above, and it is the ordering rather than the deque
        # that needs guarding.
        #
        # The id used to be recorded after the send returned, which leaves a gap
        # the kernel can answer inside: it publishes busy for a request the pump
        # then fails to recognise as ours, because the id is not in the deque
        # yet. The refresh that follows every idle is the one that hits it, and
        # a leaked pair is visible in any Windows log of the period as a busy
        # and an idle a millisecond apart, right after the warm-up:
        #
        #     17:41:38.520  Kernel busy
        #     17:41:38.521  Kernel idle
        #
        # The toolbar flickers, and the explorer treats its own refresh as user
        # activity and queues another - the exact loop the deque exists to
        # prevent, arrived at by losing a race rather than by forgetting.
        #
        # The send and the record happen together, and is_internal takes this
        # too, so the pump cannot read the deque in between. Held only by the
        # shell thread while it sends, and by whoever asks - never across a wait
        # for anything, because the pump is what tells the toolbar anything and
        # parking it stops the application saying what it is doing.
        self._internal_lock = threading.Lock()


        # The warm-up's request id and start time, so it can be timed. It is the
        # one internal request long enough to matter - the kernel serves the
        # shell channel serially, so a Run pressed during it waits for all of
        # it, and on a cold Windows machine that has been over a minute of
        # loading OCP's libraries. Without a measurement that is indistinguishable
        # from the Run itself being slow.
        self._warm_msg_id = None
        self._warm_started = None

    def _send_and_record(self, client, request):
        """Put one request on the shell socket, and claim it if it is ours.

        Called only by the shell thread, which is the only thread that touches
        the socket at all - see ShellChannel. The client comes in as an argument
        rather than off self for the same reason the pump takes a generation: a
        retired shell thread must not be able to send to the replacement.

        ``internal`` marks a request this class makes on its own behalf, and
        recording it is part of sending it rather than something a caller
        remembers to do afterwards. The record is inside the same critical
        section as the send because the kernel can answer in between: it
        publishes busy for a request the pump then fails to recognise as ours,
        the variable explorer treats its own refresh as user activity and queues
        another, and the toolbar flickers a busy and an idle a millisecond
        apart. Reproduced in tests/sidecar/test_kernel_restart.py, which
        measured 100 misreadings in 100 attempts without this.

        Completions are internal for exactly that reason, and it is not a
        formality: the kernel publishes busy and idle for a complete_request the
        same as for anything else, so without the record every keystroke that
        opened the suggestion list would flash the toolbar. main.py has the
        matching note - the refresh it used to trigger is already gone, because
        that now waits for an idle whose parent was an execute_request.
        """
        with self._internal_lock:
            if request.kind == KIND_COMPLETE:
                msg_id = client.complete(request.code, **request.kwargs)
            else:
                msg_id = client.execute(request.code, **request.kwargs)
            if request.internal:
                self._internal_requests.append(msg_id)
        return msg_id

    def _submit(self, code, internal=False, want_reply=False, kind=KIND_EXECUTE, **kwargs):
        """Hand one execute_request to the current shell thread, or say there is none.

        Refused rather than held, and that is a deliberate simplification. An
        earlier version waited out a restart so that a Run pressed a moment
        before Restart Kernel would run on the replacement - which is what
        holding the shell lock across the swap used to do. Nothing can reach it:
        the frontend raises a full-screen overlay for the whole restart, so the
        button cannot be clicked, and Run's keybindings are Monaco editor
        actions that need editor focus, which clicking Restart has already taken
        away. Confirmed on a real build.

        What the waiting did reach was the failure path. `restart()` clears the
        gate and only `start()` sets it, so a kernel that fails to come back
        left it clear for good and every later request paid the full grace
        period first: measured at 90.0 s to refuse one Run. A restart that
        failed is exactly when the application must answer quickly and say what
        is wrong.

        No gate is needed for the ordinary case either. `_generation` is
        assigned in start() only after wait_for_ready, and a retired
        generation's ShellChannel refuses a submission itself, so the window
        between one kernel going and the next arriving is already covered by the
        two things that were going to exist anyway.
        """
        generation = self._generation
        if generation is None:
            raise KernelUnavailable("there is no kernel")
        return generation.shell.submit(Request(code, kwargs, internal, want_reply, kind=kind))

    def _send_execute(self, code, internal=False, **kwargs):
        """Send, and wait only for it to have gone. Returns the msg_id.

        The wait is over as soon as the shell thread has put the request on the
        socket, so this is bounded by the outbox rather than by the kernel -
        which matters because warm_up() is called from the iopub pump.
        """
        request = self._submit(code, internal=internal, **kwargs)
        return request.sent.result(timeout=SEND_TIMEOUT)

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

    def new_manager(self):
        """Build the kernel manager and launch its process.

        The one method here that starts an operating system process, and split
        out for exactly that reason: everything this class is actually difficult
        about - generation scoping, the pump, what the shell lock covers, which
        request ids count as internal - is in the lifecycle *around* the kernel
        rather than in jupyter_client. Overriding this in a test replaces the
        process and leaves all of that running as shipped, so the restart races
        can be driven deterministically instead of hoped for. See
        tests/sidecar/test_kernel_restart.py.
        """
        manager = KernelManager(
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
        manager.start_kernel(env=self.kernel_environment(), cwd=self.working_dir)
        return manager

    def start(self):
        self.manager = self.new_manager()
        self.client = self.manager.client()
        self.client.start_channels()
        self.client.wait_for_ready(timeout=60)

        self._death_reported = False
        shell = ShellChannel(self.client, self._send_and_record)
        generation = Generation(
            manager=self.manager,
            client=self.client,
            stop=threading.Event(),
            shell=shell,
        )
        self._generation = generation
        shell.start()
        self._iopub_thread = threading.Thread(
            target=self._pump_iopub, args=(generation,), name="iopub", daemon=True
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
                    # Complete from the live object rather than from jedi's
                    # static inference, which is the whole reason to ask a
                    # kernel at all - and which IPython does not do by default.
                    #
                    # Measured against the pinned environment, with a Box in the
                    # namespace: "part." returns 0 matches through jedi and 126
                    # through dir(), including the center and volume this
                    # application exists to help someone reach. jedi cannot
                    # infer a build123d object and answers with nothing rather
                    # than saying so, so the flagship case - the methods of the
                    # part you built two cells ago - was silently empty.
                    #
                    # It is also faster, and the console shares the setting, so
                    # tab completion down there gains the same thing.
                    "get_ipython().Completer.use_jedi = False",
                ]
            ),
            internal=True,
            silent=True,
            store_history=False,
        )
        # Not covered by _internal_lock, and it does not need to be: losing this
        # race costs the "warm-up finished" line, not a refresh loop. It is the
        # same shape as the defect that lock exists for, so if a warm-up ever
        # goes untimed in a log, this is why.
        self._warm_msg_id = msg_id
        self._warm_started = time.monotonic()
        log("Kernel warm-up started: importing build123d")

    def _check_alive(self, generation):
        """Report a kernel process that has gone, once.

        Deliberately silent once this generation has been told to stop: a
        restart retires the pump before replacing the kernel, and the seconds in
        between are a kernel that is *supposed* to be absent. Announcing that as
        a death would put a "the kernel stopped" banner over every restart the
        user asked for.
        """
        if self._death_reported or generation.stop.is_set():
            return
        try:
            alive = generation.manager.is_alive()
        except Exception as exc:  # noqa: BLE001 - a failed check is not a death
            log(f"Could not check whether the kernel is alive: {exc}")
            return
        if alive:
            return

        self._death_reported = True
        log("Kernel process died")
        try:
            self.on_died()
        except Exception as exc:  # noqa: BLE001
            log(f"Kernel death handler failed: {exc}")

    def _note_warm_up(self, message):
        """Log how long the warm-up import took, once its idle comes back."""
        if self._warm_msg_id is None:
            return
        if message["parent_header"].get("msg_id") != self._warm_msg_id:
            return
        if message["header"]["msg_type"] != "status":
            return
        if message.get("content", {}).get("execution_state") != "idle":
            return
        log(f"Kernel warm-up finished in {time.monotonic() - self._warm_started:.1f}s")
        self._warm_msg_id = None

    def is_internal(self, message):
        """True for iopub traffic caused by this class rather than by the user."""
        with self._internal_lock:
            return message["parent_header"].get("msg_id") in self._internal_requests

    def _pump_iopub(self, generation):
        """Forward every iopub message to the sidecar.

        This sees messages caused by *all* clients, which is what lets the
        variable explorer refresh after console input as well as editor runs.

        Everything it touches comes from ``generation`` rather than from self,
        so that a pump left over from a previous kernel cannot reach the current
        one. See Kernel._generation.
        """
        while not generation.stop.is_set():
            try:
                message = generation.client.get_iopub_msg(timeout=0.5)
            except queue.Empty:
                # The half-second the pump would otherwise spend doing nothing,
                # spent asking whether there is still a kernel to hear from.
                #
                # Silence is not a signal here. A dead ZMQ peer raises nothing -
                # zmq reconnects for ever - so an exhausted kernel looked
                # exactly like an idle one: execute() went on succeeding into a
                # socket with nobody behind it, the toolbar kept whatever state
                # it had last been given, and a kernel that died mid-run left it
                # reading "busy" until the application was restarted. Running
                # out of memory tessellating a large model is the realistic way
                # in, and it is the case A2's recovery was written for - except
                # that A2 covers the *sidecar* dying, and the memory is spent in
                # the kernel.
                #
                # The heartbeat channel exists for exactly this and is never
                # read; asking the kernel manager is cheaper than starting to.
                self._check_alive(generation)
                continue
            except Exception as exc:  # noqa: BLE001
                if not generation.stop.is_set():
                    log(f"iopub pump stopped: {exc}")
                return
            try:
                self._note_warm_up(message)
                self.on_iopub(message)
            except Exception as exc:  # noqa: BLE001
                log(f"iopub handler failed: {exc}")

    def execute(self, code, silent=False, store_history=True, user_expressions=None):
        """Run code in the kernel. Returns the request's msg_id.

        The reply is not awaited. It comes back on the shell channel, is matched
        against nothing, and the shell thread counts it as unclaimed - which is
        correct and ordinary. Nobody has to coordinate with anybody about it any
        more: a request that wants its reply asks for one, and gets that one.
        """
        return self._send_execute(
            code,
            silent=silent,
            store_history=store_history,
            user_expressions=user_expressions or {},
        )

    def evaluate(self, expression, timeout=None):
        """Evaluate one expression without disturbing the session.

        Uses an empty, silent execute_request carrying a user_expression. The
        result comes back on the shell channel in the reply, so it never touches
        iopub: nothing is echoed into the console, the In[n] counter does not
        move, and the user's Out history is untouched. That is what lets the
        variable explorer refresh after every execution without being visible.

        Concurrent calls are safe and no longer serialised. This used to hold an
        _evaluate_lock because two readers of one socket would steal each other's
        replies; the shell thread routes each reply to the future that asked for
        it, so an inspection the user asked for and the refresh that follows an
        idle can now overlap instead of queueing.
        """
        return self._evaluate(expression, EVALUATE_TIMEOUT if timeout is None else timeout)

    def _evaluate(self, expression, timeout):
        try:
            request = self._submit(
                "",
                internal=True,
                want_reply=True,
                silent=True,
                store_history=False,
                user_expressions={"value": expression},
            )
        except KernelUnavailable as exc:
            log(f"Inspection not sent: {exc}")
            return None

        try:
            # The send first, and separately, so the timeout below is the
            # kernel's time to answer rather than time spent queued behind
            # another request. Fifteen seconds means fifteen seconds of kernel.
            request.sent.result(timeout=SEND_TIMEOUT)
            reply = request.reply.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            unclaimed = self._unclaimed_replies()
            log(
                f"Inspection timed out after {timeout}s"
                + (f", with {unclaimed} unclaimed shell replies seen" if unclaimed > 0 else "")
            )
            return None
        except KernelUnavailable as exc:
            # The kernel was replaced while this was outstanding. Answering None
            # promptly is the point: the row that asked is showing "loading",
            # and waiting out the full timeout for an answer that cannot arrive
            # would hold the inspect lane for all of it.
            log(f"Inspection abandoned: {exc}")
            return None
        except Exception as exc:  # noqa: BLE001 - a failed send is not a crash
            log(f"Inspection failed to send: {exc}")
            return None
        finally:
            self._forget(request)

        result = reply["content"].get("user_expressions", {}).get("value")
        if result is None:
            return None
        if result.get("status") == "error":
            log(f"Inspection failed: {result.get('ename')}: {result.get('evalue')}")
            return None
        text = result.get("data", {}).get("text/plain")
        if text is None:
            return None
        # user_expressions return a repr, so a JSON string arrives quoted and
        # escaped exactly as Python would print it.
        return ast.literal_eval(text)

    def complete(self, code, cursor_pos, timeout=COMPLETE_TIMEOUT):
        """Ask the kernel what could follow the cursor. Returns the reply content.

        This is the same completion IPython gives at its own prompt, and using
        it is the whole argument for routing completion through the kernel
        rather than a language server: it completes against the *live
        namespace*. It knows the methods of the part the user built two cells
        ago, and a static reading of the file cannot, because the object does
        not exist there - it exists in a kernel that has run the code.

        Silent by construction. A complete_request executes nothing, advances no
        In[n] and produces no output; the only trace it leaves is the busy/idle
        pair on iopub, which is why it is submitted as internal.

        None rather than an empty reply when there is no answer, so the caller
        can tell "the kernel had nothing to suggest" from "there was no kernel"
        or "it was busy". They look the same in a suggestion list and not in a
        log.
        """
        try:
            request = self._submit(
                code,
                internal=True,
                want_reply=True,
                kind=KIND_COMPLETE,
                cursor_pos=cursor_pos,
            )
        except KernelUnavailable as exc:
            log(f"Completion not sent: {exc}")
            return None

        try:
            # Split the same way an inspection is: the timeout below is the
            # kernel's time to answer rather than time spent queued.
            request.sent.result(timeout=SEND_TIMEOUT)
            reply = request.reply.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            # Not an error, and deliberately not logged as one. The ordinary way
            # here is a kernel part-way through a cell: it serves shell requests
            # serially, so a completion asked while code is running waits for the
            # code. That is the defect group 7 is about, and subshells are the
            # answer to it; until then the suggestion list stays empty rather
            # than arriving after the moment it was for.
            log(f"Completion timed out after {timeout}s; the kernel is busy")
            return None
        except KernelUnavailable as exc:
            log(f"Completion abandoned: {exc}")
            return None
        except Exception as exc:  # noqa: BLE001 - a failed send is not a crash
            log(f"Completion failed to send: {exc}")
            return None
        finally:
            self._forget(request)

        content = reply.get("content", {})
        if content.get("status") != "ok":
            log(f"Completion refused by the kernel: {content.get('status')}")
            return None
        return content

    def _unclaimed_replies(self):
        generation = self._generation
        return 0 if generation is None else generation.shell.unclaimed

    def _forget(self, request):
        generation = self._generation
        if generation is not None:
            generation.shell.forget(request)

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
        self._send_execute(
            f"__import__('os').chdir({path!r})",
            internal=True,
            silent=True,
            store_history=False,
        )

    def interrupt(self):
        if self.manager is not None:
            self.manager.interrupt_kernel()

    def _retire_pump(self):
        """Tell the current pump to stop, and wait a while for it to.

        Done before the shell thread is retired, and that ordering still
        matters. The pump can be inside warm_kernel, which submits a request and
        waits for it to be sent; stopping the sender first would leave the pump
        waiting on a future nothing will ever resolve. Retiring the pump first
        means it is gone before its counterpart can strand it. (The stranding
        would in fact be answered now - ShellChannel.stop fails everything
        outstanding rather than letting it time out - but relying on that would
        be relying on an error path where an ordering will do.)

        The timeout is deliberate and no longer load-bearing. A pump that has
        not exited holds a generation whose client is about to be closed and
        whose stop flag stays set for ever, so it cannot reach the replacement
        no matter how long it takes to notice. Waiting is politeness; the
        correctness is in Kernel._generation.
        """
        generation = self._generation
        if generation is not None:
            generation.stop.set()
        thread = self._iopub_thread
        self._iopub_thread = None
        if thread is None:
            return
        thread.join(timeout=PUMP_JOIN_TIMEOUT)
        if thread.is_alive():
            log(f"iopub pump still running after {PUMP_JOIN_TIMEOUT}s; leaving it to its "
                "own kernel, which is closed")

    def _retire_shell(self, reason):
        """Retire the current shell thread and answer everything it still owes.

        Done before the client is closed, which is what makes the close safe:
        the shell thread is the only sender, so once it has stopped there is
        nobody left to be part-way through a send. That is the guarantee
        _shell_lock used to give by being held across the whole restart, now
        held by there being exactly one thread rather than by every caller
        remembering a rule.
        """
        generation = self._generation
        if generation is None:
            return
        generation.shell.stop(reason)

    def restart(self):
        # Nothing else is needed to close the door. _generation still names the
        # generation retired on the next line, and a retired ShellChannel
        # refuses what it is handed, so anything arriving between here and the
        # replacement is told there is no kernel. See _submit.
        self._retire_pump()
        self._retire_shell("the kernel was restarting when this was sent")

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
        #
        # Nothing is locked here any more, and nothing needs to be. The swap
        # used to be wrapped in _shell_lock because a Run on the execute lane
        # could otherwise be inside client.execute() while this rebuilt it.
        # There is now exactly one thread that ever sends, and _retire_shell
        # above has already stopped it and waited for it, so by this line there
        # is no sender left to race. Anything arriving meanwhile is refused by
        # that same retired channel, which is the "for these seconds there is no
        # kernel to talk to" the lock expressed - said once, in one place,
        # instead of by every caller taking a lock it had to know about.
        self._shutdown(now=True)
        self.start()
        log("Kernel restarted")

    def shutdown(self, now=False):
        """Stop the kernel, retiring its threads before closing anything.

        Called from Sidecar.stop() on the way out of the process, where an
        inspection on the inspect lane or a Run on the execute lane can still be
        part-way through a send - and stop_channels() closing the socket
        underneath one of them is the same fault as two threads sharing it, at
        the least convenient moment. Benign in practice because os._exit(0)
        follows, but "benign because of what happens next" is not a property to
        leave lying around in threaded code.

        The order is the guarantee, and it is the same one restart() uses:
        retire the sender, then close what it was sending on.
        """
        self._retire_pump()
        self._retire_shell("the sidecar is shutting down")
        self._shutdown(now=now)

    def _shutdown(self, now=False):
        """Stop the kernel. Caller has retired the pump and the shell thread.

        Both preconditions, and the second is what makes the close safe: the
        shell thread is the only thing that ever sends, so once it has stopped
        there is nobody who can be inside client.execute() when the channels go.

        now=True kills rather than asking politely, which is what a restart
        wants: restart is what a user reaches for precisely when the kernel is
        wedged in an infinite loop or a blocking call, and a graceful shutdown
        waits for exactly the thing that is never going to finish. At app exit
        the polite form is right, so it stays the default.
        """
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
