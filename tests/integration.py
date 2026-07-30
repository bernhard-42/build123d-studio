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
import struct
import subprocess
import sys
import tempfile
import threading
import time

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
            f"ws://127.0.0.1:{announcement['port']}/?token={announcement['token']}"
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

    at_ready, _ = side.wait_frame("ready", READY_TIMEOUT)
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

    # Anything the sidecar itself called a failure. The NameError that stopped
    # the variable explorer was reported exactly this way and read by nobody.
    complaints = [text for _, text in side.log
                  if "failed" in text or "timed out" in text or "Traceback" in text]
    check("the sidecar reported no failures", len(complaints) == 0,
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
