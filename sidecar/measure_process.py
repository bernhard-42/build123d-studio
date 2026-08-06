"""The measurement backend, in a process of its own.

It is here rather than in the sidecar for one reason, and it is not tidiness.
`measure` imports ocp_vscode.backend, which drags in build123d and OCP: two
seconds of native library loading on macOS and, measured on a cold Windows
start, **10.3 seconds**. Loading a .pyd is LoadLibrary, which holds the Windows
loader lock while CPython holds the GIL across the call, and every thread a
process starts needs that same lock to run DLL_THREAD_ATTACH. So the import and
any thread creation that overlaps it wait on each other for good.

The sidecar cannot avoid creating threads - its websockets accept loop starts
one per connection, a debug session starts three, a Run File two, a kernel
restart brings up new ZMQ channels. It used to sequence around that: import
first, on the main thread, before the accept loop starts, with an assertion
holding the rule. That worked and was never comfortable. Bernhard's cold
Windows log shows how close it came - a Run was pressed inside the 10.3 second
window and the application survived only because the kernel's own build123d
import released the shell channel 103 ms after the sidecar's finished. Two
unrelated durations from two unrelated dependency graphs.

Here there is nothing to sequence. This process creates no threads at all: it
reads a request, answers it, reads the next. The import can therefore happen
whenever it likes, on every platform, and nothing waits for it - the sidecar
spawns this alongside the kernel and carries on.

**The protocol.** Length-prefixed JSON both ways on stdin and stdout, one
request at a time. stdout carries that and nothing else; logs go to stderr,
which the sidecar relays into its own log so this process is not invisible.
Binary would be faster and there is nothing here worth optimising: a mapping
crosses once per measurement session rather than once per show, and a selection
is a handful of ids.
"""

import struct
import sys

import orjson

# At module scope, where every import in this project belongs. If the backend
# cannot be imported this process dies here with a traceback on stderr, which
# the sidecar relays into its own log - the same outcome as reporting it down
# the pipe, and without a second code path that only runs when something is
# already broken.
from measure import Measurements

LENGTH = struct.Struct("<I")

# The largest message this will read. A mapping is serialised BRep and can be
# large on a real assembly; this is a guard against a corrupted length word
# rather than a budget anybody should hit.
MAX_MESSAGE = 512 * 1024 * 1024


def log(*parts):
    """To stderr. stdout is the protocol and carries nothing else."""
    print("measure:", *parts, file=sys.stderr, flush=True)


def read_exactly(stream, count):
    """Read exactly count bytes, or None at end of stream."""
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message(stream):
    prefix = read_exactly(stream, LENGTH.size)
    if prefix is None:
        return None
    length = LENGTH.unpack(prefix)[0]
    if length > MAX_MESSAGE:
        raise ValueError(f"Refusing a {length} byte message")
    body = read_exactly(stream, length)
    return None if body is None else orjson.loads(body)


def write_message(stream, message):
    body = orjson.dumps(message)
    stream.write(LENGTH.pack(len(body)))
    stream.write(body)
    stream.flush()


def main():
    """Read a request, answer it, read the next. No threads, ever.

    That is the whole reason this file exists: the import above holds the
    Windows loader lock, and nothing here will ever ask for it again by
    starting a thread. How long it took is timed by the sidecar, from spawn to
    the first answered ping - it knows both ends and this does not need to.
    """
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    measurements = Measurements()

    while True:
        request = read_message(stdin)
        if request is None:
            # stdin closed: the sidecar has gone, and so should this.
            return
        write_message(stdout, answer(measurements, request))


def answer(measurements, request):
    """One request, one reply. Never raises - a bad request is an error field."""
    reply = {"id": request.get("id")}
    try:
        command = request.get("command")
        if command == "load":
            # The mapping arrives as text because the transport is JSON; the
            # backend wants the bytes it was serialised as.
            measurements.load(request.get("mapping", "").encode("utf-8"))
            reply["ok"] = True
        elif command == "changes":
            reply["response"] = measurements.handle_changes(request.get("changes", {}))
        elif command == "ping":
            reply["ok"] = True
        else:
            reply["error"] = f"unknown command: {command}"
    except Exception as exc:  # noqa: BLE001 - one bad request must not end the process
        log(f"{request.get('command')} failed: {exc}")
        reply["error"] = str(exc)
    return reply


if __name__ == "__main__":
    main()
