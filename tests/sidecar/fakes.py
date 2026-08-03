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
import queue
import tempfile
import threading
import time

from kernel import Kernel


class FakeClient:
    """A jupyter client with the sockets taken out.

    Records which threads read it and which threads sent on it, because that is
    the assertion these tests actually want: a zmq socket is not thread safe, so
    "two threads used this client" *is* the defect, stated directly rather than
    through the corrupted messages it eventually produces.
    """

    def __init__(self, name, on_execute=None, answers=True):
        self.name = name
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
        # Whether the kernel this stands in for bothers to answer. Off is how a
        # test arranges a request that is still outstanding when something else
        # happens to it.
        self.answers = answers
        self._iopub = queue.Queue()
        self._shell = queue.Queue()
        self._on_execute = on_execute
        self._counter = itertools.count()
        self._lock = threading.Lock()

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

    def execute(self, code, **kwargs):
        current = threading.current_thread()
        with self._lock:
            self.senders.add((current.ident, current.name))
            if self.channels_stopped:
                # A send into a client whose channels have been torn down. In
                # the real one this is an assertion inside jupyter_client, or
                # worse, a socket being rebuilt underneath the caller.
                self.executed_after_stop.append(code)
            msg_id = f"{self.name}-{next(self._counter)}"
            self.executes.append(msg_id)
        if self._on_execute is not None:
            self._on_execute(msg_id)
        if self.answers:
            self._shell.put(self._reply_to(msg_id, kwargs))
        return msg_id

    def complete(self, code, cursor_pos=None):
        """The completion half of the client's surface.

        Same shape as execute: record who sent, hand back a msg_id, and answer
        on the shell queue if this client is one that answers. The reply is a
        complete_reply rather than an execute_reply, and echoing the code back
        as the single match is what lets a test tell one completion's answer
        from another's.
        """
        current = threading.current_thread()
        with self._lock:
            self.senders.add((current.ident, current.name))
            msg_id = f"{self.name}-{next(self._counter)}"
            self.completions.append((code, cursor_pos, msg_id))
        if self.answers:
            self._shell.put({
                "parent_header": {"msg_id": msg_id},
                "content": {
                    "status": "ok",
                    "matches": [code],
                    "cursor_start": 0,
                    "cursor_end": cursor_pos,
                    "metadata": {},
                },
            })
        return msg_id

    # --- what a test drives it with ---

    def _reply_to(self, msg_id, kwargs):
        """A shell reply that echoes the user_expression back.

        Echoing rather than returning a constant is what lets a test tell one
        reply from another, which is the whole question when several
        inspections are outstanding at once.
        """
        content = {}
        expressions = kwargs.get("user_expressions") or {}
        source = expressions.get("value")
        if source is not None:
            content["user_expressions"] = {
                "value": {"status": "ok", "data": {"text/plain": repr(source)}}
            }
        return {"parent_header": {"msg_id": msg_id}, "content": content}

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

    def __init__(self, on_iopub, on_execute=None, answers=True, **kwargs):
        self.clients = []
        self._on_execute = on_execute
        self._answers = answers
        with tempfile.TemporaryDirectory() as env_root:
            super().__init__(
                env_root=env_root,
                app_dir=env_root,
                model_port=0,
                model_token="token",
                on_iopub=on_iopub,
                on_died=lambda: None,
                isolation_port=0,
                **kwargs,
            )

    def new_manager(self):
        client = FakeClient(
            f"gen{len(self.clients)}", on_execute=self._on_execute, answers=self._answers
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
