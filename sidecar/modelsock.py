"""Receives tessellated models from the kernel.

Counterpart to kernel/build123d_studio/transport.py.

A loopback TCP listener on an OS-assigned port, on every platform. This was a
Unix domain socket, which was tidy on macOS and Linux and simply did not exist on
Windows - the named-pipe server was never written, so show() could not have
worked there at all. One mechanism that works everywhere beats two, one of which
is missing.

The port is never configured, so it cannot collide; the sidecar picks it up from
the OS and passes it to the kernel in the environment. Because any local process
could otherwise connect and push a model into the viewer, each message carries a
random token, compared in constant time.

Message layout, all lengths big-endian::

    uint64 total length of everything that follows
    uint16 token length | token
    uint8  kind
    uint32 body length  | body JSON
    payload                            -> raw tessellation buffers, DATA only

``kind`` is the ecosystem's own ``MessageType`` rather than a vocabulary of
ours, so the numbers mean here what they mean in every other viewer:

    DATA (1)     a model: the header JSON, and its buffers as the payload
    COMMAND (2)  a question, and the only kind that is answered
    BACKEND (5)  the id-to-shape mapping the measurement process keeps
    CONFIG (7)   a ``ui`` config block for the viewer already on screen

The mapping is its own message rather than a field of the model's, and the
split matters: it carries serialised BRep shapes that only the measurement
backend needs, and shipping them to the webview would roughly double the
traffic for data it cannot use.

A COMMAND is answered on the same connection, ``uint32 length | JSON``, before
it closes. That is the reply hop the shared show pipeline needs: ``status`` and
``workspace_config`` are reads, and they happen before any model is sent. Both
are answered out of this process's memory - the viewer pushes its state up as
it changes, and the settings file is on disk - so no browser is in the path.

**One thread per connection, and one worker delivering models.** The accept loop
used to read and deliver each message itself, which made a read anybody was slow
about into a listener nobody could reach: delivering a model blocks while the
webview is busy, and the ``status`` a show asks for *first* then waited behind
the model of the show before it. Since the adoption that is two blocking reads
in front of every frame drawn, so the serial loop stopped being a tidiness
question.

So a connection is read on a thread of its own and a COMMAND is answered there,
while DATA, BACKEND and CONFIG go to one worker in the order they were
*accepted* - they are a stream describing one model after another, and a mapping
that overtook its own model would describe the wrong one. Accepted rather than
read, and the distinction is the whole of ``_Turnstile``: each of those three is
a separate connection, so once they are on threads of their own, which one
reaches the queue first is the scheduler's opinion. It was wrong three times in
six. The queue is deliberately tiny: filling it
blocks the connection's thread, which stops it draining its socket, which blocks
the kernel's ``sendall`` - the backpressure the serial loop had for free, kept,
so a webview that has stopped reading cannot make this process buffer models.
"""

import queue
import secrets
import socket
import struct
import threading
import time

import orjson
from ocp_viewer_core.comms import MessageType

from channel import log

PREFIX = struct.Struct(">Q")
SHORT = struct.Struct(">H")
KIND = struct.Struct(">B")
LENGTH = struct.Struct(">I")

MAX_MESSAGE = 512 * 1024 * 1024

# The token is 32 bytes of secrets.token_urlsafe, so 43 characters. The cap is
# only here so that a declared token length cannot itself be used to make this
# read something large before anything has been checked.
MAX_TOKEN = 256

# Per-recv: a peer that stops talking mid-message gives up the connection.
SOCKET_TIMEOUT = 30

# And two bounds on whole connections, because a per-recv timeout bounds only a
# single recv: a client sending one byte every twenty-nine seconds resets it
# every time and holds the accept loop, which is serial, for as long as it
# likes. Every later show() then fails with a refused connection and no hint as
# to why.
#
# Two rather than one, because who is holding the loop matters. Until the token
# has been checked the peer is a stranger - any process on this machine can
# connect - and a stranger gets seconds, not minutes, because that number is
# exactly how long an unauthenticated process can stop the viewer working. After
# the token, it is our own kernel delivering a model, and the budget is generous:
# the largest measured here is 46 MB, which crosses loopback in a fraction of a
# second, so this is a limit on accident rather than on anything real.
HANDSHAKE_TIMEOUT = 5
MESSAGE_TIMEOUT = 120

# How many read-and-waiting models the delivery worker may be behind by. Two:
# one being delivered and one ready to go, which is enough that a show does not
# wait for the webview to have finished drawing the last one, and small enough
# that the third pushes back on the kernel instead of being buffered here. See
# the module docstring - the backpressure is the point, not the depth.
DELIVERY_QUEUE = 2

# How long a message waits for its place in the stream before going anyway.
# Longer than MESSAGE_TIMEOUT, because what it is waiting for is a connection
# accepted before it that has not finished being read - and that connection is
# already bounded by its own deadline, after which it gives its place up. So
# reaching this means something has gone wrong that those bounds did not
# describe, and the answer then is a message in the wrong order rather than a
# viewer that never hears about the model.
TURN_TIMEOUT = MESSAGE_TIMEOUT + 30


class _Turnstile:
    """Places in a queue, handed out in one order and let through in the same one.

    What this exists for: the kernel sends a model, its mapping and its config as
    three *separate connections*, one after another - see
    kernel/build123d_studio/transport.py, where every send connects, writes and
    closes. Each is then read on a thread of its own here, so which one reaches
    the delivery queue first was decided by the scheduler rather than by the
    kernel. Measured: a mapping overtook its own model in three runs out of six.

    The order is not decorative. A mapping describes the model it arrived with,
    and applied to the previous one it answers measurements about shapes that are
    no longer on screen; a config block does the same to the viewer.

    So the order is taken where it is still true - accept(), which is serial and
    sees the connections in the order the kernel made them, because each send
    finishes and closes before the next one connects. A place is claimed there
    and cashed in just before the message is queued.

    **The cost, stated rather than discovered.** A connection that is slow to
    send holds up the *delivery* of everything accepted after it, though not the
    reading of it. That is bounded by the read deadlines the module already has,
    and a place is given up whatever happens to the connection - a bad token, a
    truncated message, an exception, a COMMAND, which is answered on its own
    thread and belongs to no stream. A place that is never given up would stop
    the model channel for good, so `release` is only ever called from a finally.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._changed = threading.Condition(self._lock)
        self._next = 0
        self._serving = 0
        # Places given up out of turn. A connection that fails does not get to
        # decide that the ones before it are done, so the counter walks forward
        # through whatever has accumulated rather than jumping to the newest.
        self._given_up = set()

    def take(self):
        with self._lock:
            place = self._next
            self._next += 1
            return place

    def wait_for(self, place, timeout):
        """Wait for this place's turn. False if it did not come in time."""
        with self._changed:
            return self._changed.wait_for(lambda: self._serving >= place, timeout=timeout)

    def release(self, place):
        with self._changed:
            if place < self._serving:
                # Already through. Said plainly rather than left to the set
                # below, where it would sit for the life of the process as an
                # entry the counter can never reach again - a leak of one
                # integer per command, which is every show.
                return
            self._given_up.add(place)
            while self._serving in self._given_up:
                self._given_up.discard(self._serving)
                self._serving += 1
            self._changed.notify_all()

    def waiting(self):
        """How many places have been claimed and not yet given up, for a report."""
        with self._lock:
            return self._next - self._serving


def _receive_exactly(connection, count, deadline):
    """Read exactly count bytes, or give up at the deadline.

    The per-recv timeout alone is not a bound on the connection. A client that
    sends one byte every twenty-nine seconds resets it every time and holds the
    accept loop - which is serial - for as long as it likes, and every later
    show() then fails with a refused connection and no hint as to why. That is
    the same shape as the timeout that already exists, one level up: bounding
    each step bounds nothing about the whole.
    """
    chunks = []
    remaining = count
    while remaining > 0:
        budget = deadline - time.monotonic()
        if budget <= 0:
            raise TimeoutError(f"Gave up with {remaining} bytes still to come")
        # Whichever expires first: the idle timeout for a peer that has stopped
        # talking, the deadline for one that is talking too slowly to matter.
        connection.settimeout(min(SOCKET_TIMEOUT, budget))
        chunk = connection.recv(min(remaining, 1 << 20))
        if chunk == b"":
            raise ConnectionError("The kernel closed the connection early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class ModelSocket:
    """Listens for what the kernel sends and hands each message to a callback.

    Four kinds arrive and one of them is answered; see the module docstring.
    The callbacks are given separately rather than as one dispatch, because
    they are four different jobs: a model goes to the viewer, a mapping to the
    measurement process, a config block to the viewer already on screen, and a
    command has to be answered from here.
    """

    def __init__(self, on_model, on_mapping, on_config, on_command):
        self.on_model = on_model
        self.on_mapping = on_mapping
        self.on_config = on_config
        self.on_command = on_command
        self.port = None
        self.token = secrets.token_urlsafe(32)

        self._server = None
        self._thread = None
        self._stop = threading.Event()

        # What has been read and not yet handed on, and how many connections are
        # being read right now. Both exist to be reported: a show that has gone
        # quiet is either waiting on the webview - the queue is full - or on the
        # kernel, and until now nothing here could tell the two apart. See
        # `state`, which the stall watchdog prints.
        self._deliveries = queue.Queue(maxsize=DELIVERY_QUEUE)
        self._reading = 0
        self._reading_lock = threading.Lock()
        # Places in the model stream, claimed at accept. See _Turnstile: three
        # connections carry one show, and only accept() still knows what order
        # the kernel sent them in.
        self._turnstile = _Turnstile()

    def start(self):
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        # Deeper than the four it was, because a connection is no longer held
        # for as long as its message takes to deliver: what queues here now is
        # only the moment between connect and accept.
        self._server.listen(16)
        self.port = self._server.getsockname()[1]

        threading.Thread(target=self._deliver, name="modelsock-deliver", daemon=True).start()
        self._thread = threading.Thread(target=self._serve, name="modelsock", daemon=True)
        self._thread.start()
        log(f"Model channel listening on 127.0.0.1:{self.port}")
        return self.port

    def state(self):
        """What this channel is doing, for a report about a stall."""
        with self._reading_lock:
            reading = self._reading
        return {
            "reading": reading,
            # Connections accepted and not yet finished with, so a stall report
            # can tell "nothing has arrived" from "something arrived and is
            # waiting behind a connection that has not finished being read".
            "in_turn": self._turnstile.waiting(),
            "queued": self._deliveries.qsize(),
            "listening": self.port is not None and not self._stop.is_set(),
        }

    def _serve(self):
        while not self._stop.is_set():
            try:
                connection, _ = self._server.accept()
            except OSError:
                if not self._stop.is_set():
                    log("Model channel accept failed")
                return
            # Claimed here rather than on the connection's thread, because here
            # is the last place the kernel's own order is still known: accept()
            # is serial and returns connections in the order they were made, and
            # the kernel makes them one at a time. A thread started a moment
            # later has already lost it.
            place = self._turnstile.take()
            # A thread per connection, so that reading one message never decides
            # when the next one is *accepted*. Daemon, like every other thread
            # here: a message half-read at exit is a message nobody is waiting
            # for any more.
            threading.Thread(
                target=self._handle, args=(connection, place), name="modelsock-conn",
                daemon=True,
            ).start()

    def _handle(self, connection, place):
        with self._reading_lock:
            self._reading += 1
        try:
            self._read_message(connection, place)
        except Exception as exc:  # noqa: BLE001 - one bad message must not stop the server
            log(f"Failed to read a message from the kernel: {exc}")
        finally:
            # Whatever happened - queued, answered, refused, raised - the place
            # goes back. One kept would stop every later model for good, which
            # is a worse failure than the one the ordering exists to prevent.
            self._turnstile.release(place)
            with self._reading_lock:
                self._reading -= 1
            connection.close()

    def _deliver(self):
        """Hand on what has been read, one message at a time, in arrival order."""
        while True:
            what, deliver = self._deliveries.get()
            try:
                deliver()
            except Exception as exc:  # noqa: BLE001 - one bad message must not stop delivery
                log(f"Failed to deliver a {what} message from the kernel: {exc}")

    def _read_message(self, connection, place):
        # The stranger's budget until the token proves otherwise.
        deadline = time.monotonic() + HANDSHAKE_TIMEOUT
        total = PREFIX.unpack(_receive_exactly(connection, PREFIX.size, deadline))[0]
        if total > MAX_MESSAGE:
            raise ValueError(f"Refusing a {total} byte model message")

        # The token is read and checked before anything else is read at all.
        #
        # This used to take the whole body first and check the token inside it,
        # which meant any process on the machine could make the sidecar allocate
        # up to half a gigabyte per connection attempt, repeatedly, without ever
        # presenting a credential. The module's own premise is that loopback
        # reachability is not authority, and buffering half a gigabyte on behalf
        # of an unauthenticated peer contradicted it.
        if total < SHORT.size:
            raise ValueError(f"Truncated model message: {total} bytes")
        token_length = SHORT.unpack(_receive_exactly(connection, SHORT.size, deadline))[0]
        if token_length > MAX_TOKEN or SHORT.size + token_length > total:
            raise ValueError(f"Refusing a model message declaring a {token_length} byte token")

        # Compared as bytes, never decoded. compare_digest on two str values
        # requires both to be ASCII-only, and decoding with "replace" is exactly
        # what produces a non-ASCII one: a single stray byte becomes U+FFFD and
        # the comparison raises TypeError, which this module then reported as
        # "Failed to read a model" - a bad token described as a broken kernel.
        token = _receive_exactly(connection, token_length, deadline)
        if not secrets.compare_digest(token, self.token.encode("ascii")):
            # Nothing beyond the token has been read, and nothing more will be.
            log("Rejected a model message with a bad token")
            return

        # Authenticated now, so the generous budget applies to the body.
        deadline = time.monotonic() + MESSAGE_TIMEOUT
        body = _receive_exactly(connection, total - SHORT.size - token_length, deadline)

        # Every length is checked against what is actually left. Trusting them
        # turned a truncated message into a confusing struct.error from
        # unpack_from rather than a statement about the message.
        cursor = 0

        def take(count, what):
            nonlocal cursor
            if cursor + count > len(body):
                raise ValueError(
                    f"Model message {what} runs past the end "
                    f"({cursor + count} > {len(body)} bytes)"
                )
            chunk = body[cursor : cursor + count]
            cursor += count
            return chunk

        kind = KIND.unpack(take(KIND.size, "kind"))[0]
        body_length = LENGTH.unpack(take(LENGTH.size, "body length"))[0]
        document = take(body_length, "body")

        if kind == MessageType.DATA:
            # The header is handed on as the bytes the kernel produced - no
            # decode and re-encode round trip - and the payload keeps its raw
            # buffers all the way to the webview.
            payload = body[cursor:]
            self._queue(place, "model", lambda: self.on_model(document, payload))
        elif kind == MessageType.BACKEND:
            self._queue(place, "mapping", lambda: self.on_mapping(document))
        elif kind == MessageType.CONFIG:
            config = orjson.loads(document)
            self._queue(place, "config", lambda: self.on_config(config))
        elif kind == MessageType.COMMAND:
            # Answered here rather than queued, and that is the whole reason
            # this reads on a thread of its own: a command is a *read* the show
            # pipeline makes before it sends anything, and queueing it behind
            # the model of the show before would be the delay this removed.
            #
            # Its place goes back before it is answered, not after. A command is
            # not part of the stream, so nothing is ordered against it - and
            # holding a place across the answer would turn "a command never
            # waits behind a model" into "a model can wait behind a command",
            # which is the same delay pointing the other way. Released again in
            # _handle's finally, which is why release tolerates being told twice.
            self._turnstile.release(place)
            answer = self.on_command(orjson.loads(document))
            reply = orjson.dumps(answer)
            connection.sendall(LENGTH.pack(len(reply)) + reply)
        else:
            raise ValueError(f"Unknown message kind {kind} from the kernel")

    def _queue(self, place, what, deliver):
        """Hand one message to the delivery worker, in the order it was accepted.

        Two waits, and they are for different things.

        The turn is this message's place in the stream - see _Turnstile. Without
        it a mapping read on a quicker thread than its own model was delivered
        first, which is a mapping describing the wrong model. A turn that never
        comes is not allowed to lose the message: after the wait it goes anyway,
        because a message delivered out of order is a fault and a message never
        delivered is a show that hangs.

        The queue being full is the other, and waiting on it is deliberate: this
        runs on the connection's own thread, so a full queue stops that socket
        being drained and the kernel's sendall blocks - the backpressure the
        serial accept loop used to give for free. It is taken *after* the turn,
        so a message waiting for the webview holds its place rather than letting
        the next one past.
        """
        if not self._turnstile.wait_for(place, TURN_TIMEOUT):
            log(f"Delivering a {what} message out of turn after {TURN_TIMEOUT}s")
        self._deliveries.put((what, deliver))

    def stop(self):
        self._stop.set()
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
