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
import os
import sys
import threading

# The sidecar is run by path (python sidecar/main.py), so its own directory is
# already on sys.path for these imports.
import appinfo
from channel import KIND_CONSOLE, KIND_MODEL, Channel, log
from kernel import Kernel
from measure_service import MeasurementService
from modelsock import ModelSocket
from pty_console import PtyConsole

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


class Sidecar:
    def __init__(self, env_root, app_dir):
        self.env_root = env_root
        self.app_dir = app_dir
        self.sidecar_dir = os.path.dirname(os.path.abspath(__file__))

        self.channel = Channel()
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
        self.measurements = MeasurementService()

        # The kernel warm-up is held back until the console is up; see
        # warm_kernel.
        self._warmed = threading.Event()
        # Set while an idle-triggered refresh is queued or running, so repeats
        # collapse into one. See request_refresh.
        self._refresh_queued = threading.Event()
        # The fallback timer that warms the kernel if the console never speaks.
        # Held so it can be cancelled: see console_start.
        self._warm_timer = None

        # Where the kernel-side build123d-studio package delivers tessellated models.
        # The port is OS-assigned, so nothing can collide.
        self.models = ModelSocket(on_model=self.on_model)

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
        self.channel.on("kernel.cwd", self.on_cwd, lane=EXECUTE)

        # Slow, and none of it is worth a dropped keystroke: an inspection waits
        # on the kernel for up to fifteen seconds, activating a measure tool
        # deserialises a BRep per face, edge and vertex of the model, and the
        # About dialog walks the installed distributions.
        self.channel.on("viewer.changes", self.on_viewer_changes, lane=INSPECT)
        self.channel.on("vars.refresh", self.on_vars_refresh, lane=INSPECT)
        self.channel.on("vars.detail", self.on_vars_detail, lane=INSPECT)
        self.channel.on("app.info", self.on_app_info, lane=INSPECT)

        # Its own lane deliberately. Restart is what a user reaches for when
        # something is already stuck, so it must not queue behind the very
        # inspection that is stuck.
        self.channel.on("kernel.restart", self.on_restart, lane=CONTROL)

        # Keystrokes arrive as raw bytes - no base64, no JSON escaping, on what
        # is the hottest path in the UI.
        self.channel.on_binary(KIND_CONSOLE, self.on_console_input)

    # --- lifecycle ---

    def load_backend(self):
        """Import the measurement backend, before anything else has a thread.

        On a background thread this deadlocked. Loading OCP's native extensions
        is LoadLibrary, which holds the Windows loader lock, and every thread
        the process starts needs that lock to run DLL_THREAD_ATTACH - so the
        import and the websockets accept loop's per-connection thread waited on
        each other for good, and show() cost seventy seconds. See
        measure_service.py for the full account.

        Moving it to the main thread was the first fix and was not enough. What
        the rule actually says is that *nothing may create a thread while this
        runs*, and which thread performs the import is beside the point. The
        accept loop is the one thread creation whose timing this process does
        not control, so this now happens before it starts - see Channel.bind.

        The assertion is the rule written where it will be enforced rather than
        read, and it checks the accept loop specifically rather than counting
        threads. Threads already exist by now - the lanes open theirs during
        __init__, deliberately, for a neighbouring deadlock - and that is fine.
        The requirement is not that none exists but that none is *created* while
        this runs, and every other thread in this process is started by code
        here at a moment of its own choosing. The accept loop is the exception,
        because a connection arrives when a stranger decides it does.
        """
        assert not self.channel.accepting, (
            "the measurement backend must be imported before the accept loop starts: "
            "a connection arriving during the import creates a thread, and on Windows "
            "that deadlocks against the loader lock the import is holding"
        )
        self.measurements.load_backend()

    def start(self):
        self.models.start()

        info = self.kernel_start()
        self.console_start()

        self.channel.send(
            "ready",
            connection_file=info["connection_file"],
            transport=info["transport"],
            model_port=self.models.port,
        )

    def kernel_start(self):
        self.kernel = Kernel(
            env_root=self.env_root,
            app_dir=self.app_dir,
            model_port=self.models.port,
            model_token=self.models.token,
            on_iopub=self.on_iopub,
            on_died=self.on_kernel_died,
            isolation_port=self.channel.port,
        )
        return self.kernel.start()

    def on_kernel_died(self):
        """Tell the UI the kernel process is gone.

        Separate from the sidecar's own death, which the frontend already
        notices through the socket closing: this process is fine, the namespace
        and everything in it is not, and the way back is a kernel restart rather
        than a backend one.
        """
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
            self.kernel.warm_up()
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

        if msg_type == "status":
            state = content.get("execution_state")
            # Logged, because the frontend's timestamps then say exactly when
            # the kernel *started* the user's code as opposed to when the Run
            # was sent. The gap between the two is queueing behind something
            # else, and without these two lines a Run waiting its turn and a
            # Run running slowly look identical from the outside.
            log(f"Kernel {state}")
            self.channel.send("kernel.status", state=state)
            # Only code can have changed the namespace.
            #
            # This used to refresh after *any* request went idle, which is most
            # visible at startup: the console's kernel_info_request and
            # history_request each bought an inspection, and the first landed
            # behind the warm-up import on the kernel's serial shell channel and
            # died at its five-second budget - "Inspection timed out after 5s,
            # having discarded 1 unrelated shell replies" on every cold start,
            # for a namespace that was empty and had not changed. A console
            # tab-completion's complete_request bought one too.
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

    def on_model(self, header_bytes, mapping_bytes, payload):
        """Forward a tessellated model to the viewer pane.

        The header is passed straight through as the bytes the kernel produced -
        no decode/encode round trip - and the payload keeps its raw buffers all
        the way to the webview, where they become typed-array views with no copy.
        """
        self.measurements.load(mapping_bytes)
        log(f"Model received: header {len(header_bytes)} B, payload {len(payload)} B")
        self.channel.send_binary(KIND_MODEL, payload, header_bytes=header_bytes)

    def on_viewer_changes(self, message):
        """Answer a viewer selection with exact geometry.

        The viewer's measure tools would otherwise work off the triangulated
        mesh, where a circle is a fan of triangles and its radius depends on the
        tessellation tolerance. The response here is computed from the BRep the
        mesh came from, so the numbers are the model's, not the mesh's.
        """
        response = self.measurements.handle_changes(message.get("changes", {}))
        if response is not None:
            self.channel.send("viewer.response", response=response)

    # --- variable explorer ---
    #
    # Both expressions go through Kernel.evaluate, which uses a silent
    # execute_request carrying a user_expression: the answer comes back on the
    # shell channel, so the console never sees it and In[n] does not advance.

    def refresh_variables(self, timeout=None):
        rows = self.kernel.evaluate(f"{INSPECTOR}.variables()", timeout=timeout)
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
        name = message["name"]
        # repr() so a name can never be injected into the expression.
        detail = self.kernel.evaluate(f"{INSPECTOR}.detail({name!r})")
        if detail is not None:
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
        self.channel.send("kernel.status", state="busy")
        log(f"Execute: {len(code)} chars, msg_id {msg_id}")

    def on_interrupt(self, _message):
        self.kernel.interrupt()

    def on_cwd(self, message):
        """Follow the editor: run the kernel in the open file's directory."""
        self.kernel.set_working_dir(message.get("path"))

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
        self.channel.send("kernel.restarting")
        try:
            if self.console is not None:
                self.console.stop()
                # Detach before anything else: from here on the old console's
                # callbacks see that they are no longer current and go quiet.
                self.console = None
            self.kernel.restart()
            # The new kernel has an empty namespace, so build123d has to be
            # imported into it again - and the first Run after a restart should
            # not pay for that any more than the first Run after startup does.
            self._warmed.clear()
            self.console_start()
        except Exception as exc:  # noqa: BLE001 - reported, not fatal
            self.channel.error("Restarting the kernel", exc)
            self.channel.send("kernel.restart_failed", message=str(exc))
            return
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
        if self._warm_timer is not None:
            self._warm_timer.cancel()
        if self.console is not None:
            self.console.stop()
        if self.kernel is not None:
            self.kernel.shutdown()
        if self.models is not None:
            self.models.stop()
        self.channel.close()


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

    sidecar = Sidecar(env_root=args.env_root, app_dir=args.app_dir)
    sidecar.channel.bind()

    try:
        # Before the accept loop, while this process is still single-threaded.
        # See Sidecar.load_backend - this ordering is a deadlock fix, not a
        # preference, and the assertion in there enforces it.
        sidecar.load_backend()
        sidecar.channel.accept()

        # Kernel and console only come up once the UI is listening, so their
        # first output - the console banner in particular - is not lost.
        sidecar.channel.wait_for_client()
        sidecar.start()
    except Exception as exc:  # noqa: BLE001
        sidecar.channel.error("Sidecar startup", exc)
        sidecar.stop()
        return 1
    finally:
        faulthandler.cancel_dump_traceback_later()

    try:
        # stdin closing is how the app says "we are going away". It stays the
        # shutdown signal even though messages now travel over the socket,
        # because it cannot be missed if the webview dies abruptly.
        for _ in sys.stdin:
            pass
    finally:
        log("stdin closed, shutting down")
        sidecar.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
