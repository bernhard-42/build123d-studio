"""build123d-studio sidecar.

Spawned by the webview once the Python environment exists, and owns everything
Python-side: the kernel, the console's pty, and (later) the model socket and
measurement backend.

Started by the frontend rather than declared as a Neutralino extension because
on first run the venv this process lives in does not exist yet - the frontend
has to create it before anything here can be launched.

Talks to the webview over a WebSocket on a random loopback port, announced on
stdout at startup. See channel.py.
"""

import argparse
import faulthandler
import json
import os
import signal
import sys
import threading

# The sidecar is run by path (python sidecar/main.py), so its own directory is
# already on sys.path for these imports.
import appinfo
from channel import KIND_CONSOLE, KIND_MODEL, Channel, flush_logs, log
from completer import Completer
from debugger import DebugSession, debug_python
from formatter import format_source
from runner import RunSession
from instance import Instance, remove_legacy_connection_file, sweep
from kernel import Kernel
from measure_service import MeasurementService
from modelsock import ModelSocket
from ocp_viewer_core.screenshot import save_png_data_url
from pty_console import PtyConsole
from stall import StallWatch

# The kernel-side inspector, reached without binding a name in the user's
# namespace - the variable explorer would otherwise list its own helper.
INSPECTOR = '__import__("build123d_studio.inspector", fromlist=["inspector"])'


# Serial lanes for handlers too slow to run on the receive thread. Two, not one,
# so a restart cannot queue behind an inspection - see the registrations below.
INSPECT = "inspect"
CONTROL = "control"

# Running code, and the working directory that goes with it. Both reach the
# kernel's shell socket, which is shared and can legitimately be held for
# seconds - a restart owns it outright for as long as the kernel takes to come
# back - so neither belongs on the receive thread.
#
# That is what turned a stuck shell socket into a dead application rather than a
# slow one. on_execute blocked the receive thread, the webview's frames stopped
# being read, and websockets' keepalive closed the link twenty seconds later:
# console keystrokes, the variable explorer and Restart Kernel all went with it,
# and none of them had anything to do with the kernel being stuck.
EXECUTE = "execute"

# Completion gets a lane of its own, and the reason is the same one that split
# CONTROL off: a suggestion list is worth nothing late. On the inspect lane it
# would queue behind an expansion that can legitimately take fifteen seconds,
# and on the execute lane behind a Run.
COMPLETE = "complete"

# Measurement gets one of its own, and the reason is two-fold. Its warm-up waits
# for a reply that cannot come until OCP has loaded in the other process - two
# to four seconds - and on a shared lane that is time the variable explorer's
# first refresh spends queued behind it. And a measure click has always waited
# behind whatever the explorer had already asked for, which the comment on
# _pending_details describes as a cost worth coalescing around; it stops being a
# cost at all once the two do not share.
MEASURE = "measure"

# Formatting gets one too, and for the opposite reason to completion's: it is
# not that the answer goes stale, it is that the answer can be slow. Formatting
# is the one request here whose cost grows with the file, and on the complete
# lane a slow one would stall every suggestion typed while it ran - for work the
# user asked for once and is waiting on anyway.
FORMAT = "format"

# Debugging gets a lane of its own because starting a session blocks: the
# process is spawned and then dialled back to, which is under a second when it
# works and up to thirty when it does not. Neither belongs in front of a
# keystroke, and neither belongs behind a fifteen-second inspection.
DEBUG = "debug"

# The most suggestions one reply carries. `import ` alone offers 394 on this
# machine, and every one of them crosses the socket on a keystroke. Two hundred
# is far more than a person reads before typing another character, and the
# frontend marks a truncated list incomplete so Monaco asks again as the word
# grows - which is how a suggestion list is meant to narrow anyway.
MAX_MATCHES = 200

# The refresh that follows an idle is answered by a kernel that has just gone
# idle, so its reply is immediate or it is not coming. Fifteen seconds is right
# for a refresh the user asked for and far too long for one nobody did: it would
# hold the inspect lane, and the explorer's answer would be stale by then anyway.
IDLE_REFRESH_TIMEOUT = 5

# How long startup may take before the sidecar dumps every thread's stack.
# Generous, because a cold Windows machine with a virus scanner has taken over a
# minute to get here legitimately; the point is to catch a start that is never
# going to finish, not a slow one.
STARTUP_WATCHDOG = 120

# And how long the way out may take before this process stops asking politely
# and simply goes. Every step of stop() is meant to be bounded and every child
# has a contract that takes it with us, so reaching this is a fault - which is
# why it says which step it was on before it exits.
#
# It exists because that fault happened: seven sidecars were found on this
# machine outliving the application that started them, each still holding a
# kernel, a console and a measurement backend. See stop() for the deadlock.
SHUTDOWN_DEADLINE = 8

# How long this process waits for its window to come back before stopping.
#
# The socket dying is not the window dying: a machine waking from sleep resets
# loopback connections, and the frontend redials onto the same port and token
# within about ten seconds - after which the kernel, the console, the language
# server and the namespace are all exactly where they were. This has to be
# comfortably longer than that.
#
# It matters at all because nothing else ends this process when a window goes
# without closing its stdin - a page reload does that, and so does killing the
# webview alone. Before this, one of those left a full tree of processes holding
# a kernel that nothing could reach.
ORPHAN_GRACE = 120


class Sidecar:
    def __init__(self, env_root, app_dir, instance):
        self.env_root = env_root
        self.app_dir = app_dir
        # This process's own directory under the shared environment root, with
        # its lock already held - claimed in main() before anything could start
        # a kernel. Everything per-instance hangs off it; see instance.py.
        self.instance = instance
        self.sidecar_dir = os.path.dirname(os.path.abspath(__file__))

        self.channel = Channel()
        # Said here rather than at startup, so a window that connects once and
        # vanishes is covered as well as one that never comes back.
        self.channel.when_client_goes(self._window_gone, ORPHAN_GRACE)
        self.kernel = None
        self.console = None
        # A _restarting Event used to live here, described as what stopped a
        # deliberate console exit being reported as a failure. It was set and
        # cleared and never read: the identity checks in console_start - "is
        # this callback still the current console?" - are what actually do that,
        # and they do it for the pty's output as well as its exit. A dead
        # synchronisation primitive in threaded code is worse than none, because
        # the next person reads the comment and believes it.
        # Last size the pane reported. Remembered so a console started later -
        # after a restart - opens at the size the pane actually is, instead of
        # the 120x30 default that would make its first prompt wrap wrongly.
        self.console_size = None

        # The most recent model's id->shape mapping goes here, not to the
        # webview: it carries serialised BRep geometry that only the
        # measurement backend can use, and would roughly double the traffic for
        # data the viewer would throw away.
        #
        # The service wraps a deferred import - see measure_service.py for why
        # the measurement backend is not imported at the top of this file.
        self.measurements = MeasurementService(
            on_state=lambda state, detail: self.report("measurement", state, detail)
        )

        # The kernel warm-up is held back until the console is up; see
        # warm_kernel.
        self._warmed = threading.Event()
        # Set while an idle-triggered refresh is queued or running, so repeats
        # collapse into one. See request_refresh.
        self._refresh_queued = threading.Event()

        # Names with a detail request already queued or running, for the same
        # reason refreshes coalesce. Expanding a row is one click, but the pane
        # re-requests whatever is open after every execution, and a cell that
        # runs quickly produces requests faster than a large assembly can be
        # measured. They pile up on the inspect lane, each describing a value
        # the next has already superseded. A measure click used to wait behind
        # all of them too; measurement has a lane of its own now, so this
        # coalescing is only about the explorer's own repeats.
        self._pending_details = set()
        self._details_lock = threading.Lock()
        # Whether a completion is already on its way to the kernel. One at a
        # time, and a request that arrives meanwhile is answered empty rather
        # than queued - see on_complete.
        self._completing = threading.Event()

        # Static completion, read from the buffer. The other half of the answer
        # and the half that works on a kernel that has never run anything.
        self.completer = Completer(
            env_root,
            app_dir,
            on_diagnostics=self.on_diagnostics,
            on_state=lambda state, detail: self.report("completion", state, detail),
        )

        # What makes a Run File and a debuggee die with this process, whatever
        # kills it. Both are spawned through it, and it is invoked by path
        # rather than with `-m`: importing the build123d_studio package would
        # pull ocp_vscode and OCP in behind it, which is seconds and hundreds of
        # megabytes before the user's file has started.
        supervisor = os.path.join(app_dir, "kernel", "build123d_studio", "_supervise.py")

        # The debugged file's own process, when there is one. Two worlds: the
        # kernel is not touched by any of it, so nothing here reaches into the
        # kernel's state and nothing in the kernel's state changes because a
        # session ran.
        self.debug = DebugSession(
            python=debug_python(env_root),
            supervisor=supervisor,
            on_message=lambda message: self.channel.send("debug.message", message=message),
            on_output=lambda text: self.channel.send("debug.output", text=text),
            on_exit=lambda code: self.channel.send("debug.exited", code=code),
        )

        # Run File: the same two worlds as debugging, without the debugger. The
        # environment is the kernel's for the same reason - a show() in the file
        # has to reach the viewer that is already on screen.
        self.run = RunSession(
            python=debug_python(env_root),
            supervisor=supervisor,
            on_output=lambda text: self.channel.send("run.output", text=text),
            on_exit=lambda code: self.channel.send("run.exited", code=code),
        )

        # Whether the kernel is part-way through something. Read by completion,
        # which against a kernel with no subshell asks only when it is not: one
        # shell serves requests serially, so a request sent during a cell waits
        # for the cell, and a suggestion list that arrives thirty seconds late
        # is worse than one built from the file alone. Where there is a subshell
        # the question can be asked regardless - see _live_completions. Known
        # exactly rather than guessed at, from the same busy and idle this class
        # already forwards to the toolbar.
        self._kernel_busy = threading.Event()

        # The fallback timer that warms the kernel if the console never speaks.
        # Held so it can be cancelled: see console_start.
        self._warm_timer = None

        # Who owns the way out, and what it is doing. A quit arrives twice - the
        # `shutdown` frame and stdin closing - and running the teardown twice at
        # once is what left seven sidecars on this machine. See stop().
        self._stop_lock = threading.Lock()
        self._stopped = False
        self._stop_step = None

        # Kernel requests that have been sent and not yet answered, by msg_id.
        # See watch_stall: nothing here cancels anything, it only decides when
        # the log stops being silent about a request that is taking too long.
        self._stalls = {}
        self._stalls_lock = threading.Lock()

        # Where the kernel-side build123d-studio package delivers models, the
        # mapping behind them, viewer configs and the two questions a show asks.
        # The port is OS-assigned, so nothing can collide.
        self.models = ModelSocket(
            on_model=self.on_model,
            on_mapping=self.on_mapping,
            on_config=self.on_viewer_config,
            on_command=self.on_viewer_command,
        )

        # The viewer's live state, as the frontend reports it. Every host keeps
        # a picture like this rather than asking its browser synchronously: the
        # renderer notifies as things change, and a show reads the last thing
        # it said. Replaced wholesale rather than mutated, because it is written
        # on the measure lane and read on the model socket's thread.
        self._viewer_status = {}

        # True while the splash logo is the only thing on screen. Its whole
        # purpose is one guard: stopping reset_camera=KEEP from inheriting the
        # logo's camera. The logo is drawn by the frontend at startup and never
        # travels through here, so any model arriving on the model socket is by
        # definition a real one - which is the entire tracking this host needs,
        # and it costs no decoding of a header that is otherwise passed through
        # as the bytes the kernel produced.
        self._splash = True

        # Inline: these only forward, and none of them waits on a lock. Running
        # them on the receive thread is what keeps a keystroke ahead of
        # everything else. Interrupt belongs here in particular - it is the way
        # out of a kernel that is stuck, so it must never queue behind the
        # execution it is meant to stop, and it signals the kernel process
        # rather than going through the shell socket.
        self.channel.on("console.resize", self.on_console_resize)
        self.channel.on("kernel.interrupt", self.on_interrupt)
        self.channel.on("shutdown", self.on_shutdown)

        # Ordered with respect to each other, which is why they share one lane:
        # opening a file sets the working directory and then runs, and a Run
        # that overtook its own chdir would resolve relative paths against the
        # previous file's directory.
        self.channel.on("kernel.execute", self.on_execute, lane=EXECUTE)
        # Inline, and that is load-bearing rather than an optimisation: a run
        # and a debug session read the working directory and are answered on a
        # lane of their own, so a kernel.cwd waiting behind a busy execute lane
        # would let a run start in the directory the user just left. Recording
        # it is a field assignment; the kernel's own chdir is an execute, and
        # on_cwd puts that on the execute lane where it belongs.
        self.channel.on("kernel.cwd", self.on_cwd)

        # Slow, and none of it is worth a dropped keystroke: an inspection waits
        # on the kernel for up to fifteen seconds, activating a measure tool
        # deserialises a BRep per face, edge and vertex of the model, and the
        # About dialog walks the installed distributions.
        self.channel.on("viewer.changes", self.on_viewer_changes, lane=MEASURE)
        self.channel.on("viewer.screenshot", self.on_viewer_screenshot, lane=MEASURE)
        self.channel.on("vars.refresh", self.on_vars_refresh, lane=INSPECT)
        self.channel.on("app.info", self.on_app_info, lane=INSPECT)

        # Inline, and it does not read anything: it claims the name and puts the
        # slow part on the lane itself. Registering it with lane=INSPECT would
        # coalesce nothing, because the queueing happens when the frame is
        # dispatched and the handler only runs once the lane reaches it - by
        # which time the duplicates are already queued behind it.
        self.channel.on("vars.detail", self.on_vars_detail)

        # Its own lane deliberately. Restart is what a user reaches for when
        # something is already stuck, so it must not queue behind the very
        # inspection that is stuck.
        self.channel.on("kernel.restart", self.on_restart, lane=CONTROL)

        # Inline, like vars.detail and for the same reason: the claim has to
        # happen where the frame arrives, not where the work runs. See
        # on_complete for what is being claimed. The lane it submits to has no
        # handler registered against it, so it is opened here - every lane is
        # opened from __init__, before anything else in this process has started
        # a thread, and _lane refuses to create one later.
        self.channel.on("editor.complete", self.on_complete)
        self.channel.open_lane(COMPLETE)

        # Signatures share the lane rather than taking one of their own: both
        # are jedi reading the same buffer, one is asked while the other is not,
        # and two lanes would only let them analyse the same source twice at
        # once.
        self.channel.on("editor.signature", self.on_signature, lane=COMPLETE)
        self.channel.on("editor.hover", self.on_hover, lane=COMPLETE)

        # Telling the server the buffer changed, with nothing asked in return.
        # Diagnostics are *pushed* - it publishes them when it has analysed a
        # document it was told about - so without this the squiggles would only
        # refresh when somebody happened to open the suggestion list.
        self.channel.on("editor.sync", self.on_sync, lane=COMPLETE)
        self.channel.on("editor.close", self.on_close, lane=COMPLETE)
        self.channel.on("editor.format", self.on_format, lane=FORMAT)

        # Starting and stopping block; relaying does not. A DAP message is a
        # socket write, and the frontend sends one per step - so it goes inline,
        # where a step cannot queue behind the session that is starting.
        self.channel.on("run.start", self.on_run_start, lane=DEBUG)
        self.channel.on("run.stop", self.on_run_stop, lane=DEBUG)
        self.channel.on("debug.start", self.on_debug_start, lane=DEBUG)
        self.channel.on("debug.stop", self.on_debug_stop, lane=DEBUG)
        self.channel.on("debug.send", self.on_debug_send)

        # Keystrokes arrive as raw bytes - no base64, no JSON escaping, on what
        # is the hottest path in the UI.
        self.channel.on_binary(KIND_CONSOLE, self.on_console_input)

    # --- lifecycle ---

    def _refusing(self, what):
        """Whether a handler must not start anything, because we are leaving.

        The same reasoning as _abandoning_startup, one layer out. stop() walks
        its steps once, but the lanes keep delivering: a frame queued before the
        teardown began is dispatched during it, and a handler that spawns
        answers it by starting a process whose stop step has already run.

        Each of those is collected in the end by a parent-death contract - a
        poller, a pty, a pipe - so they are orphans of seconds rather than
        leaks. That is exactly why they are worth refusing: those contracts are
        what this teardown exists so as not to depend on.
        """
        if not self._stopped:
            return False
        log(f"Not starting {what}: the sidecar is shutting down")
        return True

    def _abandoning_startup(self):
        """Whether a stop has begun, so nothing further should be brought up.

        A stop can arrive while start() is still running, and does not need the
        stdin watch to do it: `shutdown` is registered with no lane, so the
        frame is handled inline on the channel's receive thread while start()
        works its way down the main one. Without this check the two pass each
        other - stop() walks the subsystems that exist at that instant, start()
        carries on spawning the ones that do not yet, and a kernel or a console
        brought up after its own shutdown step has run is an orphan that nothing
        will look for again.

        The other half of the property is that each subsystem is nameable before
        it spawns: self.kernel and self.console are assigned before their start()
        is called, and the kernel's manager before its process. So stop() finds
        whatever is already up, and this keeps start() from adding to the pile
        behind it.
        """
        if not self._stopped:
            return False
        log("Stopping: the rest of startup is abandoned")
        return True

    def start(self):
        # Each part says how it went as it goes, rather than the application
        # deciding afterwards that everything must have worked. A start that
        # looks fine with one part dead is the expensive failure: every symptom
        # after it - a show that draws nothing, a measurement that answers
        # nothing - points somewhere else.
        if self._abandoning_startup():
            return
        try:
            port = self.models.start()
            self.report("viewer", "ready", f"model channel on port {port}")
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            self.report("viewer", "failed", str(exc))
            raise

        # Spawned here and not waited for. Its import is the same native stack
        # the kernel is about to load in its own process - 3.3 s each on a warm
        # Windows start - and the two now overlap instead of adding up, which is
        # the whole point of it having a process of its own.
        if self._abandoning_startup():
            return
        self.measurements.start()
        self.report("measurement", "starting", "loading the geometry kernel")

        if self._abandoning_startup():
            return
        info = self.kernel_start()
        self.report("kernel", "ready", "started")

        if self._abandoning_startup():
            return
        self.console_start()
        self.report("console", "ready", "")

        # jedi's first call builds its view of the environment and costs half a
        # second. On the lane, so it is paid while the splash is still up rather
        # than by whoever types the first character - the same argument the
        # kernel warm-up makes, and unlike that one it blocks nothing, because
        # this lane exists only for completion.
        self.channel.submit(COMPLETE, self.completer.warm)

        # And the measurement backend answers a question it does not need, for
        # the same reason: the reply cannot arrive until its import has
        # finished, so this is the moment that cost is paid rather than the
        # first click on a measure tool. On the measure lane, which is where
        # measurements are served, so a real one arriving early queues behind a
        # warm backend rather than racing it.
        self.channel.submit(MEASURE, self.measurements.warm)

        if self._abandoning_startup():
            return
        self.channel.send(
            "ready",
            connection_file=info["connection_file"],
            transport=info["transport"],
            model_port=self.models.port,
        )

        # The kernel is up and nothing of the user's is running, which is what
        # the indicator means by idle. Said explicitly because nothing else will:
        # status is forwarded only for an execute_request, so before this the
        # toolbar read "starting" until the first Run - for the whole session if
        # somebody only ever used the console.
        self.channel.send("kernel.status", state="idle")

    def kernel_start(self):
        self.kernel = Kernel(
            env_root=self.env_root,
            app_dir=self.app_dir,
            connection_file=self.instance.connection_file,
            model_port=self.models.port,
            model_token=self.models.token,
            on_iopub=self.on_iopub,
            on_died=self.on_kernel_died,
        )
        return self.kernel.start()

    def on_kernel_died(self):
        """Tell the UI the kernel process is gone.

        Separate from the sidecar's own death, which the frontend already
        notices through the socket closing: this process is fine, the namespace
        and everything in it is not, and the way back is a kernel restart rather
        than a backend one.
        """
        self.report("kernel", "failed", "the kernel process exited")
        self.channel.send("kernel.died")

    def console_start(self):
        # Both callbacks check that they still belong to the current console.
        #
        # A killed console does not go quiet immediately: prompt_toolkit's exit
        # sequence - restore the cursor, erase the display - is already in the
        # pty buffer, and its pump thread delivers it whenever it next runs.
        # During a restart that lands *after* the replacement has drawn its
        # banner, so the last thing the pane receives is an erase and it goes
        # blank. Dropping output from a superseded console is what stops a dead
        # process wiping its successor's screen.
        console = None

        def on_output(data):
            if self.console is not console:
                return
            # The warm-up used to be fired from here, on the console's first
            # byte, on the reasoning that a first byte meant the console had
            # its kernel_info reply and was drawing its banner.
            #
            # That is true of a POSIX pty and false on Windows. Under ConPTY
            # the first bytes are prompt_toolkit setting the terminal up -
            # "\x1b[1t\x1b[c\x1b[?1004h..." - and they arrive before the
            # console has asked the kernel anything. So the warm-up went in
            # first, and the console's kernel_info_request then queued behind
            # a whole build123d import on the kernel's serial shell channel.
            # The pane cleared "Initializing console" the moment those setup
            # bytes arrived and then sat empty for the length of the import:
            # 3.7 s warm here, thirty-odd seconds on a cold machine, which is
            # exactly the delay the warm-up exists to avoid, moved from the
            # first Run onto every startup. See on_iopub for what fires it now.
            self.channel.send_binary(KIND_CONSOLE, data)

        def on_exit():
            # A restart stops the console on purpose and starts a new one a
            # moment later. Reporting that as an exit would put "[console
            # exited]" in the transcript every time the user restarts.
            if self.console is not console:
                return
            self.channel.send("console.exit")

        console = PtyConsole(
            python=sys.executable,
            console_module_dir=self.sidecar_dir,
            connection_file=self.kernel.connection_file,
            on_output=on_output,
            on_exit=on_exit,
        )
        self.console = console
        if self.console_size is None:
            console.start()
        else:
            console.start(*self.console_size)

        # If the console never starts, the warm-up must still happen; otherwise
        # the first Run pays the two seconds we were trying to hide.
        #
        # Cancelled and replaced rather than simply scheduled again. A restart
        # calls this method a second time, and the previous console's timer was
        # still pending: it fired five seconds later, found _warmed cleared by
        # the restart, and sent an execute_request into a client whose channels
        # were at that moment being torn down and rebuilt - "assert self.socket
        # is not None" inside jupyter_client, surfacing as "Kernel warm-up
        # failed" with an empty message. Nothing broke, but the warm-up did not
        # happen, so the first Run after that restart paid the full import.
        if self._warm_timer is not None:
            self._warm_timer.cancel()
        # Generous, because it is now only a backstop for a console that never
        # handshakes at all. It was five seconds when the console's first byte
        # was the trigger; at that length it would simply reintroduce the bug
        # this stopped - a cold Windows console takes longer than five seconds
        # to import IPython and reach its kernel_info_request, and the timer
        # would fire first and put the import back in front of it. Warming up
        # late costs a slower first Run; warming up early costs every startup.
        self._warm_timer = threading.Timer(30.0, self.warm_kernel)
        self._warm_timer.start()

    def warm_kernel(self):
        """Import build123d in the kernel, once, and not before now.

        The kernel answers shell-channel requests one at a time, so this import
        - two seconds of loading OCP - queues ahead of anything that arrives
        while it runs. Doing it at kernel start meant the console's
        kernel_info_request waited behind it, and the pane sat on
        "Initializing console" for the whole import: 0.26s became 2.23s,
        measured. Waiting until the console is through its handshake keeps the
        import invisible.
        """
        if self._warmed.is_set():
            return
        self._warmed.set()
        try:
            # Watched, because this is the line that went unanswered for two
            # minutes on 2026-08-15 and the log said nothing more about it.
            self.watch_stall(self.kernel.warm_up(), "Kernel warm-up")
        except Exception as exc:  # noqa: BLE001 - a failed warm-up only costs speed
            log(f"Kernel warm-up failed: {exc}")

    # --- kernel -> UI ---

    def on_iopub(self, message):
        """Forward the parts of the kernel's iopub stream the UI cares about.

        The console pane renders its own copy of all this through the pty, so
        what goes over the channel here is only what the *other* panes need:
        execution state for the toolbar, and a nudge for the variable explorer.
        """
        msg_type = message["header"]["msg_type"]
        content = message.get("content", {})
        # What the kernel was answering when it published this. Status messages
        # carry it, and it is the difference between "somebody ran code" and
        # "the console asked a question" - see the refresh below.
        parent_type = message["parent_header"].get("msg_type")

        # Before the internal filter, deliberately: the warm-up is the request
        # most worth watching and it is internal, so a stall watch cancelled
        # after that return would never be cancelled at all.
        if msg_type == "status" and content.get("execution_state") == "idle":
            self.finish_stall(message["parent_header"].get("msg_id"))

        # Warm-up and inspection requests produce status traffic of their own.
        # Treating that as user activity would make the explorer refresh in
        # response to its own refresh.
        if self.kernel.is_internal(message):
            return

        # The console's handshake, observed rather than guessed at.
        #
        # Every shell request publishes busy/idle on iopub with the request's
        # type in parent_header, so the idle that follows a kernel_info_request
        # is the console having been answered - the point the first-byte
        # trigger was reaching for and missing on Windows. Warming up here puts
        # the import strictly after the handshake instead of racing it, on
        # every platform, without reading terminal bytes to guess what the
        # console is doing.
        #
        # Nothing else in this application sends kernel_info_request: the
        # sidecar's own goes through wait_for_ready, before the pump exists.
        if (
            msg_type == "status"
            and content.get("execution_state") == "idle"
            and parent_type == "kernel_info_request"
        ):
            self.warm_kernel()
            # The console has been answered, so the pane is live and a Run no
            # longer queues behind a handshake. The toolbar enables itself on
            # this rather than guessing from a timer.
            self.channel.send("console.ready")

        if msg_type == "status":
            state = content.get("execution_state")
            # Only code running counts as the kernel being busy.
            #
            # Every shell request publishes busy and idle, not only the ones
            # that execute something, and the others are answered in about a
            # millisecond. The console asks several as a matter of course - an
            # is_complete_request per line typed at its prompt, a
            # complete_request per Tab, history_request at startup - and each
            # one used to put a busy and an idle through the toolbar a
            # millisecond apart. Measured in one session's log: 41 pairs against
            # 3 Runs, every one of them 1 to 4 ms, which is the flicker somebody
            # sees out of the corner of their eye and cannot account for.
            #
            # The indicator answers "is the kernel running my code", so a
            # question the kernel was asked is not what it is about. The
            # variable explorer's refresh below has always been gated this way,
            # for the neighbouring reason - and the two agreeing is worth
            # something in itself.
            #
            # Our own silent execute_requests do not reach here: is_internal has
            # already turned them away, which is what that record is for.
            if parent_type != "execute_request":
                return

            # Read by completion, which without a subshell asks the kernel only
            # when it is idle. Set from the same messages the toolbar is driven
            # by, so what completion believes and what the user is looking at
            # cannot differ.
            if state == "busy":
                self._kernel_busy.set()
            elif state == "idle":
                self._kernel_busy.clear()
            # Logged with what the kernel was answering, because "Kernel busy"
            # on its own cannot be accounted for afterwards - which is exactly
            # how the flicker above went unexplained until somebody counted the
            # pairs by hand.
            log(f"Kernel {state} ({parent_type})")
            self.channel.send("kernel.status", state=state)
            # Only code can have changed the namespace, which is the same gate
            # as the one above and now enforced by it: nothing else reaches
            # here. Kept as a condition rather than assumed, because it says
            # what the refresh depends on rather than leaving a reader to notice
            # that something twenty lines earlier happens to guarantee it.
            if state == "idle" and parent_type == "execute_request":
                # Namespace may have changed - whoever executed it, editor or
                # console. Pushed rather than polled, so an idle session costs
                # nothing.
                #
                # Queued rather than run here. This is the iopub pump, and it is
                # the only thing forwarding execution state to the toolbar; an
                # inspection that blocked it for fifteen seconds took the busy
                # indicator with it, and further iopub traffic queued behind
                # that.
                self.request_refresh()

        elif msg_type == "error":
            self.channel.send(
                "kernel.error",
                ename=content.get("ename", ""),
                evalue=content.get("evalue", ""),
            )

    # --- kernel -> viewer ---

    def on_model(self, header_bytes, payload):
        """Forward a tessellated model to the viewer pane.

        The header is passed straight through as the bytes the kernel produced -
        no decode/encode round trip - and the payload keeps its raw buffers all
        the way to the webview, where they become typed-array views with no copy.
        """
        self._splash = False
        log(f"Model received: header {len(header_bytes)} B, payload {len(payload)} B")
        self.channel.send_binary(KIND_MODEL, payload, header_bytes=header_bytes)

    def on_mapping(self, mapping_bytes):
        """Keep the id-to-shape mapping of the model just drawn.

        Its own message rather than a field of the model's: it is serialised
        BRep that only the measurement process can use, and sending it to the
        webview would roughly double the traffic for data it cannot read.
        """
        self.measurements.load(mapping_bytes)

    def on_viewer_config(self, config):
        """Apply a config block to the viewer that is already on screen."""
        self.to_viewer({"type": "ui", "config": config})

    def on_viewer_command(self, request):
        """Answer the kernel's questions, and pass its two commands on.

        Both reads a show makes are answered from this process: the status out
        of the picture the frontend pushes up, and the workspace config off the
        settings file. Neither asks the browser anything synchronously - no host
        does - which is what keeps a show from waiting on a webview.

        The two commands that are not questions are answered as soon as they
        have been passed on. `save_screenshot` waits for the file to appear on
        disk rather than for a reply, which is how it works in every host.
        """
        command = request.get("command")
        if command == "status":
            return self._viewer_status
        if command == "splash":
            # Not a setting, which is why it is the only part of the workspace
            # config that comes from here: whether the logo is still the only
            # thing on screen is this process's fact, and the kernel asking its
            # own settings file could not know it - nor could a second kernel,
            # a Run File or a debuggee.
            return {"_splash": self._splash}

        kind = request.get("type")
        if kind in ("screenshot", "set_relative_time"):
            self.to_viewer(request)
            return {"ok": True}

        log(f"Unknown viewer command from the kernel: {request}")
        return {"error": f"unknown command: {command or kind}"}

    # --- when something takes too long ---

    def watch_stall(self, msg_id, what):
        """Watch one kernel request, and say what is going on if it does not end.

        Keyed on the request's msg_id, because that is the only handle both ends
        of the sentence share: the request is sent from a lane and its idle
        arrives on the iopub pump, and nothing else connects the two.
        """
        if msg_id is None:
            return
        watch = StallWatch(f"{what} ({msg_id[:8]})", self.describe, log)
        with self._stalls_lock:
            self._stalls[msg_id] = watch
        watch.start()

    def finish_stall(self, msg_id):
        """The kernel answered. Stop watching, and time it if anybody was told."""
        if msg_id is None:
            return
        with self._stalls_lock:
            watch = self._stalls.pop(msg_id, None)
        if watch is not None:
            watch.finish()

    def describe(self):
        """One line naming every part that could be the reason nothing is moving.

        Everything here is asked of the part itself rather than tracked from
        outside, so it cannot go stale. The order is the order somebody reads it
        in: is the kernel there, is it ours or the user's code that is running,
        is the model channel mid-message, is the measurement backend answering,
        and what is queued behind all of it.
        """
        alive = self.kernel.is_alive() if self.kernel is not None else None
        kernel = {None: "kernel unknown", True: "kernel alive", False: "kernel GONE"}[alive]
        busy = "busy" if self._kernel_busy.is_set() else "idle"

        models = self.models.state() if self.models is not None else {}
        measurement = self.measurements.state() if self.measurements is not None else {}

        # Only the lanes with anything on them, and an explicit word when there
        # are none - a list of seven zeroes is not read, and "lanes empty" is.
        depths = {name: depth for name, depth in self.channel.lane_depths().items() if depth > 0}
        lanes = (
            "lanes empty"
            if len(depths) == 0
            else "lanes " + " ".join(f"{name}={depth}" for name, depth in sorted(depths.items()))
        )

        return (
            f"{kernel}, we think it is {busy}; "
            f"model channel reading={models.get('reading')} queued={models.get('queued')}; "
            f"measurement alive={measurement.get('alive')} busy={measurement.get('busy')} "
            f"model={measurement.get('model')}; {lanes}"
        )

    def report(self, name, state, detail=""):
        """Say how one part of the application is doing, on screen as well as in
        the log.

        Everything below the window has a lifecycle - the model channel, the
        measurement backend, the kernel, the language server, the console - and
        until now each announced itself into the log and told the user nothing.
        The failure that costs the most is not the loud one: it is a start that
        looks fine while one part is dead, because every symptom afterwards is
        the wrong shape. `show()` draws nothing, a measurement answers nothing,
        completion is silent - and the application knew all along.

        Four states, ranked in src/health.js and shown by the toolbar chip as
        the worst anything is in: `ready`, `starting` (on its way up, and
        deliberately not a fault), `degraded` (working, with something worth
        knowing) and `failed`.
        """
        log(f"Subsystem {name}: {state}" + (f" - {detail}" if detail != "" else ""))
        self.channel.send("subsystem", name=name, state=state, detail=detail)

    def to_viewer(self, message):
        """Hand one message to the page.

        One frame carrying the page's own message objects rather than a frame
        type per command: the shared page has a single dispatch, and both other
        page hosts deliver into it the same way - the extension posts into its
        webview and the standalone's shim posts what came off its socket. A
        vocabulary of ours here would be a second dispatch to keep in step.
        """
        self.channel.send("viewer.message", message=message)

    def on_viewer_screenshot(self, message):
        """Write the image the viewer just handed back.

        `save_screenshot` polls for this file rather than waiting for a reply,
        which is why the write is atomic - see the core's screenshot module.
        """
        save_png_data_url(message.get("data"), message.get("filename"))

    def on_viewer_changes(self, message):
        """Answer a viewer selection with exact geometry, and keep the status.

        The viewer's measure tools would otherwise work off the triangulated
        mesh, where a circle is a fan of triangles and its radius depends on the
        tessellation tolerance. The response here is computed from the BRep the
        mesh came from, so the numbers are the model's, not the mesh's.

        The same message is what a later `status` is answered from. What arrives
        is the accumulated picture with this change laid over it - event keys, a
        selection or the active tool, ride only on the change itself and are
        never accumulated, so a selection made minutes ago cannot be replayed
        into an unrelated update.
        """
        changes = message.get("changes", {})
        if len(changes) > 0:
            self._viewer_status = changes

        # Only two keys can produce a measurement, and asking the measurement
        # process about anything else is a round trip to another process for a
        # guaranteed None - hundreds of them while a camera is being dragged,
        # each one a line in the log. The shared backend's own test is exactly
        # this: it tracks the active tool, and `handle_activated_tool` returns
        # immediately unless a selection came with the message.
        if "activeTool" not in changes and "selectedShapeIDs" not in changes:
            return

        response = self.measurements.handle_changes(changes)

        # What was clicked and what came of it - the line a support report needs.
        # The paths are the viewer's own ids, the same ones the tree shows and
        # the same ones the measurement backend prints when it answers, so a
        # user can say "I clicked this" without knowing anything about either.
        #
        # It fires even when the answer is nothing, which is the case worth
        # seeing: a selection that never left the viewer logs no line at all, a
        # selection the backend cannot use logs "nothing", and they are
        # indistinguishable from the screen.
        selected = changes.get("selectedShapeIDs")
        tool = changes.get("activeTool")
        log(
            "Measurement: "
            + (f"tool={tool} " if tool is not None else "")
            + (f"selected={selected} " if selected is not None else "")
            + ("answered" if response is not None else "nothing")
        )
        if response is not None:
            self.to_viewer({"type": "backend_response", **response})

    # --- variable explorer ---
    #
    # Both expressions go through Kernel.evaluate, which uses a silent
    # execute_request carrying a user_expression: the answer comes back on the
    # shell channel, so the console never sees it and In[n] does not advance.

    def _inspect(self, expression, timeout=None):
        """Evaluate an inspector call, which answers with a JSON string.

        A string rather than a structure because IPython's pretty printer
        renders user_expressions results and truncates any sequence at 1000
        items with a literal "..." - which literal_eval reads as Ellipsis and
        json.dumps then refuses. See the inspector's module docstring.
        """
        answer = self.kernel.evaluate(expression, timeout=timeout)
        if answer is None:
            return None
        try:
            return json.loads(answer)
        except (TypeError, ValueError) as exc:
            log(f"Inspection returned something that is not JSON: {exc}")
            return None

    def refresh_variables(self, timeout=None):
        rows = self._inspect(f"{INSPECTOR}.variables()", timeout=timeout)
        if rows is not None:
            self.channel.send("vars.data", variables=rows)

    def request_refresh(self):
        """Queue an idle-triggered refresh, coalescing repeats.

        Every idle asks for one, and a session that runs cells in quick
        succession produces them faster than the kernel answers. They would pile
        up on the lane, each one describing a namespace that the next has
        already superseded. One pending refresh is enough, because it reads the
        namespace as it is when it finally runs.
        """
        if self._refresh_queued.is_set():
            return
        self._refresh_queued.set()
        self.channel.submit(INSPECT, self._run_queued_refresh)

    def _run_queued_refresh(self):
        # Cleared first: an execution that finishes while this one is talking to
        # the kernel has genuinely changed the namespace again and deserves its
        # own refresh.
        self._refresh_queued.clear()
        self.refresh_variables(timeout=IDLE_REFRESH_TIMEOUT)

    def on_vars_refresh(self, _message):
        self.refresh_variables()

    def on_vars_detail(self, message):
        """Claim the row here, do the reading on the lane.

        Runs on the receive thread, which is why it must not read anything: all
        it does is a set membership test. Dropping a duplicate rather than
        queueing it is the whole coalescing - the answer the in-flight request
        produces is the answer this one would, and it goes to the same row.

        Claimed by path *and page*, not by name. A path is one row wherever it
        sits in the tree, and the page matters because paging through a large
        list is the one case where two requests for the same row are genuinely
        different questions - dropping the second would leave the pane on the
        page the user has just clicked away from.
        """
        path = message.get("path") or []
        offset = int(message.get("offset", 0))
        claim = (json.dumps(path), offset)
        with self._details_lock:
            if claim in self._pending_details:
                return
            self._pending_details.add(claim)
        self.channel.submit(INSPECT, lambda: self._send_detail(path, offset, claim))

    def _send_detail(self, path, offset, claim):
        try:
            self._read_detail(path, offset)
        finally:
            # Cleared after the answer has been sent, so that a request arriving
            # while this one runs is dropped rather than answered twice, and one
            # arriving afterwards - the namespace having changed again - is not.
            with self._details_lock:
                self._pending_details.discard(claim)

    def _read_detail(self, path, offset):
        # Both interpolated through repr(), so nothing a user can name reaches
        # the kernel as code. A path is a list of a string and some ints, and
        # repr() of that is a literal the kernel parses back to the same list.
        detail = self._inspect(f"{INSPECTOR}.detail({path!r}, {int(offset)!r})")
        if detail is None:
            # Answered anyway. The row is showing "loading" and only a reply
            # takes that away, so staying silent here left it saying so for the
            # rest of the session - which is what a suspension assembly did,
            # via a bounding_box() that cost 19 s against a 15 s budget. The
            # inspector no longer spends that long, but something will, and
            # "could not be read" is a result where "loading" for ever is a bug.
            detail = {"path": path, "error": "could not be read in time"}
        self.channel.send("vars.detail", detail=detail)

    # --- UI -> sidecar ---

    # Both tolerate self.console being None: there is no console for the moment
    # between stopping the old one and starting its replacement, and a keystroke
    # or a pane resize can arrive in exactly that window.

    def on_console_input(self, payload):
        if self.console is not None:
            self.console.write(payload)

    def on_console_resize(self, message):
        self.console_size = (int(message["columns"]), int(message["rows"]))
        if self.console is not None:
            self.console.set_size(*self.console_size)

    def on_execute(self, message):
        code = message["code"]
        # Logged because "Run does nothing" is otherwise indistinguishable
        # between the frame never arriving, the kernel refusing it, and the
        # result never being displayed. One line here separates all three.
        msg_id = self.kernel.execute(code)

        # Say "busy" here rather than waiting for the kernel to say it.
        #
        # The kernel serves shell requests one at a time and only publishes busy
        # when it *starts* one, so a Run that queues behind something else left
        # the toolbar reading "idle" with the user's own code waiting in line.
        # On a cold Windows machine the startup warm-up is seventy seconds of
        # importing OCP, and for all of it the application claimed to be doing
        # nothing. The request has been accepted by the time we get here, so
        # busy is simply true; the kernel's own idle ends it exactly as before.
        #
        # Recorded as well as announced, for the same reason and at the same
        # moment: between this frame and the kernel's own busy, a completion
        # would otherwise still ask a kernel that has a Run waiting in line.
        self._kernel_busy.set()
        self.channel.send("kernel.status", state="busy")
        log(f"Execute: {len(code)} chars, msg_id {msg_id}")

        # A Run may legitimately take minutes - tessellating a real assembly
        # does - so this is not a timeout and nothing is cancelled. It only
        # means the log stops going quiet: at five seconds, and then every
        # thirty, it says what the rest of the process was doing while nothing
        # happened.
        self.watch_stall(msg_id, "Execute")

    def on_interrupt(self, _message):
        self.kernel.interrupt()

    # --- code completion ---

    def on_complete(self, message):
        """Claim the one completion slot here, do the reading on the lane.

        Runs on the receive thread and does nothing that can block: a flag, and
        either a submission or an empty answer.

        One outstanding completion at a time, and refusing rather than queueing
        is the point. Monaco asks again on every keystroke, so anything that
        makes one completion slow - a kernel part-way through a cell, a large
        file being analysed - would otherwise collect one queued request per
        character typed, to answer all of them in a burst describing a cursor
        position that moved on long ago. Refused, exactly one is in flight and
        the rest are answered at once with nothing, which is what the editor
        does with a late suggestion list anyway.

        Every request is answered, including the refused ones. The frontend is
        holding a promise per request and a silent drop would leak it.
        """
        request_id = message.get("id")
        if self._completing.is_set():
            self.channel.send("editor.complete", id=request_id, matches=[], dropped=True)
            return
        self._completing.set()
        self.channel.submit(COMPLETE, lambda: self._send_completion(message, request_id))

    def _send_completion(self, message, request_id):
        try:
            self._read_completion(message, request_id)
        finally:
            self._completing.clear()

    def _read_completion(self, message, request_id):
        """Both sources, merged, with the live one first.

        jedi before the kernel, deliberately. It is the half that always answers
        - it reads the buffer and needs nothing to have run - so asking it first
        means a kernel that never replies costs the kernel's share of the list
        and not the whole of it.
        """
        source = message.get("source", "")
        line = int(message.get("line", 1))
        column = int(message.get("column", 0))
        path = message.get("path")

        key = message.get("key")
        static = self.completer.complete(source, line, column, path, key)
        live = self._live_completions(source, line, column)

        # The kernel's first, because it is the one that knows. A name it
        # offers exists; a name jedi offers is one the file implies. Where both
        # have it, the kernel's entry wins - it carries the signature IPython
        # worked out - and jedi's duplicate is dropped.
        seen = set()
        entries = []
        for entry in list(live) + list(static):
            key = entry["text"].lstrip(".")
            if key in seen:
                continue
            seen.add(key)
            entries.append(entry)

        truncated = len(entries) > MAX_MATCHES
        entries = entries[:MAX_MATCHES]
        self.channel.send(
            "editor.complete",
            id=request_id,
            matches=[entry["text"] for entry in entries],
            types=entries,
            truncated=truncated,
        )

    def _live_completions(self, source, line, column):
        """What the kernel knows, or nothing when it is in no position to say.

        A busy kernel used to be skipped outright rather than asked with a short
        timeout: it serves shell requests serially, so during a cell the answer
        was not late, it was unavailable - and waiting to discover that would
        have delayed the static half, which is sitting ready. The cost was that
        a long tessellation took the live half of every suggestion list with it,
        which is most of the value on the objects this application is about.

        A subshell answers from a thread of its own, so the question can now be
        asked while a cell runs - measured at 0.01 s against a kernel ten
        seconds from finishing, with 127 matches for "b." on a live Box. The
        gate stays for the kernel that has none, where the old reasoning is
        still exactly right.

        The kernel is asked about the line rather than the file: it completes
        against a namespace, not a syntax tree, and IPython completes a line at
        its own prompt. It also bounds what a keystroke costs on a path where
        the file does not.
        """
        if self.kernel is None:
            return []
        if self._kernel_busy.is_set() and not self.kernel.has_subshell():
            return []

        lines = source.split("\n")
        text = lines[line - 1] if 0 < line <= len(lines) else ""
        content = self.kernel.complete(text, min(column, len(text)))
        if content is None:
            return []

        matches = content.get("matches", [])
        # The span the matches replace. Required by the messaging spec and
        # always there in practice; defaulted to the cursor rather than left
        # None so that every entry leaving here carries integers, and the
        # frontend has no case where it does not know where to put a match.
        start = content.get("cursor_start")
        end = content.get("cursor_end")
        start = start if isinstance(start, int) else column
        end = end if isinstance(end, int) else column
        # ipykernel's experimental type list, paired by index and by text where
        # it is there at all. Nothing depends on it: without it every live match
        # still arrives, with the span the reply carries and no icon of its own.
        types = content.get("metadata", {}).get("_jupyter_types_experimental")
        entries = []
        for index, match in enumerate(matches):
            described = types[index] if isinstance(types, list) and index < len(types) else None
            if described is None or described.get("text") != match:
                described = {}
            entries.append({
                "text": match,
                "type": described.get("type", "instance"),
                "signature": described.get("signature", ""),
                "start": described.get("start", start),
                "end": described.get("end", end),
            })
        return entries

    def on_sync(self, message):
        """The buffer changed. Nothing is asked; diagnostics come back on their own."""
        self.completer.sync(
            message.get("source", ""), message.get("path"), message.get("key")
        )

    def on_close(self, message):
        """A tab closed, so the server can stop holding that document."""
        self.completer.forget(message.get("path"), message.get("key"))

    def on_diagnostics(self, path, key, diagnostics):
        """Push what the server found to the buffer it belongs to.

        Called on the language server's reader thread, so it does the least
        possible: one frame, no locks, nothing that can wait. The frontend
        decides what to draw.
        """
        self.channel.send("editor.diagnostics", path=path, key=key, diagnostics=diagnostics)

    # --- debugging ---

    def on_run_start(self, message):
        """Run a file from disk, with no debugger attached.

        The same environment and the same working directory as a debug session,
        because the difference between the two is a debugger and nothing else -
        a relative path and a show() have to mean what they would have meant
        under Shift-F5.
        """
        if self._refusing("a run"):
            return
        path = message.get("path")
        error = self.run.start(
            path,
            env=self.kernel.kernel_environment(),
            cwd=self.kernel.working_dir,
        )
        if error is None:
            self.channel.send("run.started", path=path)
        else:
            log(f"Run failed to start: {error}")
            self.channel.send("run.failed", path=path, message=error)

    def on_run_stop(self, _message):
        self.run.stop()
        self.channel.send("run.stopped")

    def on_debug_start(self, message):
        """Run a file under the debugger, in a process of its own.

        The environment is the kernel's, which is the whole reason show() works
        from a paused frame: the debuggee gets the model socket's port and token
        and this application's kernel-side package, so a shape it draws arrives
        in the same viewer. Measured - 0.02 s from the evaluate to the model.
        """
        if self._refusing("a debug session"):
            return
        path = message.get("path")
        error = self.debug.start(
            path,
            env=self.kernel.kernel_environment(),
            # Where a relative path in the script resolves, and the same answer
            # the kernel gives: the project root when a folder is open, the
            # file's own directory otherwise.
            cwd=self.kernel.working_dir,
        )
        if error is None:
            self.channel.send("debug.started", path=path)
        else:
            log(f"Debug session failed to start: {error}")
            self.channel.send("debug.failed", path=path, message=error)

    def on_debug_stop(self, _message):
        self.debug.stop()
        self.channel.send("debug.stopped")

    def on_debug_send(self, message):
        """Relay one DAP message, verbatim.

        Nothing here reads it. Request ids, breakpoints, frames and the current
        thread all live in the frontend, because that is where the UI needs
        them and a second copy here would be a second thing to keep in step.
        """
        if not self.debug.send(message.get("message")):
            self.channel.send("debug.exited", code=None)

    def on_hover(self, message):
        self.channel.send(
            "editor.hover",
            id=message.get("id"),
            hover=self.completer.hover(
                message.get("source", ""),
                int(message.get("line", 1)),
                int(message.get("column", 0)),
                message.get("path"),
                message.get("key"),
            ),
        )

    def on_format(self, message):
        """Format the whole buffer, or answer with nothing to do.

        The source comes in the request rather than being read from disk: the
        buffer is what the user is looking at and it is very often unsaved,
        which is precisely when somebody reaches for a formatter.
        """
        formatted, why = format_source(
            message.get("source", ""),
            int(message.get("lineLength", 88)),
        )
        log(f"Format: {why}")
        self.channel.send("editor.format", id=message.get("id"), source=formatted)

    def on_signature(self, message):
        """The call the cursor is inside, for the parameter hints popup.

        jedi only. The kernel's inspect_request answers with formatted text,
        and the popup highlights the parameter being typed - which needs the
        parameters as a list and an index, not a paragraph.
        """
        signature = self.completer.signatures(
            message.get("source", ""),
            int(message.get("line", 1)),
            int(message.get("column", 0)),
            message.get("path"),
            message.get("key"),
        )
        self.channel.send("editor.signature", id=message.get("id"), signature=signature)

    def on_cwd(self, message):
        """Follow the editor: run the kernel in the open file's directory.

        Recorded here, on the receive thread, so nothing can overtake it. The
        chdir that moves the running kernel goes to the execute lane, where it
        stays in order with the user's own cells - a chdir that jumped the queue
        would move a cell that is already running, and os.chdir is process-wide.
        """
        if not self.kernel.record_working_dir(message.get("path")):
            return
        self.channel.submit(EXECUTE, self.kernel.move_to_working_dir)

    def on_restart(self, _message):
        """Restart the kernel, and the console with it.

        Stop the console, replace the kernel, start a fresh console - in that
        order. The console reads the connection file once, at startup, so it can
        only pick up the new kernel's ports by being started after the kernel
        has written them. Left running across a restart it keeps talking to the
        old ports: the prompt redraws, and every keystroke goes nowhere. That
        was "restart kernel silently dies".

        The UI is told before and after, because the gap is seconds long and
        nothing else about it is visible.
        """
        if self._refusing("a kernel restart"):
            return
        self.channel.send("kernel.restarting")
        # Said as it happens, and this is the half that was missing.
        #
        # A restart is what a user reaches for *after* the kernel has died, so
        # the subsystem is `failed` at this moment - and nothing ever took it
        # back. The application worked perfectly afterwards, measurements and
        # all, with a chip in the toolbar reading `failed` for the rest of the
        # session. A state that can go bad and has no way back is worse than no
        # state at all: it teaches the reader to ignore the one indicator that
        # is meant to be worth looking at.
        #
        # `starting` rather than nothing, because it is what is true for the
        # seconds this takes, and it is not a fault - so the chip goes away the
        # moment the user asks for the restart rather than staying red while
        # they watch it work.
        self.report("kernel", "starting", "restarting")
        # Whatever the old kernel was in the middle of went with it. Left set,
        # completion would ask the replacement nothing for the rest of the
        # session, and the live half would quietly stop contributing.
        self._kernel_busy.clear()
        try:
            if self.console is not None:
                self.console.stop()
                # Detach before anything else: from here on the old console's
                # callbacks see that they are no longer current and go quiet.
                self.console = None
            if not self.kernel.restart():
                # A quit landed inside this handler - between the refusal check
                # at the top and here, which is seconds of console teardown and
                # kernel work. There is no kernel now and there must not be a
                # console either: console_start spawns a process, and one
                # started here would be starting into a shutdown that has
                # already walked past its step. Nothing is reported, because
                # there is nobody left to report to.
                return
            # The new kernel has an empty namespace, so build123d has to be
            # imported into it again - and the first Run after a restart should
            # not pay for that any more than the first Run after startup does.
            self._warmed.clear()
            self.console_start()
        except Exception as exc:  # noqa: BLE001 - reported, not fatal
            self.channel.error("Restarting the kernel", exc)
            self.report("kernel", "failed", f"restart failed: {exc}")
            self.channel.send("kernel.restart_failed", message=str(exc))
            return
        self.report("kernel", "ready", "restarted")
        self.channel.send("kernel.restarted")

    def on_app_info(self, _message):
        self.channel.send(
            "app.info",
            info=appinfo.collect(
                env_root=self.env_root,
                connection_file=self.kernel.connection_file if self.kernel else None,
            ),
        )

    def on_shutdown(self, _message):
        self.stop()
        os._exit(0)

    def stop(self):
        """Shut everything down, once, and never take longer than the deadline.

        **Once, whoever asks.** A quit asks twice by design - the frontend sends
        `shutdown` and then closes stdin, so that a webview which dies before the
        frame lands is still heard - and this used to run the whole chain on both
        threads at the same time. That is how seven sidecars came to outlive
        their application on this machine, each holding a kernel, a console and a
        measurement backend: the two runs met in the middle, each waiting on
        something the other had already taken.

        Losing that race is worse than it sounds, and the reason is upstream:
        websockets creates its connection thread **non-daemon**
        (`sync/server.py:285`, 16.1.1). So the frame's handler runs stop() on a
        thread the interpreter will *join* on the way out - and when the stdin
        path finished first and returned, CPython's own teardown then waited for
        ever on a thread stuck inside the same shutdown. Nothing was left to log
        it: from the outside the process simply stayed.

        So: one owner, the second caller waits for it and finds it done, and both
        paths end in os._exit rather than in an interpreter teardown that joins
        somebody else's thread.

        **And bounded.** Every step below is meant to return, but "meant to" is
        what the orphans disproved, so a watchdog leaves anyway and says which
        step it was on. Every child holds a contract that takes it with us - the
        kernel's parent poller, the language server's processId, the console's
        pty, the supervisors' pipes - so exiting is enough to take the tree.

        **What this does not reach**, by decision rather than oversight: any
        process the user's own code started. A subprocess opened in a cell, in a
        Run File script or under the debugger is stopped only as a courtesy, by
        the group kill on the graceful path, and a child that has left the group
        escapes even that. Nothing here hunts for it, and no later start sweeps
        for it either - a process id is reused, and killing the wrong one is
        worse than leaving the right one. See requs.md, Phase 6.
        """
        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True

            watchdog = threading.Timer(SHUTDOWN_DEADLINE, self._give_up_stopping)
            watchdog.daemon = True
            watchdog.start()
            try:
                if self._warm_timer is not None:
                    self._warm_timer.cancel()
                # The kernel first, because its fallback is the weakest.
                #
                # Every child here holds a contract that takes it with us if
                # this never reaches it - a pty that closes, a pipe that ends,
                # a process id it was told to watch. The kernel's is a Python
                # thread polling for its parent, and a user computation inside
                # one long OCCT call holds the GIL for its whole duration, so
                # that thread cannot run and the kernel cannot notice we have
                # gone. A boolean on a large assembly is minutes of exactly
                # that, and it is also the moment somebody is most likely to
                # give up and close the window.
                #
                # So it goes before anything that can spend the deadline. It is
                # asked politely, which is unchanged and still right: what
                # actually collects a kernel that cannot answer is
                # jupyter_client's own escalation to a group kill, and a
                # signal needs nothing of the GIL.
                self._stopping("the kernel", self.kernel, "shutdown")
                self._stopping("the language server", self.completer, "stop")
                self._stopping("the debug session", self.debug, "stop")
                # Before the model channel, like the debugger: it is a child
                # process holding the same environment, and quitting the
                # application must not leave a script running against a viewer
                # that has gone.
                self._stopping("the running file", self.run, "stop")
                self._stopping("the measurement backend", self.measurements, "stop")
                self._stopping("the console", self.console, "stop")
                self._stopping("the model channel", self.models, "stop")
                self._stopping("the webview channel", self.channel, "close")
                # Last, and after the kernel above: releasing the lock is what
                # tells the next instance's sweep that this directory can go,
                # and the connection file inside it is meaningless once the
                # kernel it describes has stopped.
                #
                # The lock always goes; the directory may not, because on Windows
                # a kernel process that has been asked to stop but has not yet
                # stopped still holds the connection file open. Logged rather
                # than swallowed - the next instance's sweep finishes the job.
                self._stopping(
                    "the instance directory",
                    self.instance,
                    "release",
                    on_error=lambda directory, exc: log(f"Could not remove {directory}: {exc}"),
                )
            finally:
                watchdog.cancel()
                self._stop_step = None

    def _stopping(self, what, owner, method, **arguments):
        """Run one step of the shutdown, and remember which one is running.

        Isolated, because a step that raises must not strand the ones after it -
        the language server failing to die is no reason to leave a kernel behind
        - and named, because the watchdog's whole value is being able to say
        where it stopped.
        """
        if owner is None:
            return
        self._stop_step = what
        try:
            getattr(owner, method)(**arguments)
        except Exception as exc:  # noqa: BLE001 - one bad step must not strand the rest
            log(f"Stopping {what} failed: {exc}")

    def _window_gone(self):
        """The window left and did not come back within the grace.

        Stopped in the ordinary way rather than killed: there is a kernel, a
        console, a language server and a measurement backend under this process,
        and the teardown is what stops them in an order that does not strand
        each other. The watchdog behind that teardown still applies.
        """
        log(f"No window for {ORPHAN_GRACE}s; stopping")
        self.stop()
        flush_logs()
        os._exit(0)

    def _give_up_stopping(self):
        """Leave, whatever is holding the shutdown up.

        Exit 0 rather than a fault code: by here the frontend is either gone or
        going, and the only reader left is the log - which gets the sentence
        that matters. A non-zero exit would additionally raise the "the Python
        backend stopped" banner in a window that is closing anyway.
        """
        log(f"Shutdown stuck on {self._stop_step} after {SHUTDOWN_DEADLINE}s; leaving anyway")
        flush_logs()
        os._exit(0)


# The signals worth answering, in the order they matter.
#
# Named rather than referenced, and looked up one at a time, because a platform
# that does not have one does not define it: `signal.SIGHUP` is an AttributeError
# on Windows, and naming it inside a tuple raises while the tuple is being built
# - before any try around the loop can help. That is a startup this process does
# not survive, and it takes the kernel, the console and the measurement backend
# with it.
WANTED_SIGNALS = ("SIGTERM", "SIGHUP")


def signals_to_take(module=signal):
    """The wanted signals that exist here.

    The module is a parameter so the absence of one can be tested on a platform
    that has it - which is the only way this is testable at all, since the fault
    only appears where the signal is missing.
    """
    return [getattr(module, name) for name in WANTED_SIGNALS if hasattr(module, name)]


def take_signals(sidecar):
    """Make a signal run the teardown rather than skip it.

    Without this, `kill <sidecar-pid>` - or a Linux logout that SIGTERMs before
    it SIGKILLs - ends this process with the default disposition, so stop()
    never runs and every child falls back to its own contract. That is fine for
    the ones held by a pipe or a pty, and it is not fine for the kernel: its
    contract is a Python thread polling for its parent, and a user computation
    inside one long OCCT call holds the GIL for the whole of it. The kernel then
    cannot notice we have gone until the call returns - never, for a runaway
    one - and it is holding a loaded geometry kernel and the whole namespace.
    stop() reaches it with a signal that needs nothing of the GIL, which is why
    running it here is worth more than the two lines it costs.

    Registered on the main thread, which is the only place Python delivers
    them, and before anything is spawned so there is no window without it.
    """

    def leave(signum, _frame):
        log(f"Signal {signum}, shutting down")
        # In a finally, because a teardown that throws must still leave. Every
        # step of stop() is already isolated from the ones after it, so reaching
        # here with an exception means something outside those steps raised -
        # and the process staying is a worse answer than the process going
        # without having finished.
        try:
            sidecar.stop()
        finally:
            flush_logs()
            # The same reason the other two exit paths do: returning here would
            # hand over to an interpreter teardown that joins websockets'
            # non-daemon connection thread, possibly from inside this very
            # shutdown.
            os._exit(0)

    for received in signals_to_take():
        try:
            signal.signal(received, leave)
        except (OSError, ValueError):
            # A handler cannot be set from a thread, and a platform may refuse
            # one it nevertheless names. Neither is worth failing a startup over.
            pass


def watch_stdin(sidecar):
    """Take the sidecar down when the application closes our stdin.

    stdin closing is how the app says "we are going away", and it stays the
    signal even though messages travel over the socket, because it cannot be
    missed if the webview dies abruptly: the operating system closes this end
    when the parent goes, however it goes.

    Watched from a thread of its own, started before anything is brought up.
    Read on the main thread it was only reached *after* startup had finished -
    so a quit arriving during a launch was not heard until the launch ended,
    and wait_for_ready alone allows sixty seconds of that. A quit during
    startup is an ordinary quit; it is the moment a first run is slowest and
    most likely to be abandoned.

    The thread does the whole teardown rather than waking the main one, which
    is the point: waiting for the main thread would be waiting for exactly the
    startup being abandoned.
    """

    def watch():
        try:
            for _ in sys.stdin:
                pass
        except OSError:
            # A broken pipe reads as an error rather than as EOF on some
            # platforms, and means the same thing here. _supervise.py guards the
            # identical read and says so; without it here, the one signal that
            # cannot be missed would be missed by this thread dying quietly.
            pass
        log("stdin closed, shutting down")
        # In a finally, and this thread is where that mattered most. stdin
        # closing because the application was *killed* rather than because it
        # quit takes stderr with it in the same instant, so the line above used
        # to raise BrokenPipeError and end this thread here - before stop() had
        # been called, with the main thread still waiting and the whole tree
        # left behind. log() cannot raise any more; this makes anything else
        # that might raise unable to hold the process either.
        try:
            sidecar.stop()
        finally:
            # The same argument as at the end of main(): returning here would
            # hand over to an interpreter teardown that joins websockets'
            # non-daemon connection thread, which may be inside this very
            # shutdown.
            flush_logs()
            os._exit(0)

    threading.Thread(target=watch, name="stdin-watch", daemon=True).start()


def main():
    parser = argparse.ArgumentParser("build123d-studio sidecar")
    parser.add_argument("--env-root", required=True, help="Python environment root")
    parser.add_argument("--app-dir", required=True, help="Application directory")
    args = parser.parse_args()

    # Step out of the application directory before doing anything else.
    #
    # The frontend spawns this process with the app directory as its cwd, and
    # every path it needs afterwards is absolute. Holding that directory open
    # only creates a way to fail: replacing the bundle while the app runs
    # deletes it, and from then on os.getcwd() raises FileNotFoundError -
    # which is what turned an "upgrade packages" into an unrestartable kernel.
    os.chdir(os.path.expanduser("~"))

    # A wedged startup is silent by construction, and that silence is what made
    # the Windows deadlock expensive: the sidecar simply stopped, having logged
    # nothing, and every diagnosis had to begin by adding this. Armed here and
    # cancelled once the application is up, so a healthy start prints nothing
    # and a hung one prints every thread's stack into a log the user already
    # knows how to send. It writes to stderr, which the frontend timestamps and
    # files with everything else.
    faulthandler.dump_traceback_later(STARTUP_WATCHDOG, file=sys.stderr)

    # Claimed before anything can start a kernel, because the connection file
    # lives inside it. Fatal if it fails: a kernel started without a directory of
    # its own is the collision this exists to remove.
    instance = Instance(args.env_root)
    instance.claim()
    log(f"Instance {instance.id}, directory {instance.directory}")

    # Instances that were killed, crashed, or lost power never released their
    # own. Swept here rather than by a timer, so the tidying is done by something
    # a user can point at - starting the application again.
    removed = sweep(
        args.env_root,
        keep_id=instance.id,
        on_error=lambda directory, exc: log(f"Could not remove {directory}: {exc}"),
    )
    if len(removed) > 0:
        log(f"Swept {len(removed)} instance director{'y' if len(removed) == 1 else 'ies'}")
    if remove_legacy_connection_file(args.env_root):
        log("Removed the pre-instance kernel.json from the environment root")

    sidecar = Sidecar(env_root=args.env_root, app_dir=args.app_dir, instance=instance)

    # Before anything is brought up, so that a quit is heard during startup and
    # not only after it. Nothing has been spawned yet at this point, so there is
    # nothing this could be too early for.
    take_signals(sidecar)
    watch_stdin(sidecar)

    sidecar.channel.bind()

    try:
        # bind() and accept() used to have a deliberate gap between them, wide
        # enough to import the measurement backend while this process was still
        # single-threaded. That backend has a process of its own now, so there
        # is nothing to fit in the gap and nothing to get wrong about it.
        sidecar.channel.accept()

        # Kernel and console only come up once the UI is listening, so their
        # first output - the console banner in particular - is not lost.
        sidecar.channel.wait_for_client()
        sidecar.start()
    except Exception as exc:  # noqa: BLE001
        sidecar.channel.error("Sidecar startup", exc)
        sidecar.stop()
        # Exited rather than returned, for the reason the successful path gives
        # below: returning hands over to CPython's teardown, which joins
        # websockets' non-daemon connection thread - and Channel.close() shuts
        # the listener without touching live connections, so with a webview
        # attached that join never returns. The process then neither exits nor
        # disconnects, and the frontend waits out its whole ready timeout to
        # learn about a failure that already happened.
        flush_logs()
        os._exit(1)
    finally:
        faulthandler.cancel_dump_traceback_later()

    # Nothing left for this thread to do, and it must not return: returning
    # hands over to CPython's teardown while the sidecar is still up. So it
    # waits, and there are two ways out. The stdin watch above exits the
    # process; SIGINT arrives here and nowhere else, which is the path a
    # sidecar restart takes on POSIX - the frontend signals the group and this
    # is what turns that into a teardown.
    #
    # With a timeout because a bare wait is not interruptible by a signal on
    # every platform, and being interruptible is the whole reason to wait here
    # rather than to join the watch thread.
    quitting = threading.Event()
    try:
        while not quitting.wait(timeout=1.0):
            pass
    except KeyboardInterrupt:
        log("Interrupted, shutting down")
        sidecar.stop()

    # Exited rather than returned, and this is not tidiness.
    #
    # Returning hands over to CPython's teardown, which joins every non-daemon
    # thread - and websockets creates its connection thread as one
    # (`sync/server.py:285`, 16.1.1). That thread is where the `shutdown` frame
    # is handled, so on a normal quit the interpreter waited for a thread that
    # was itself inside the shutdown. Ours are all daemons deliberately; this
    # makes the one we do not own harmless too.
    flush_logs()
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
