"""Drive the real sidecar the way the webview does, and check what a user can do.

Every assertion here is about an effect something *outside* this process
produced. Run is checked by a file the executed code writes, not by a log line
saying it was sent; show() by a model frame arriving at the socket the viewer
reads; the variable explorer by the variable itself coming back. That
distinction is the whole point of the file.

It exists because three days of Windows bugs were all found by throwaway
harnesses in a scratch directory, and two regressions were introduced by commits
whose own reasoning was sound - a name referenced before it was assigned, and a
refresh that turned out to be load-bearing. Neither showed up in anything that
was committed. The unit tests are eight assertions about shell quoting.

Deliberately happy paths only. Restart under load, malformed frames, lane
ordering and race widening belong with the rest of the threading work; this is
the floor, not the ceiling.

Run it with `yarn test:integration`, which resolves the environment and hands it
here - the same split the application uses, where the frontend owns path policy
and passes --env-root to the sidecar.
"""

import argparse
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

import psutil
from websockets.sync.client import connect

# Binary frame kinds, matching sidecar/channel.py and src/ipc.js.
KIND_CONSOLE = 1
KIND_MODEL = 2

# The kernel is a fresh interpreter importing OCP, and on a cold machine with a
# virus scanner that has taken over a minute. These are the "something is wrong"
# bounds, not expectations.
READY_TIMEOUT = 180
ACTION_TIMEOUT = 120

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'   ' + detail if detail != '' else ''}",
          flush=True)
    return ok


class Sidecar:
    """The webview's half of the link, with the frames it received kept."""

    def __init__(self, python, env_root, app_dir):
        self.python = python
        self.env_root = env_root
        self.app_dir = app_dir
        self.proc = None
        self.ws = None
        self.frames = []
        self.binary = []
        self.log = []
        self.started = None
        # Set to stop reading the socket, which is how M3's precondition is
        # arranged: with nobody draining it, a large model frame blocks in
        # connection.send holding _send_lock, and the iopub pump blocks behind
        # it - for longer than a restart used to wait before giving up on it.
        self.paused = threading.Event()

    def start(self):
        self.started = time.monotonic()
        self.proc = subprocess.Popen(
            [self.python, os.path.join(self.app_dir, "sidecar", "main.py"),
             "--env-root", self.env_root, "--app-dir", self.app_dir],
            cwd=self.app_dir,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        threading.Thread(target=self._pump_log, daemon=True).start()

        # The handshake line, which is all stdout is ever used for.
        line = self.proc.stdout.readline()
        if line == "":
            raise SystemExit("the sidecar exited before announcing a port:\n"
                             + "\n".join(text for _, text in self.log))
        announcement = json.loads(line)
        self.ws = connect(
            f"ws://127.0.0.1:{announcement['port']}/?token={announcement['token']}",
            # No cap, matching the server and the browser. websockets' client
            # defaults to 1 MB, which a real model exceeds immediately - the
            # webview has no such limit, so a test that kept it would fail where
            # the application works.
            max_size=None,
        )
        threading.Thread(target=self._pump_ws, daemon=True).start()

    def _pump_log(self):
        for line in self.proc.stderr:
            text = line.rstrip()
            if text != "":
                self.log.append((time.monotonic() - self.started, text))

    def _pump_ws(self):
        try:
            for message in self.ws:
                while self.paused.is_set():
                    time.sleep(0.05)
                at = time.monotonic() - self.started
                if isinstance(message, bytes):
                    self.binary.append((at, struct.unpack_from(">B", message)[0]))
                else:
                    self.frames.append((at, json.loads(message)))
        except Exception:  # noqa: BLE001 - the socket closing is how this ends
            pass

    def send(self, message_type, **payload):
        self.ws.send(json.dumps({"type": message_type, **payload}))

    def wait_frame(self, message_type, timeout, since=0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for at, frame in self.frames[since:]:
                if frame["type"] == message_type:
                    return at, frame
            time.sleep(0.02)
        return None, None

    def wait_binary(self, kind, timeout, since=0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for at, seen in self.binary[since:]:
                if seen == kind:
                    return at
            time.sleep(0.02)
        return None

    def wait_log(self, needle, timeout, count=1):
        deadline = time.monotonic() + timeout
        while True:
            found = [(at, text) for at, text in self.log if needle in text]
            if len(found) >= count:
                return found[count - 1]
            if time.monotonic() >= deadline:
                return None, None
            time.sleep(0.05)

    def wait_file(self, path, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if os.path.exists(path):
                return True
            time.sleep(0.05)
        return False

    def stop(self):
        try:
            self.proc.kill()
        except OSError:
            pass


def kernel_process(sidecar_pid):
    """The ipykernel child of the sidecar, or None.

    Found by walking the process tree rather than asked for, because nothing in
    the protocol exposes it - which is the same reason the sidecar could not
    tell the kernel had died until it started asking its kernel manager.
    """
    try:
        parent = psutil.Process(sidecar_pid)
    except psutil.Error:
        return None
    for child in parent.children(recursive=True):
        try:
            if any("ipykernel" in argument for argument in child.cmdline()):
                return child
        except psutil.Error:
            continue
    return None


def main():
    parser = argparse.ArgumentParser("build123d Studio integration test")
    parser.add_argument("--env-root", required=True)
    parser.add_argument("--app-dir", required=True)
    args = parser.parse_args()

    scratch = tempfile.mkdtemp(prefix="build123d-studio-test-")
    marker = os.path.join(scratch, "the-kernel-ran-this")

    side = Sidecar(sys.executable, args.env_root, args.app_dir)
    side.start()

    # --- startup ---

    at_ready, ready_frame = side.wait_frame("ready", READY_TIMEOUT)
    if not check("the sidecar reaches ready", at_ready is not None,
                 f"{at_ready:.2f}s" if at_ready is not None else "timed out"):
        # Nothing below can mean anything without it, and the log is what says
        # why - it is the artefact every Windows bug was eventually solved from.
        for at, text in side.log:
            print(f"      {at:6.2f}s {text}")
        side.stop()
        return 1

    at_console = side.wait_binary(KIND_CONSOLE, 30)
    check("the console produces output", at_console is not None,
          f"first frame at {at_console:.2f}s" if at_console is not None else "silent")

    # Absent from every Windows log for as long as the deadlock lasted, and that
    # absence was the tell. A missing line is evidence.
    at_backend, _ = side.wait_log("Measurement backend loaded", 60)
    check("the measurement backend loads", at_backend is not None,
          f"at {at_backend:.2f}s" if at_backend is not None else "never - see the Windows deadlock")

    # The native import has to finish before anything can connect, because a
    # connection starts a thread and on Windows that deadlocks against the
    # loader lock the import holds. Checked as an ordering in the sidecar's own
    # log rather than as an assertion about threads, because the ordering is the
    # property and it is the thing a future rearrangement would break.
    at_connected, _ = side.wait_log("Webview connected", 30)
    check("the backend is imported before the first connection is accepted",
          at_backend is not None and at_connected is not None and at_backend < at_connected,
          f"import {at_backend:.2f}s, first connection {at_connected:.2f}s"
          if at_backend is not None and at_connected is not None else "missing")

    # The warm-up must follow the console's kernel_info handshake rather than
    # racing it. Reversed, the import queues ahead of the console on the kernel's
    # serial shell channel and the pane sits empty for the length of it.
    at_started, _ = side.wait_log("Console started", 30)
    at_warm, _ = side.wait_log("Kernel warm-up started", 60)
    check("the warm-up follows the console handshake",
          at_started is not None and at_warm is not None and at_warm > at_started,
          f"console {at_started:.2f}s, warm-up {at_warm:.2f}s"
          if at_started is not None and at_warm is not None else "missing")

    _, warm_done = side.wait_log("Kernel warm-up finished", 120)
    check("the warm-up completes", warm_done is not None,
          warm_done if warm_done is not None else "no completion line")

    # --- a Run reaches the kernel ---

    before = len(side.frames)
    side.send("kernel.execute", code=f"open({marker!r}, 'w').write('ok')\n")
    check("a Run reaches the kernel", side.wait_file(marker, ACTION_TIMEOUT),
          "the kernel wrote the file")

    side.wait_frame("kernel.status", 10, since=before)
    states = [f["state"] for _, f in side.frames[before:] if f["type"] == "kernel.status"]
    check("the Run reports busy and then idle",
          "busy" in states and "idle" in states, str(states))

    # --- the variable explorer ---

    side.send("kernel.execute", code="integration_marker = 12345\n")
    time.sleep(1.0)
    before = len(side.frames)
    side.send("vars.refresh")
    _, variables = side.wait_frame("vars.data", ACTION_TIMEOUT, since=before)
    names = [] if variables is None else [row.get("name") for row in variables["variables"]]
    check("the variable explorer answers", "integration_marker" in names,
          f"{len(names)} variables" if variables is not None else "no vars.data")

    # --- show() delivers a model ---

    before = len(side.binary)
    at_show = time.monotonic()
    side.send("kernel.execute", code=(
        "from build123d import Box\n"
        "from build123d_studio import show\n"
        "show(Box(1, 1, 1))\n"
    ))
    delivered = side.wait_binary(KIND_MODEL, ACTION_TIMEOUT, since=before)
    check("show() delivers a model", delivered is not None,
          f"{time.monotonic() - at_show:.2f}s" if delivered is not None else "no model frame")

    # --- restart ---

    os.remove(marker)
    before = len(side.frames)
    side.send("kernel.restart")
    at_restarted, _ = side.wait_frame("kernel.restarted", ACTION_TIMEOUT, since=before)
    check("the kernel restarts", at_restarted is not None)

    side.send("kernel.execute", code=f"open({marker!r}, 'w').write('ok')\n")
    check("a Run works after a restart", side.wait_file(marker, ACTION_TIMEOUT))

    # The replacement kernel's namespace is empty, so it needs warming again.
    at_second, _ = side.wait_log("Kernel warm-up started", 120, count=2)
    check("the warm-up runs again after a restart", at_second is not None)

    # --- the measurement backend indexes the model that is on screen ---
    #
    # Activating a measure tool is what triggers indexing, and indexing is the
    # slow step a show() used to be able to land inside: load() set three fields
    # one after another while _ensure_loaded read the same three, so a model
    # arriving mid-index left the object claiming to be loaded with no backend,
    # or answering from geometry that had already been replaced. A shown model
    # is one immutable object now, swapped whole.
    #
    # Asserted through the log line the indexing itself emits, because a
    # selection response needs shape ids that only the viewer has.
    side.send("viewer.changes", changes={"activeTool": "Properties"})
    indexed = side.wait_log("Measurement model indexed", 60)[0] is not None
    check("activating a measure tool indexes the shown model", indexed)

    # A second model must be indexed in its own right rather than answered from
    # the first one's index.
    before = len(side.binary)
    # Imported again rather than relying on the namespace: the kernel has been
    # restarted since the earlier show(), so Box and show are gone. The shown
    # model survived that restart, because it belongs to the sidecar rather than
    # to the kernel - which is why the check above still had something to index.
    side.send("kernel.execute", code=(
        "from build123d import Box\n"
        "from build123d_studio import show\n"
        "show(Box(3, 3, 3))\n"
    ))
    side.wait_binary(KIND_MODEL, ACTION_TIMEOUT, since=before)
    side.send("viewer.changes", changes={"activeTool": "Properties"})
    reindexed = side.wait_log("Measurement model indexed", 60, count=2)[0] is not None
    check("a newly shown model is indexed again", reindexed)

    # --- the model socket, from a peer that is not the kernel ---
    #
    # Reachable by any process on this machine, which is the premise the token
    # exists for, so the two ways of abusing it are worth asserting rather than
    # arguing about.
    model_port = ready_frame["model_port"]

    # A token that is not valid ASCII. It used to be decoded with "replace",
    # which turns a stray byte into U+FFFD, and compare_digest refuses to
    # compare non-ASCII str at all - so a bad token raised TypeError and was
    # reported as "Failed to read a model", blaming the kernel for a stranger.
    before = len(side.log)
    with socket.create_connection(("127.0.0.1", model_port), timeout=10) as peer:
        token = b"\xff\xfe" + b"x" * 41
        body = struct.pack(">H", len(token)) + token
        peer.sendall(struct.pack(">Q", len(body)) + body)
        peer.recv(1)
    rejected = side.wait_log("Rejected a model message with a bad token", 15)[0] is not None
    blamed = [text for _, text in side.log[before:] if "Failed to read a model" in text]
    check("a non-ASCII token is rejected as a bad token", rejected and len(blamed) == 0,
          "; ".join(blamed[:1]))

    # And a peer that connects, says almost nothing, and holds on. accept() is
    # serial, so for as long as this one is tolerated nothing else can deliver a
    # model - which is the whole viewer, stopped by an unauthenticated process.
    stall = socket.create_connection(("127.0.0.1", model_port), timeout=30)
    stall.sendall(b"\x00\x00")
    before = len(side.binary)
    started = time.monotonic()
    side.send("kernel.execute", code=(
        "from build123d import Box\n"
        "from build123d_studio import show\n"
        "show(Box(2, 2, 2))\n"
    ))
    delivered = side.wait_binary(KIND_MODEL, 60, since=before)
    stall.close()
    # Fifteen seconds discriminates, which is the point of choosing it. An
    # unauthenticated peer now holds the loop for HANDSHAKE_TIMEOUT, five
    # seconds; before, it held it for the per-recv SOCKET_TIMEOUT of thirty, and
    # a peer that dribbled a byte every twenty-nine seconds held it for as long
    # as it cared to. The dribbler is the real case and takes minutes to
    # demonstrate, so this asserts the bound that covers it.
    held = time.monotonic() - started
    check("a stalled stranger cannot hold the model socket",
          delivered is not None and held < 15,
          f"model arrived after {held:.1f}s" if delivered is not None else "no model at all")

    # --- restarting under load ---
    #
    # R4's acceptance, and the one case here that cannot be done by hand:
    # restart repeatedly while a model is in flight and keystrokes are arriving.
    # This is the pattern that has already cost days - two threads on one zmq
    # socket, reported as "Invalid Signature: b'<IDS|MSG>'" because the kernel
    # read one message's frames as another's - and it only appears when a
    # restart lands on top of traffic rather than on an idle session.
    typing = threading.Event()

    def keep_typing():
        while not typing.is_set():
            # Straight to the pty, the hottest path in the application and the
            # one whose file descriptor a restart closes underneath it.
            side.ws.send(struct.pack(">BxxxI", KIND_CONSOLE, 0) + b"# typing\r")
            time.sleep(0.01)

    typist = threading.Thread(target=keep_typing, daemon=True)
    typist.start()

    rounds = 0
    for _ in range(3):
        # Big enough to fill the socket buffers, because that is the whole
        # point: with the reader paused below, the model frame blocks in
        # connection.send holding _send_lock, the iopub pump blocks behind it
        # trying to forward a status, and the restart then finds a pump that
        # will not stop. A single small box never blocks, the pump exits inside
        # the join, and the race this is here for never opens - which is what
        # the first version of this test failed to notice, passing identically
        # against the code it was meant to catch.
        side.send("kernel.execute", code=(
            "from build123d import Box\n"
            "from build123d_studio import show\n"
            "show(*[Box(1, 1, 1).translate((i * 2, 0, 0)) for i in range(150)])\n"
        ))
        side.paused.set()
        # Deliberately not waiting for the model: the restart is supposed to
        # land while the delivery is still happening.
        time.sleep(2.0)
        mark = len(side.frames)
        side.send("kernel.restart")
        time.sleep(1.0)
        side.paused.clear()
        if side.wait_frame("kernel.restarted", ACTION_TIMEOUT, since=mark)[0] is not None:
            rounds += 1

    typing.set()
    typist.join(timeout=5)
    check("restarts survive a model in flight and typing", rounds == 3, f"{rounds}/3 rounds")

    # The kernel has to be usable afterwards, which is the part a corrupted
    # shell socket fails: the frames interleave, the kernel rejects the message,
    # and Run silently stops working.
    os.remove(marker)
    side.send("kernel.execute", code=f"open({marker!r}, 'w').write('ok')\n")
    check("the kernel still runs code after that", side.wait_file(marker, ACTION_TIMEOUT))

    corrupt = [text for _, text in side.log if "Invalid Signature" in text or "DELIM" in text]
    check("no corrupted messages on the shell socket", len(corrupt) == 0,
          "; ".join(corrupt[:2]))

    # --- the kernel process dying is noticed ---
    #
    # Killed rather than asked to stop, because the case is an out-of-memory
    # tessellation, and a dead ZMQ peer produces no exception at all: before
    # this was watched for, execute() went on succeeding into a socket with
    # nobody behind it and the toolbar kept reading "busy" for the rest of the
    # session.
    kernel = kernel_process(side.proc.pid)
    if kernel is None:
        check("the kernel process can be found", False, "no ipykernel child")
    else:
        before = len(side.frames)
        # Both in the sidecar's own time base, because that is what wait_frame
        # reports; subtracting one from the other is the detection latency, and
        # printing the raw timestamp as though it were the delay is a mistake
        # this line made once already.
        killed_at = time.monotonic() - side.started
        kernel.kill()
        at_died, _ = side.wait_frame("kernel.died", 60, since=before)
        check("a dead kernel is reported", at_died is not None,
              f"{at_died - killed_at:.2f}s after the kill"
              if at_died is not None else "never reported")

        # And the offered way back has to work, or the banner is decoration.
        os.remove(marker)
        before = len(side.frames)
        side.send("kernel.restart")
        at_back, _ = side.wait_frame("kernel.restarted", ACTION_TIMEOUT, since=before)
        check("the kernel restarts after dying", at_back is not None)
        side.send("kernel.execute", code=f"open({marker!r}, 'w').write('ok')\n")
        check("a Run works after the kernel died and was restarted",
              side.wait_file(marker, ACTION_TIMEOUT))

    # Anything the sidecar itself called a failure. The NameError that stopped
    # the variable explorer was reported exactly this way and read by nobody.
    # Two of these the test causes on purpose, by stalling the model socket and
    # by presenting a bad token, and both are the sidecar correctly saying so.
    # Listed rather than filtered by wording, so that a genuine failure with
    # similar words is not quietly swallowed with them.
    provoked = ("Failed to read a model: timed out",
                "Failed to read a model: Gave up with")
    complaints = [text for _, text in side.log
                  if ("failed" in text or "timed out" in text or "Traceback" in text)
                  and not text.startswith(provoked)]
    check("the sidecar reported no unexpected failures", len(complaints) == 0,
          "; ".join(complaints[:3]))

    side.stop()

    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed", flush=True)
    if len(failed) > 0:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
