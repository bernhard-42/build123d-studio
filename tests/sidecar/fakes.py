"""A kernel with the process taken out, for driving the lifecycle around it.

Everything the sidecar is genuinely difficult about lives *above* jupyter_client:
which thread may touch the shell socket, which generation a retired thread is
holding, which request ids count as internal, what happens to a reply nobody
asked for. None of that needs a real kernel, and a real one makes the races
impossible to steer - the whole point of these tests is to hold a thread exactly
where the unlucky one would have been.

So Kernel.new_manager is overridden and nothing else is. The pump, the shell
thread, the generation scoping and the internal-request record are the shipped
code.
"""

import itertools
import os
import queue
import tempfile
import threading
import time

from kernel import Kernel


class FakeSession:
    """Enough of jupyter_client's Session to build a message.

    Kernel builds its own shell messages rather than calling client.execute() -
    the msg_id has to exist before the send, and a subshell id has to go in the
    header - so the fake client's surface is a session and a channel, the same
    two things the real one uses underneath.
    """

    def __init__(self, name):
        self.name = name
        self._counter = itertools.count()

    def msg(self, msg_type, content=None):
        return {
            "header": {"msg_id": f"{self.name}-{next(self._counter)}", "msg_type": msg_type},
            "parent_header": {},
            "metadata": {},
            "content": content or {},
        }


class FakeShellChannel:
    """The socket, reduced to "who sent on it, and what went out"."""

    def __init__(self, client):
        self._client = client

    def send(self, message):
        self._client.record_send(message)


class FakeControlChannel:
    """The control channel, which this application uses for one thing.

    create_subshell_request at startup, and nothing else. ``subshells`` is what
    a test sets to say which kind of kernel this stands in for: True answers
    with an id, False refuses, and None never answers at all - the three
    outcomes Kernel._create_subshell distinguishes, and all three have to lead
    to a working application.
    """

    def __init__(self, client, subshells=True):
        self._client = client
        self.subshells = subshells
        self.sent = []

    def send(self, message):
        self.sent.append(message)
        if self.subshells is None:
            return
        msg_id = message["header"]["msg_id"]
        if self.subshells is False:
            content = {"status": "error"}
        else:
            content = {"status": "ok", "subshell_id": f"{self._client.name}-sub"}
        self._client.deliver_control({
            "header": {"msg_type": "create_subshell_reply"},
            "parent_header": {"msg_id": msg_id},
            "content": content,
        })


class FakeClient:
    """A jupyter client with the sockets taken out.

    Records which threads read it and which threads sent on it, because that is
    the assertion these tests actually want: a zmq socket is not thread safe, so
    "two threads used this client" *is* the defect, stated directly rather than
    through the corrupted messages it eventually produces.
    """

    # What KernelClient defaults it to, and what _build_message copies into
    # every execute_request so that user code calling input() keeps working.
    allow_stdin = True

    def __init__(self, name, on_execute=None, answers=True, subshells=True):
        self.name = name
        self.session = FakeSession(name)
        self.shell_channel = FakeShellChannel(self)
        self.control_channel = FakeControlChannel(self, subshells=subshells)
        self.channels_started = False
        self.channels_stopped = False
        self.readers = set()
        self.senders = set()
        self.executes = []
        self.executed_after_stop = []
        # Completion requests, as (code, cursor_pos, msg_id). A separate list
        # because the question these tests ask about them is a different one:
        # not "did two threads send" but "did this go out as a complete_request
        # rather than as code the kernel would run". The msg_id is kept because
        # it is what the internal-request record is keyed by.
        self.completions = []
        # Every message as it went out, headers included. What a test asks of
        # this and of nothing else is which shell a request was routed to, which
        # is a header field rather than anything the two lists above carry.
        self.sent = []
        # Whether the kernel this stands in for bothers to answer. Off is how a
        # test arranges a request that is still outstanding when something else
        # happens to it.
        self.answers = answers
        self._iopub = queue.Queue()
        self._shell = queue.Queue()
        self._control = queue.Queue()
        self._on_execute = on_execute
        self._lock = threading.Lock()

    def deliver_control(self, message):
        self._control.put(message)

    def get_control_msg(self, timeout=None):
        return self._control.get(timeout=timeout)

    # --- the surface Kernel uses ---

    def start_channels(self):
        self.channels_started = True

    def wait_for_ready(self, timeout=None):
        if not self.channels_started:
            raise RuntimeError("waited for a client whose channels were never started")

    def stop_channels(self):
        self.channels_stopped = True

    def get_iopub_msg(self, timeout=None):
        with self._lock:
            # By identity, not by name. Every generation's pump is started as
            # `name="iopub"` and every shell thread as `name="shell"`, so a set
            # of names cannot tell a straggler from its replacement - which is
            # exactly the distinction under test, and it silently passed until
            # this was an ident.
            current = threading.current_thread()
            self.readers.add((current.ident, current.name))
        return self._iopub.get(timeout=timeout)

    def get_shell_msg(self, timeout=None):
        return self._shell.get(timeout=timeout)

    def record_send(self, message):
        """One message on the shell socket, sorted by what it is.

        The two lists are kept apart because the questions asked about them
        differ: for an execute it is "did two threads send", and for a
        completion it is "did this go out as a complete_request rather than as
        code the kernel would run". The msg_id is kept for both, because it is
        what the internal-request record is keyed by.
        """
        header = message["header"]
        msg_id = header["msg_id"]
        content = message["content"]
        current = threading.current_thread()
        with self._lock:
            self.senders.add((current.ident, current.name))
            if header["msg_type"] == "complete_request":
                self.completions.append((content["code"], content["cursor_pos"], msg_id))
            else:
                if self.channels_stopped:
                    # A send into a client whose channels have been torn down.
                    # In the real one this is an assertion inside
                    # jupyter_client, or worse, a socket being rebuilt
                    # underneath the caller.
                    self.executed_after_stop.append(content["code"])
                self.executes.append(msg_id)
            self.sent.append(message)
        if self._on_execute is not None:
            self._on_execute(msg_id)
        if self.answers:
            self._shell.put(self._reply_to(message))

    # --- what a test drives it with ---

    def _reply_to(self, message):
        """A shell reply that echoes back enough to tell it from another's.

        Echoing rather than returning a constant is what lets a test tell one
        reply from another, which is the whole question when several
        inspections are outstanding at once.
        """
        msg_id = message["header"]["msg_id"]
        content = message["content"]
        if message["header"]["msg_type"] == "complete_request":
            return {
                "parent_header": {"msg_id": msg_id},
                "content": {
                    "status": "ok",
                    "matches": [content["code"]],
                    "cursor_start": 0,
                    "cursor_end": content["cursor_pos"],
                    "metadata": {},
                },
            }
        reply = {}
        source = (content.get("user_expressions") or {}).get("value")
        if source is not None:
            reply["user_expressions"] = {
                "value": {"status": "ok", "data": {"text/plain": repr(source)}}
            }
        return {"parent_header": {"msg_id": msg_id}, "content": reply}

    def deliver(self, msg_id="m", msg_type="status", parent_type="execute_request",
                state="idle"):
        self._iopub.put({
            "header": {"msg_type": msg_type},
            "parent_header": {"msg_id": msg_id, "msg_type": parent_type},
            "content": {"execution_state": state},
        })


class FakeManager:
    def __init__(self, client):
        self._client = client
        self.alive = True
        self.shutdowns = []
        self.cleaned = False

    def client(self):
        return self._client

    def is_alive(self):
        return self.alive

    def shutdown_kernel(self, now=False):
        self.shutdowns.append(now)

    def cleanup_resources(self):
        self.cleaned = True

    def interrupt_kernel(self):
        pass


class TestableKernel(Kernel):
    """The real Kernel with the process replaced, and nothing else."""

    def __init__(self, on_iopub, on_execute=None, answers=True, subshells=True, **kwargs):
        self.clients = []
        self._on_execute = on_execute
        self._answers = answers
        self._subshells = subshells
        with tempfile.TemporaryDirectory() as env_root:
            super().__init__(
                env_root=env_root,
                app_dir=env_root,
                # Never opened: new_manager below replaces the process, so
                # nothing here writes or reads a connection file.
                connection_file=os.path.join(env_root, "kernel.json"),
                model_port=0,
                model_token="token",
                on_iopub=on_iopub,
                on_died=lambda: None,
                isolation_port=0,
                **kwargs,
            )

    def new_manager(self):
        client = FakeClient(
            f"gen{len(self.clients)}",
            on_execute=self._on_execute,
            answers=self._answers,
            subshells=self._subshells,
        )
        self.clients.append(client)
        return FakeManager(client)


def wait_until(predicate, timeout, interval=0.01):
    """Poll until something becomes true, or say it did not."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()
