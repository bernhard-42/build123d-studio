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

This file was once happy paths only and said so; it is not any more. Restart
under load, a stranger holding the model socket, a bad token and the kernel
process dying all landed here during Phase 2, and the note claiming otherwise
outlived them by a release.

What it still cannot do is see inside. Everything here is asserted through the
socket, the way the webview sees it, so it can say a restart survived but not
which generation a retired pump was holding, and it can say a keystroke arrived
but not whether the descriptor it went to was still the pty's. Those live in
tests/sidecar, which drives the classes directly and widens the races on
purpose - `yarn test:sidecar`. The two are complements, not a floor and a
ceiling: this one is the only thing that runs the real kernel, the real console
and the real environment.

Run it with `yarn test:integration`, which resolves the environment and hands it
here - the same split the application uses, where the frontend owns path policy
and passes --env-root to the sidecar.

Quit the application before running this. The harness deliberately uses the real
environment root, because an environment built for a test is a different
environment from the one that breaks.

That used to be worse than an inconvenience: the environment root held a single
`kernel.json`, so a kernel started here fought one started by a running app -
observed as a run that failed once and passed immediately afterwards, with two
instances open at the time. Phase 4 group 4 removed it. The sidecar this harness
spawns claims an instance directory of its own and writes its connection file
inside it, exactly as the application's does, so the two no longer collide.

Quitting first is still the rule, for the reasons that remain: both would drive
the same environment, and a `uv sync` from one while the other is starting is not
something this file should have to reason about.
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

# How long the cell that holds the kernel busy runs for. Long enough that an
# inspection queued behind it would be unmistakable - before subshells the same
# read took 9.57 s against a cell of this length - and short enough not to
# dominate the suite.
BUSY_SECONDS = 10

# What "answered while the kernel is busy" is allowed to cost. The measurement
# is 0.01 s; this is loose by two orders of magnitude on purpose, because the
# thing being separated is milliseconds from the whole length of a cell, and a
# bound that reads as a performance target would fail on a loaded CI machine for
# a reason that has nothing to do with the defect.
BUSY_ANSWER_SECONDS = 3.0

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

    def run_and_settle(self, code, timeout=ACTION_TIMEOUT):
        """Run a cell, and wait for the kernel to finish it.

        A sleep used to do, and the reason it did is exactly what group 6
        removed. The kernel served one shell serially, so an inspection sent
        after a Run queued behind it and could not see a half-finished namespace
        however early it was sent - the sleep was covering the frame's flight
        time, not the cell's. Inspections go to a subshell now and overtake the
        cell, so anything that wants the namespace *after* a cell has to say so
        rather than assume it.

        Found by this suite rather than reasoned about: the eleven-hundred-name
        listing came back with 0 rows, because the refresh answered while the
        cell that was creating them had barely started.
        """
        since = len(self.frames)
        self.send("kernel.execute", code=code)
        at, _ = self.wait_frame_where(
            "kernel.status", lambda frame: frame["state"] == "idle", timeout, since=since
        )
        return at

    def wait_frame(self, message_type, timeout, since=0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for at, frame in self.frames[since:]:
                if frame["type"] == message_type:
                    return at, frame
            time.sleep(0.02)
        return None, None

    def wait_frame_where(self, message_type, predicate, timeout, since=0):
        """The first frame of a type that also satisfies ``predicate``.

        Diagnostics are pushed, one frame per document, and several documents
        are open by the time these run - so "the next diagnostics frame" is not
        the same question as "the diagnostics for this buffer".
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for at, frame in self.frames[since:]:
                if frame["type"] == message_type and predicate(frame):
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


def child_process(sidecar_pid, needle):
    """A live child of the sidecar whose command line mentions ``needle``.

    How "the file runs in a process of its own" is asserted as a fact about the
    machine rather than as a frame the sidecar sent about itself - the same
    reason a Run is checked by the file the code wrote. Zombies are skipped:
    a killed process stays in the table until the exit watcher reaps it, and
    "still listed" is not "still running".
    """
    try:
        parent = psutil.Process(sidecar_pid)
    except psutil.Error:
        return None
    for child in parent.children(recursive=True):
        try:
            if child.status() == psutil.STATUS_ZOMBIE:
                continue
            if any(needle in argument for argument in child.cmdline()):
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
    at_backend, _ = side.wait_log("Measurement backend ready", 60)
    check("the measurement backend becomes ready", at_backend is not None,
          f"at {at_backend:.2f}s" if at_backend is not None else "never - see the Windows deadlock")

    # And it does so *after* the application is usable, which is the whole point
    # of it having a process of its own. It used to be the other way round by
    # construction: the import ran between binding and accepting, so nothing
    # could connect until it finished - 3.33 s of a 6.52 s startup on a
    # ten-year-old Windows machine. This is that ordering inverted, and it is
    # the property a future rearrangement would break.
    at_ready, _ = side.wait_log("Sidecar ready", 60)
    if at_ready is None:
        at_ready, _ = side.wait_log("Kernel started", 60)
    check("startup does not wait for the measurement backend",
          at_backend is not None and at_ready is not None and at_ready < at_backend,
          f"usable at {at_ready:.2f}s, backend ready at {at_backend:.2f}s"
          if at_backend is not None and at_ready is not None else "missing")

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

    # --- what startup announces ---

    _, idle = side.wait_frame("kernel.status", ACTION_TIMEOUT)
    check("the kernel reports itself idle once it is up",
          idle is not None and idle["state"] == "idle",
          "never said" if idle is None else idle["state"])

    _, console_ready = side.wait_frame("console.ready", ACTION_TIMEOUT)
    check("the console says when its handshake is done", console_ready is not None,
          "never said")

    # --- the indicator says nothing before anything has run ---
    #
    # Startup is where this shows: the console asks the kernel for kernel_info
    # and then for history, and every shell request publishes busy and idle
    # whether or not it executes anything. Both used to reach the toolbar, so
    # the indicator flickered twice before the user had done a thing - one to
    # four milliseconds each, which reads as a glitch rather than as state.
    flickers = [f for _, f in side.frames
                if f["type"] == "kernel.status" and f["state"] == "busy"]
    check("nothing reports the kernel busy before the first Run",
          len(flickers) == 0, f"{len(flickers)} busy frames")

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

    side.run_and_settle("integration_marker = 12345\n")
    before = len(side.frames)
    side.send("vars.refresh")
    _, variables = side.wait_frame("vars.data", ACTION_TIMEOUT, since=before)
    names = [] if variables is None else [row.get("name") for row in variables["variables"]]
    check("the variable explorer answers", "integration_marker" in names,
          f"{len(names)} variables" if variables is not None else "no vars.data")

    # --- code completion ---
    #
    # Two sources, and the two halves are checked separately because each covers
    # what the other cannot.

    # The live half: "integration_marker" exists because the cell above ran it,
    # and no reading of a file could know that.
    before = len(side.frames)
    side.send("editor.complete", id="complete-1", source="integration_mar",
              line=1, column=15, path=None, key="buffer-live")
    _, reply = side.wait_frame("editor.complete", ACTION_TIMEOUT, since=before)
    matches = [] if reply is None else reply.get("matches", [])
    check("completion answers from the live namespace",
          "integration_marker" in matches,
          f"{len(matches)} matches" if reply is not None else "no reply")
    check("the completion reply carries its request id",
          reply is not None and reply.get("id") == "complete-1",
          "no reply" if reply is None else str(reply.get("id")))
    # The span the match replaces, which is what decides whether accepting it
    # writes "integration_marker" or "integration_marintegration_marker".
    entry = None if reply is None else next(
        (e for e in reply.get("types") or [] if e.get("text") == "integration_marker"), None)
    check("the completion says which text it replaces",
          entry is not None and entry.get("start") == 0 and entry.get("end") == 15,
          "no entry" if entry is None else f"{entry.get('start')}..{entry.get('end')}")

    # The property the internal-request record exists for, asked of a real
    # kernel: a complete_request publishes busy and idle on iopub exactly as a
    # Run does, so without the record the toolbar would flicker on every
    # keystroke that opened the suggestion list.
    statuses = [f for _, f in side.frames[before:] if f["type"] == "kernel.status"]
    check("a completion does not report the kernel busy",
          len(statuses) == 0, f"{len(statuses)} status frames")

    # The static half, and the case that made it necessary: nothing has bound
    # Box in this kernel - the warm-up imports build123d into sys.modules
    # without binding names - so every match here is read from the buffer.
    unrun = "from build123d import *\nb = Bo"
    before = len(side.frames)
    side.send("editor.complete", id="complete-2", source=unrun, line=2, column=6,
              path=None, key="buffer-unrun")
    _, reply = side.wait_frame("editor.complete", ACTION_TIMEOUT, since=before)
    matches = [] if reply is None else reply.get("matches", [])
    check("completion reads a file that has never been run",
          "Box" in matches, f"{len(matches)} matches: {matches[:4]}")

    # The builder pattern, which is why the static half is a language server and
    # not jedi: `part` is reached through `Self` on Builder.__enter__.
    builder = "from build123d import *\nwith BuildPart() as bd:\n    Box(1, 2, 34)\nbd.pa"
    before = len(side.frames)
    side.send("editor.complete", id="complete-3", source=builder, line=4, column=5,
              path=None, key="buffer-builder")
    _, reply = side.wait_frame("editor.complete", ACTION_TIMEOUT, since=before)
    matches = [] if reply is None else reply.get("matches", [])
    check("the builder's part is offered on an unrun file",
          "part" in matches, f"{len(matches)} matches: {matches[:4]}")

    # And what accepting it writes, which is the number that silently corrupts a
    # buffer when it is wrong: the span must cover "pa" and not "d.pa".
    entry = None if reply is None else next(
        (e for e in reply.get("types") or [] if e.get("text") == "part"), None)
    line_text = builder.split("\n")[3]
    check("accepting it writes bd.part",
          entry is not None
          and line_text[:entry["start"]] + "part" + line_text[entry["end"]:] == "bd.part",
          "not offered" if entry is None
          else line_text[:entry["start"]] + "part" + line_text[entry["end"]:])

    # --- signatures ---

    before = len(side.frames)
    side.send("editor.signature", id="sig-1", line=2, column=16, path=None, key="buffer-sig",
              source="from build123d import *\nc = Box(10, 10, ")
    _, reply = side.wait_frame("editor.signature", ACTION_TIMEOUT, since=before)
    signature = None if reply is None else reply.get("signature")
    # The label is the parameter list, without the callable's name - which is
    # what the server sends, and it reads correctly because the popup opens
    # against the bracket that was just typed, with the name immediately left of
    # it.
    check("the signature of the call being typed is answered",
          signature is not None
          and signature["signatures"][0]["parameters"][:3]
          == ["length: float", "width: float", "height: float"],
          "no signature" if signature is None else str(signature["signatures"][0]["parameters"][:3]))
    check("the argument being typed is reported",
          signature is not None and signature.get("activeParameter") == 2,
          "no signature" if signature is None else str(signature.get("activeParameter")))

    # --- hover ---

    before = len(side.frames)
    side.send("editor.hover", id="hover-1", source=builder, line=2, column=20,
              path=None, key="buffer-builder")
    _, reply = side.wait_frame("editor.hover", ACTION_TIMEOUT, since=before)
    hover = None if reply is None else reply.get("hover")
    check("hover says what a name holds",
          hover is not None and "BuildPart" in hover.get("value", ""),
          "nothing" if hover is None else hover.get("value", "")[:60])

    # --- diagnostics ---
    #
    # Pushed rather than asked for, so this sends a buffer and waits. The file
    # has one real mistake in it and several things that are perfectly good
    # build123d and were reported as problems until the analysis was configured:
    # the wildcard import, a Box called for its effect inside a builder, and the
    # kernel-side package that only exists on the kernel's PYTHONPATH.
    dirty = (
        "from build123d import *\n"
        "from build123d_studio import show\n"
        "\n"
        "with BuildPart() as bd:\n"
        "    Box(10, 10, 10)\n"
        "\n"
        "show(bd.part)\n"
        "undefined_name + 1\n"
    )
    before = len(side.frames)
    side.send("editor.sync", source=dirty, path=None, key="buffer-diag")
    _, reply = side.wait_frame_where(
        "editor.diagnostics", lambda f: f.get("key") == "buffer-diag", 30, since=before)
    reported = [] if reply is None else reply.get("diagnostics", [])
    rules = sorted(str(d.get("code")) for d in reported)
    check("the real mistake is reported", rules == ["reportUndefinedVariable"],
          "no diagnostics frame" if reply is None else str(rules))
    check("the diagnostics name the buffer they belong to",
          reply is not None and reply.get("key") == "buffer-diag",
          "no frame" if reply is None else str(reply.get("key")))

    before = len(side.frames)
    side.send("editor.sync", source="from build123d import *\nb = Box(1, 2, 3)\n",
              path=None, key="buffer-diag")
    _, reply = side.wait_frame_where(
        "editor.diagnostics", lambda f: f.get("key") == "buffer-diag", 30, since=before)
    # The empty list is the mechanism that takes the previous squiggles away:
    # the server republishes everything it knows each time, and silence would
    # leave the old marks up for ever.
    check("a fixed file publishes an empty list rather than going quiet",
          reply is not None and reply.get("diagnostics") == [],
          "no frame" if reply is None else str(reply.get("diagnostics"))[:60])

    # --- formatting ---
    #
    # ruff, in the sidecar's own process on a lane of its own. The source
    # travels in the request rather than being read from disk, because the
    # buffer is what the user is looking at and is very often unsaved - which is
    # precisely when somebody reaches for a formatter.

    before = len(side.frames)
    side.send("editor.format", id="format-1", source="b  =  Box( 1,2,3 )\n", lineLength=88)
    _, reply = side.wait_frame("editor.format", ACTION_TIMEOUT, since=before)
    check("a buffer comes back formatted",
          reply is not None and reply.get("source") == "b = Box(1, 2, 3)\n",
          "no reply" if reply is None else repr(reply.get("source")))
    check("the format reply carries its request id",
          reply is not None and reply.get("id") == "format-1",
          "no reply" if reply is None else str(reply.get("id")))

    # The same buffer at two line lengths. One length proves nothing here,
    # because ruff's own default is 88: a request whose lineLength was dropped
    # on the way and one that carried it produce identical output at that
    # number, and the check would pass with the field never read.
    wide = "value = some_call(first_argument, second_argument, third_argument)\n"

    before = len(side.frames)
    side.send("editor.format", id="format-2", source=wide, lineLength=88)
    _, reply = side.wait_frame("editor.format", ACTION_TIMEOUT, since=before)
    # None is "nothing to change", and it is what stops a Format on Save from
    # marking every clean buffer dirty.
    check("a buffer that is already formatted is left alone",
          reply is not None and reply.get("source") is None,
          "no reply" if reply is None else repr(reply.get("source"))[:60])

    before = len(side.frames)
    side.send("editor.format", id="format-3", source=wide, lineLength=40)
    _, reply = side.wait_frame("editor.format", ACTION_TIMEOUT, since=before)
    check("the configured line length is what ruff is given",
          reply is not None and reply.get("source") is not None
          and reply["source"].startswith("value = some_call(\n")
          and reply["source"].count("\n") == 5,
          "no reply" if reply is None else repr(reply.get("source"))[:60])

    # A buffer being typed into does not parse, constantly, and Format on Save
    # meets that state more than any other. It answers with nothing to change
    # rather than with a complaint: the squiggle has already said so where the
    # user is looking. Which of the two "nothing to change" means goes to the
    # log, so that is where it is asserted.
    before = len(side.frames)
    side.send("editor.format", id="format-4", source="def broken(\n", lineLength=88)
    _, reply = side.wait_frame("editor.format", ACTION_TIMEOUT, since=before)
    check("a buffer that does not parse is returned untouched",
          reply is not None and reply.get("source") is None,
          "no reply" if reply is None else repr(reply.get("source"))[:60])
    at_why, why = side.wait_log("Format: not formatted, the buffer does not parse", 15)
    check("and the log says which of the two it was", at_why is not None,
          "silent" if why is None else why.split("Format: ")[-1][:60])

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

    # --- the explorer survives a real namespace ---
    #
    # A thousand names is the cliff: user_expressions results go through
    # IPython's pretty printer, which truncates any sequence there with a
    # literal "...", and literal_eval reads that as Ellipsis. json.dumps then
    # refused it inside channel.send, on every idle, for ever - the explorer
    # froze on its last good state and said nothing. `from sympy import *` is
    # enough to reach it.
    side.run_and_settle("\n".join(f"n{i} = {i}" for i in range(1100)) + "\n")
    before = len(side.frames)
    side.send("vars.refresh")
    _, big = side.wait_frame("vars.data", ACTION_TIMEOUT, since=before)
    check("a namespace past a thousand names still refreshes", big is not None,
          f"{len(big['variables'])} rows" if big is not None else "no vars.data at all")

    if big is not None:
        # And it says what it left out rather than stopping silently, which is
        # indistinguishable from having lost the rest.
        names = [r["name"] for r in big["variables"]]
        check("a truncated listing says how much it hid",
              any("more" in n for n in names), names[-1] if len(names) > 0 else "")

    # An expansion has to answer, always. A row that asks for detail and is told
    # nothing shows "loading" until the application is restarted - which is what
    # a suspension assembly did, through a bounding_box() costing 19 s against a
    # 15 s budget.
    before = len(side.frames)
    side.send("vars.detail", path=["n1"], offset=0)
    _, detail = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    check("expanding a row is answered", detail is not None)

    # Including one that cannot be read at all, which is the case that used to
    # be silent.
    before = len(side.frames)
    side.send("vars.detail", path=["does_not_exist"], offset=0)
    _, missing = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    check("expanding a name that is gone is answered too",
          missing is not None and "error" in missing["detail"],
          str(missing["detail"]) if missing is not None else "silence")

    # --- the explorer goes as deep as the data does ---
    #
    # The plan's example, through the real kernel: a dict of a dict of a dict.
    # Addressed by ordinal, so ["nested", 3, 0] is the first entry of the fourth.
    side.run_and_settle(
        "nested = dict(a=12, b='wert', c=[1,2,3,4,5,6], "
        "d=dict(x=dict(aa=1, bb='sdfg'), y=2))\n"
        "points = list(range(5043))\n"
    )

    before = len(side.frames)
    side.send("vars.detail", path=["nested", 3, 0], offset=0)
    _, deep = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    names = [] if deep is None else [c["name"] for c in deep["detail"].get("children", [])]
    check("a dict inside a dict inside a dict can be opened",
          names == ["aa", "bb"], str(names) if deep is not None else "silence")

    # --- and pages what will not fit ---

    before = len(side.frames)
    side.send("vars.detail", path=["points"], offset=0)
    _, first = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    page = {} if first is None else first["detail"]
    check("a long list arrives one page at a time",
          page.get("total") == 5043 and len(page.get("children", [])) == page.get("page"),
          f"{len(page.get('children', []))} of {page.get('total')}")

    before = len(side.frames)
    side.send("vars.detail", path=["points"], offset=5000)
    _, last = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    tail = {} if last is None else last["detail"]
    # The names are absolute positions, so a child's row and the row it opens
    # describe the same element. Numbered within the page instead, every page
    # after the first would open the wrong one.
    # A shape is Iterable and Sized, so it unrolls - and it still has the counts
    # this pane has always shown for one. Choosing between them would mean that
    # making shapes iterable quietly took the faces away.
    side.run_and_settle(
        "from build123d import BuildPart, Box\n"
        "with BuildPart() as _bd:\n"
        "    Box(10, 10, 10)\n"
        "solid = _bd.part\n"
    )
    before = len(side.frames)
    side.send("vars.detail", path=["solid"], offset=0)
    _, shape = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    opened = {} if shape is None else shape["detail"]
    check("a shape gives both its counts and its contents",
          opened.get("attributes", {}).get("topology") == "6 faces, 12 edges, 8 vertices"
          and len(opened.get("children", [])) == 1,
          f"{opened.get('attributes')}, {len(opened.get('children', []))} children")

    # The label, which is the only thing that tells one child from another: the
    # rows under a container are called 0, 1, 2. Asked through a path rather
    # than off the listing, because by now the namespace holds the eleven
    # hundred names the truncation check above made and anything sorting late is
    # past the five-hundred-row cut.
    side.run_and_settle(
        "solid.label = 'housing'\n"
        "_assembly = [solid]\n"
    )
    before = len(side.frames)
    side.send("vars.detail", path=["_assembly"], offset=0)
    _, labelled = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    children = [] if labelled is None else labelled["detail"].get("children", [])
    check("a labelled shape shows its label",
          len(children) == 1 and children[0].get("label") == "housing",
          "no children" if len(children) == 0 else str(children[0].get("label")))

    check("a later page is numbered from where it starts",
          tail.get("offset") == 5000
          and [c["name"] for c in tail.get("children", [])][:1] == ["5000"]
          and len(tail.get("children", [])) == 43,
          f"offset {tail.get('offset')}, {len(tail.get('children', []))} children")

    # --- inspecting while the kernel is busy ---
    #
    # The kernel serves one shell serially, so an inspection sent during a cell
    # used to wait in the kernel's own queue: 9.57 s against a ten second cell,
    # measured on the pinned ipykernel, and past the fifteen second budget the
    # row said "could not be read in time" - which was untrue, because the value
    # was readable and the kernel was busy. A subshell answers from a thread of
    # its own over the same namespace.
    #
    # This is the check that fails against the code before group 6, and it is
    # asserted as a *duration* rather than as a subshell id, because how it is
    # arranged is not the promise. The promise is that the pane answers while
    # code runs.

    _, subshell_line = side.wait_log("Kernel subshell", 5)
    check("the kernel has a subshell", subshell_line is not None,
          subshell_line if subshell_line is not None else "no subshell line in the log")

    side.send("kernel.execute", code=(
        "busy_marker = list(range(20))\n"
        "import time as _t\n"
        f"for _i in range({BUSY_SECONDS}):\n"
        "    _t.sleep(1)\n"
    ))

    # Far enough in that the cell is unambiguously running, and long enough
    # before the end that a reply arriving after it would be obvious.
    time.sleep(2.0)

    # Both reads happen after this mark, so the indicator check below covers
    # the pair of them rather than only the later one.
    quiet_from = len(side.frames)

    before = len(side.frames)
    started = time.monotonic()
    side.send("vars.detail", path=["busy_marker"], offset=0)
    _, busy_detail = side.wait_frame("vars.detail", ACTION_TIMEOUT, since=before)
    inspect_seconds = time.monotonic() - started
    children = [] if busy_detail is None else busy_detail["detail"].get("children", [])
    check("a row expands while a cell is running",
          busy_detail is not None and len(children) == 20
          and inspect_seconds < BUSY_ANSWER_SECONDS,
          f"{inspect_seconds:.2f}s, {len(children)} children"
          if busy_detail is not None else "no answer at all")

    # The other pane the same defect showed in. Completion's kernel half was
    # skipped outright while the kernel was busy, so a long tessellation took
    # the live namespace out of every suggestion list - and the live half is
    # most of the value on the objects this application is about.
    before = len(side.frames)
    started = time.monotonic()
    side.send("editor.complete", id="complete-busy", source="busy_mar",
              line=1, column=8, path=None, key="buffer-busy")
    _, busy_reply = side.wait_frame("editor.complete", ACTION_TIMEOUT, since=before)
    complete_seconds = time.monotonic() - started
    matches = [] if busy_reply is None else busy_reply.get("matches", [])
    check("completion answers from the live namespace while a cell is running",
          "busy_marker" in matches and complete_seconds < BUSY_ANSWER_SECONDS,
          f"{complete_seconds:.2f}s, {len(matches)} matches"
          if busy_reply is not None else "no reply")

    # And the kernel is still busy, which is what makes the two above mean
    # anything: an answer that arrived because the cell had finished early would
    # prove nothing at all.
    statuses = [f for _, f in side.frames if f["type"] == "kernel.status"]
    check("the kernel was still busy while both were answered",
          len(statuses) > 0 and statuses[-1]["state"] == "busy",
          "no status frames" if len(statuses) == 0 else statuses[-1]["state"])

    # Neither of them may look like user activity. Both go out as internal
    # requests, and the kernel publishes busy and idle for each exactly as it
    # does for a Run - so without the record the toolbar would flicker mid-cell
    # and the explorer would treat its own reads as a reason to read again.
    during = [f for _, f in side.frames[quiet_from:] if f["type"] == "kernel.status"]
    check("neither of them moves the indicator",
          len(during) == 0, f"{len(during)} status frames during the reads")

    # The cell's own output has to be untouched by any of it. ipykernel keeps
    # the shell parent header in a ContextVar, so a subshell's request should
    # not steal it - if it did, a print() from the running cell would be
    # attributed to a silent inspection and vanish from the console.
    _, done = side.wait_frame_where(
        "kernel.status", lambda f: f["state"] == "idle", BUSY_SECONDS + 10, since=before)
    check("the cell finishes and reports itself idle", done is not None,
          "still busy" if done is None else done["state"])

    # --- Run File: the same second world, with no debugger in it ---
    #
    # Run All sends the buffer's text to the kernel and leaves its names in the
    # namespace the console shares. This runs the *file*, in a process that is
    # gone when it ends, and the two were one word until they were separated.
    # What is asserted here is what the runner owns rather than what it borrows
    # from the debug relay: that the process starts, that its output arrives,
    # that it exits with a code, and that the kernel beside it is untouched.

    # The working directory a run inherits is the kernel's, which the frontend
    # sets from the open folder. Pointed at the scratch directory so that a
    # relative path in the script has somewhere of its own to land - which is
    # the promise `export_step(part, "bracket.step")` makes.
    side.send("kernel.cwd", path=scratch)

    run_script = os.path.join(scratch, "run-check.py")
    with open(run_script, "w") as handle:
        handle.write(
            "from build123d import Box\n"
            "from build123d_studio import show\n"
            "\n"
            # Relative on purpose: absolute would prove the process ran and say
            # nothing about where it thinks it is.
            "open('run-wrote-this', 'w').write('ok')\n"
            "run_only_name = 1\n"
            "show(Box(1, 1, 1))\n"
            "print('the run printed this')\n"
        )

    before = len(side.frames)
    at_models = len(side.binary)
    side.send("run.start", path=run_script)
    _, run_started = side.wait_frame("run.started", ACTION_TIMEOUT, since=before)
    check("a file runs in a process of its own", run_started is not None,
          "no run.started" if run_started is None else os.path.basename(run_started["path"]))

    _, printed = side.wait_frame_where(
        "run.output", lambda f: "the run printed this" in f.get("text", ""),
        ACTION_TIMEOUT, since=before)
    # Piped rather than assumed: a print() is not a DAP event, measured, which
    # is why the relay carries stdout at all.
    check("what the file printed is relayed", printed is not None,
          "nothing" if printed is None else printed["text"].strip())

    # The whole reason the run is given the kernel's environment rather than a
    # bare interpreter: it gets the model socket's port and token, so a show()
    # in the file reaches the viewer already on screen.
    at_model = side.wait_binary(KIND_MODEL, ACTION_TIMEOUT, since=at_models)
    check("a show() from the run reaches the viewer", at_model is not None,
          "no model frame" if at_model is None else f"at {at_model:.2f}s")

    check("a relative path resolves in the kernel's working directory",
          side.wait_file(os.path.join(scratch, "run-wrote-this"), ACTION_TIMEOUT))

    _, run_exited = side.wait_frame("run.exited", ACTION_TIMEOUT, since=before)
    check("the run reports the process exiting",
          run_exited is not None and run_exited.get("code") == 0,
          "silent" if run_exited is None else f"code {run_exited.get('code')}")

    # Two worlds, asserted of the runner rather than of the debugger: nothing
    # the file defined is in the namespace the console shares.
    before = len(side.frames)
    side.send("vars.detail", path=["run_only_name"], offset=0)
    _, leaked = side.wait_frame_where(
        "vars.detail", lambda f: f["detail"].get("path") == ["run_only_name"],
        ACTION_TIMEOUT, since=before)
    check("nothing the run defined reached the kernel",
          leaked is not None and "error" in leaked["detail"],
          "no reply" if leaked is None else str(leaked["detail"])[:60])

    # A script that raises. Both halves matter: a non-zero code is an ordinary
    # outcome of running a file, and the traceback that explains it comes back
    # on the same stream as the prints that led to it - one pipe, because two
    # would arrive in whatever order the reader threads were scheduled in.
    raising = os.path.join(scratch, "run-raises.py")
    with open(raising, "w") as handle:
        handle.write("print('before the mistake')\nraise ValueError('deliberate')\n")

    before = len(side.frames)
    side.send("run.start", path=raising)
    side.wait_frame("run.started", ACTION_TIMEOUT, since=before)
    _, traceback_line = side.wait_frame_where(
        "run.output", lambda f: "ValueError: deliberate" in f.get("text", ""),
        ACTION_TIMEOUT, since=before)
    check("a traceback arrives on the same stream as the output",
          traceback_line is not None,
          "nothing" if traceback_line is None else traceback_line["text"].strip())
    _, failed_exit = side.wait_frame("run.exited", ACTION_TIMEOUT, since=before)
    check("a non-zero exit is reported as an outcome rather than an error",
          failed_exit is not None and failed_exit.get("code") not in (None, 0),
          "silent" if failed_exit is None else f"code {failed_exit.get('code')}")

    # A path that is not a file is refused out loud. Silence here would leave
    # the toolbar claiming something is running with nothing behind it.
    before = len(side.frames)
    side.send("run.start", path=os.path.join(scratch, "there-is-no-such-file.py"))
    _, refused = side.wait_frame("run.failed", ACTION_TIMEOUT, since=before)
    check("running a path that is not a file is refused, not ignored",
          refused is not None and "is not a file" in refused.get("message", ""),
          "no run.failed" if refused is None else refused.get("message", ""))

    # --- stopping a run ---

    forever = os.path.join(scratch, "run-forever.py")
    with open(forever, "w") as handle:
        handle.write(
            "import time\n"
            # No flush=True on purpose. An ordinary script does not flush, and
            # stdout to a pipe is block-buffered, so without -u this line would
            # sit in the buffer for as long as the loop runs - which is every
            # long script looking like it had hung until it finished.
            "print('the long run started')\n"
            "while True:\n"
            "    time.sleep(0.05)\n"
        )

    before = len(side.frames)
    side.send("run.start", path=forever)
    side.wait_frame("run.started", ACTION_TIMEOUT, since=before)
    _, long_output = side.wait_frame_where(
        "run.output", lambda f: "the long run started" in f.get("text", ""),
        ACTION_TIMEOUT, since=before)
    # -u, so a script that prints its progress is readable while it runs rather
    # than arriving in a lump at the end.
    check("a long run's output arrives while it is still running",
          long_output is not None, "nothing yet" if long_output is None else "printed")

    child = child_process(side.proc.pid, "run-forever.py")
    check("the running file really is a process of its own", child is not None,
          "no such child" if child is None else f"pid {child.pid}")

    # Asking for a second one while that is running is refused rather than
    # silently replacing it - one run at a time, as the debugger has.
    before = len(side.frames)
    side.send("run.start", path=run_script)
    _, second = side.wait_frame("run.failed", ACTION_TIMEOUT, since=before)
    check("a second run is refused while one is running",
          second is not None and "already running" in second.get("message", ""),
          "no run.failed" if second is None else second.get("message", ""))

    before = len(side.frames)
    side.send("run.stop")
    _, run_stopped = side.wait_frame("run.stopped", ACTION_TIMEOUT, since=before)
    check("Stop is answered", run_stopped is not None,
          "" if run_stopped is not None else "silent")

    deadline = time.monotonic() + 15
    while child_process(side.proc.pid, "run-forever.py") is not None:
        if time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    survivor = child_process(side.proc.pid, "run-forever.py")
    check("and the process is actually gone", survivor is None,
          "" if survivor is None else f"pid {survivor.pid} still running")

    # Deliberately silent afterwards: the frontend asked for this and is not
    # waiting to be told what it already knows. An exit here would announce the
    # run as finished a second time, after the UI had already moved on.
    time.sleep(1.0)
    late = [f for _, f in side.frames[before:] if f["type"] == "run.exited"]
    check("a deliberate stop does not also report an exit", len(late) == 0,
          f"{len(late)} run.exited frames")

    # --- debugging: a second world, driven over the relay ---
    #
    # The sidecar understands none of this. It spawns the process, holds the
    # socket debugpy dials into and frames messages both ways; every DAP request
    # below is composed here, exactly as the frontend will compose it.

    script = os.path.join(tempfile.gettempdir(), "b123d-debug-check.py")
    with open(script, "w") as handle:
        handle.write(
            "from build123d import *\n"
            # Deliberately does not import show_all. The on-stop hook is
            # evaluated *in this frame*, so a default that assumed the name was
            # already bound failed with a NameError on every stop of every file
            # that draws with show() - which is most of them.
            "from build123d_studio import show\n"
            "\n"
            "def make(size):\n"
            "    b = Box(size, size, size)\n"
            # A second statement inside the function, so a step stays in a frame
            # where a shape exists. Stepping off `return b` lands back at module
            # level, where `part` is not yet bound and there is correctly
            # nothing to draw - which is the filter working, not a failure.
            "    marker = size * 2\n"
            "    return b\n"
            "\n"
            "part = make(3)\n"
            "print('script finished')\n"
        )

    dap_seq = [0]

    def dap(command, **arguments):
        dap_seq[0] += 1
        side.send("debug.send", message={
            "seq": dap_seq[0], "type": "request",
            "command": command, "arguments": arguments,
        })
        return dap_seq[0]

    def dap_reply(seq, timeout=ACTION_TIMEOUT, since=0):
        _, frame = side.wait_frame_where(
            "debug.message",
            lambda f: f["message"].get("type") == "response"
            and f["message"].get("request_seq") == seq,
            timeout, since=since)
        return None if frame is None else frame["message"]

    def dap_event(name, timeout=ACTION_TIMEOUT, since=0):
        _, frame = side.wait_frame_where(
            "debug.message",
            lambda f: f["message"].get("type") == "event"
            and f["message"].get("event") == name,
            timeout, since=since)
        return None if frame is None else frame["message"]

    before = len(side.frames)
    side.send("debug.start", path=script)
    _, started = side.wait_frame("debug.started", ACTION_TIMEOUT, since=before)
    check("a debug session starts", started is not None,
          "no debug.started" if started is None else started["path"])

    if started is not None:
        dap_reply(dap("initialize", clientID="integration", adapterID="debugpy",
                      pathFormat="path", linesStartAt1=True, columnsStartAt1=True))
        dap("attach")
        check("the adapter reports itself initialized",
              dap_event("initialized", ACTION_TIMEOUT, since=before) is not None)

        # Line 6 is "return b", in the real file at its real line number. That
        # is what debugging a file on disk buys: there is no mapping to be
        # wrong about.
        seq = dap("setBreakpoints", source={"path": script}, breakpoints=[{"line": 6}])
        reply = dap_reply(seq, since=before)
        verified = [] if reply is None else [
            b.get("verified") for b in reply["body"]["breakpoints"]]
        check("a breakpoint binds to the file on disk", verified == [True], str(verified))
        dap_reply(dap("configurationDone"), since=before)

        stopped = dap_event("stopped", ACTION_TIMEOUT, since=before)
        check("execution stops on the breakpoint",
              stopped is not None and stopped["body"].get("reason") == "breakpoint",
              "never stopped" if stopped is None else str(stopped["body"].get("reason")))

        if stopped is not None:
            thread_id = stopped["body"]["threadId"]
            reply = dap_reply(dap("stackTrace", threadId=thread_id), since=before)
            frames = [] if reply is None else reply["body"]["stackFrames"]
            check("the stack names the real file and line",
                  len(frames) > 0
                  and os.path.basename(frames[0]["source"]["path"]) ==
                  "b123d-debug-check.py" and frames[0]["line"] == 6,
                  str([(f["name"], f["line"]) for f in frames[:2]]))

            frame_id = frames[0]["id"]
            reply = dap_reply(dap("evaluate", expression="size * 10",
                                  frameId=frame_id, context="repl"), since=before)
            check("the debug console evaluates in the paused frame",
                  reply is not None and reply["body"]["result"] == "30",
                  "no reply" if reply is None else str(reply["body"].get("result")))

            # The bare call first, to establish that this frame really has not
            # got the name - otherwise the check below would pass for a file
            # that happened to import it, which is exactly how the defect
            # survived. Reported on screen as "show_all(locals()) failed:
            # NameError", once per stop.
            reply = dap_reply(dap("evaluate", expression="show_all(locals())",
                                  frameId=frame_id, context="repl"), since=before)
            check("the frame has not got show_all, as an ordinary file has not",
                  reply is not None and reply.get("success") is False
                  and "NameError" in str(reply.get("message")),
                  "no reply" if reply is None else str(reply.get("message"))[:60])

            # And the on-stop default, which is why it carries its own import.
            # Kept in step with DEFAULT_ON_STOP in src/debug/settings.js by
            # hand; what it proves is the half that cannot be read off the
            # frontend at all - that DAP's evaluate takes two statements,
            # because the request goes with context "repl" and debugpy execs
            # what it cannot eval.
            at_models = len(side.binary)
            dap_reply(dap("evaluate",
                          expression="from build123d_studio import show_all; "
                                     "show_all(locals())",
                          frameId=frame_id, context="repl"), since=before)
            at_model = side.wait_binary(KIND_MODEL, ACTION_TIMEOUT, since=at_models)
            check("the on-stop default draws from a frame that never imported it",
                  at_model is not None,
                  "no model frame" if at_model is None else f"at {at_model:.2f}s")

            # Stepping, and a shape drawn at the new stop. This is the whole of
            # visual debugging: the frontend runs the configured expression
            # after every stop, so stepping through a model is watching it
            # being built. Driven here as the frontend drives it.
            at_models = len(side.binary)
            # The index is taken before the step is sent: the stopped event can
            # arrive before the response to `next` does, and a `since` computed
            # afterwards would look straight past it.
            at_step = len(side.frames)
            dap("next", threadId=thread_id)
            stepped = dap_event("stopped", ACTION_TIMEOUT, since=at_step)
            check("stepping stops again", stepped is not None,
                  "no second stop" if stepped is None else stepped["body"].get("reason"))

            if stepped is not None:
                frames = dap_reply(
                    dap("stackTrace", threadId=stepped["body"]["threadId"]),
                    since=before,
                )["body"]["stackFrames"]
                # The same expression as the stop before, because that is what
                # the hook sends at every stop - a name bound by an earlier
                # evaluate is not carried into the next one.
                dap_reply(dap("evaluate",
                              expression="from build123d_studio import show_all; "
                                         "show_all(locals())",
                              frameId=frames[0]["id"], context="repl"), since=before)
                at_model = side.wait_binary(KIND_MODEL, ACTION_TIMEOUT, since=at_models)
                check("a shape drawn at a later stop reaches the viewer too",
                      at_model is not None,
                      "no model frame" if at_model is None else f"at {at_model:.2f}s")

            dap("continue", threadId=thread_id)

        # stdout is not carried by DAP - measured - so the relay pipes it.
        _, output = side.wait_frame_where(
            "debug.output", lambda f: "script finished" in f.get("text", ""),
            ACTION_TIMEOUT, since=before)
        check("the script's own output is relayed", output is not None,
              "nothing" if output is None else output["text"].strip())

        _, exited = side.wait_frame("debug.exited", ACTION_TIMEOUT, since=before)
        check("the session reports the process exiting", exited is not None,
              "silent" if exited is None else f"code {exited.get('code')}")

    # The kernel is untouched by all of it, which is the whole point of two
    # worlds. Asked by path rather than off the listing: by now the namespace
    # holds the eleven hundred names the truncation check made, so anything
    # sorting late is past the five-hundred-row cut and absent for a reason
    # that has nothing to do with debugging.
    before = len(side.frames)
    side.send("vars.detail", path=["part"], offset=0)
    _, leaked = side.wait_frame_where(
        "vars.detail", lambda f: f["detail"].get("path") == ["part"],
        ACTION_TIMEOUT, since=before)
    check("nothing the debugged file defined reached the kernel",
          leaked is not None and "error" in leaked["detail"],
          "no reply" if leaked is None else str(leaked["detail"])[:60])

    # And the positive half, so the check above cannot pass by the namespace
    # having been emptied. `solid` rather than integration_marker, which was
    # defined before the restart check and is legitimately gone.
    before = len(side.frames)
    side.send("vars.detail", path=["solid"], offset=0)
    _, survived = side.wait_frame_where(
        "vars.detail", lambda f: f["detail"].get("path") == ["solid"],
        ACTION_TIMEOUT, since=before)
    check("and the namespace it had before is still there",
          survived is not None and "error" not in survived["detail"],
          "no reply" if survived is None else str(survived["detail"])[:60])

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
    # reported as "Failed to read a message from the kernel", blaming the kernel
    # for a stranger.
    before = len(side.log)
    with socket.create_connection(("127.0.0.1", model_port), timeout=10) as peer:
        token = b"\xff\xfe" + b"x" * 41
        body = struct.pack(">H", len(token)) + token
        peer.sendall(struct.pack(">Q", len(body)) + body)
        peer.recv(1)
    rejected = side.wait_log("Rejected a model message with a bad token", 15)[0] is not None
    blamed = [text for _, text in side.log[before:]
              if "Failed to read a message from the kernel" in text]
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
    provoked = ("Failed to read a message from the kernel: timed out",
                "Failed to read a message from the kernel: Gave up with",
                # Both asked for above: a path that is not a file, and a second
                # run while one is running. The sidecar refusing them is the
                # behaviour under test, and it says so through this same log.
                "Run failed to start:",
                # The kernel is killed above, deliberately, to hold that its
                # death is noticed at all - so the sidecar saying so is the
                # thing under test rather than a complaint. New since the
                # subsystem reports arrived; the wording is `Sidecar.report`'s.
                "Subsystem kernel: failed - the kernel process exited")
    complaints = [(at, text) for at, text in side.log
                  if ("failed" in text or "timed out" in text or "Traceback" in text)
                  and not text.startswith(provoked)]
    # With the time each was logged, because the text alone does not say which
    # test caused it - and that is the first question anybody asks of this list.
    check("the sidecar reported no unexpected failures", len(complaints) == 0,
          "; ".join(f"{at:.1f}s {text}" for at, text in complaints[:3]))

    # --- nothing outlives this process, however it dies ---
    #
    # Last, because it destroys the sidecar. SIGKILL rather than a graceful
    # stop: no shutdown ordering survives one - measured, the sidecar is gone in
    # 0.02 s - so this is the case that no amount of teardown code can answer
    # and only a contract can.
    #
    # Four of the six children are somebody else's promise and are asserted here
    # for exactly that reason: ipykernel's parent poller, the LSP's
    # `initialize.processId`, the console's pty, the measurement pipe. An
    # upgrade that quietly drops one of those should be a red test rather than a
    # leak found months later. The other two are ours, spawned through
    # `_supervise.py`, and before it existed both survived this.
    forever = os.path.join(scratch, "outlive.py")
    with open(forever, "w") as handle:
        handle.write("import time\nprint('running')\nwhile True:\n    time.sleep(0.05)\n")

    before = len(side.frames)
    side.send("run.start", path=forever)
    side.wait_frame("run.started", ACTION_TIMEOUT, since=before)
    side.send("debug.start", path=forever)
    side.wait_frame("debug.started", ACTION_TIMEOUT, since=before)

    watched = [p for p in psutil.Process(side.proc.pid).children(recursive=True)
               if p.status() != psutil.STATUS_ZOMBIE]
    check("the tree is what it should be before the kill", len(watched) >= 4,
          f"{len(watched)} processes")

    side.proc.kill()
    deadline = time.monotonic() + 20
    alive = watched
    while time.monotonic() < deadline:
        alive = [p for p in alive
                 if p.is_running() and p.status() != psutil.STATUS_ZOMBIE]
        if len(alive) == 0:
            break
        time.sleep(0.2)

    def describe(process):
        try:
            return " ".join(process.cmdline())[:70]
        except psutil.Error:
            return f"pid {process.pid}"

    check("nothing survives the sidecar being killed", len(alive) == 0,
          "; ".join(describe(p) for p in alive[:3]))

    # Whatever leaked, so a failing run does not leave a Python process looping
    # on the machine it ran on.
    for process in alive:
        try:
            process.kill()
        except psutil.Error:
            pass

    side.stop()

    # --- and the sidecar goes when the frontend does ---
    #
    # The other half of the contract above, and the half that was broken: the
    # check before this one kills the sidecar, which nothing can survive, and
    # says nothing about the sidecar *itself* going away when it is asked. On
    # 2026-08-15 seven of them were found on this machine outliving the
    # application that started them, each still holding a kernel, a console and
    # a measurement backend - and every one of them had been asked properly.
    #
    # A quit asks twice by design: `stopSidecar` sends the frame and then closes
    # stdin, so a webview that dies before the frame lands is still heard. Both
    # are sent here for that reason - the deadlock only appeared when the two
    # arrived together, because the teardown then ran on two threads at once and
    # they met in the middle.
    quitting = Sidecar(sys.executable, args.env_root, args.app_dir)
    quitting.start()
    quitting.wait_frame("ready", READY_TIMEOUT)
    # With work of its own to lose, so this is a shutdown with a kernel, a
    # console and a measurement backend in it rather than an empty one.
    quitting.send("kernel.execute", code="import time\n1 + 1\n")
    tree = [p for p in psutil.Process(quitting.proc.pid).children(recursive=True)
            if p.status() != psutil.STATUS_ZOMBIE]

    try:
        quitting.send("shutdown")
    except Exception:  # noqa: BLE001 - the socket may go with the process
        pass
    quitting.proc.stdin.close()

    # Generously more than the sidecar's own SHUTDOWN_DEADLINE, which is what
    # actually bounds this: reaching that is a fault, and it still exits.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and quitting.proc.poll() is None:
        time.sleep(0.1)
    check("the sidecar exits when its frontend goes", quitting.proc.poll() is not None,
          "still running" if quitting.proc.poll() is None else "")

    left = tree
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        left = [p for p in left if p.is_running() and p.status() != psutil.STATUS_ZOMBIE]
        if len(left) == 0:
            break
        time.sleep(0.2)
    check("nothing outlives a quit", len(left) == 0,
          "; ".join(describe(p) for p in left[:3]))

    for process in left:
        try:
            process.kill()
        except psutil.Error:
            pass
    quitting.stop()

    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed", flush=True)
    if len(failed) > 0:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
