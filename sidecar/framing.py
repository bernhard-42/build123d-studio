"""Content-Length framing, which two protocols in this application share.

The Language Server Protocol defined it and the Debug Adapter Protocol adopted
it unchanged: a header block, a blank line, then exactly that many bytes of
JSON. One implementation rather than two, because the failure mode of getting it
subtly wrong is the same in both - a stream that desynchronises and never
resynchronises, so everything after the first bad length is lost in silence
rather than reported.

Deliberately not a class and deliberately not holding the stream: the language
server is a pipe to a subprocess and the debug adapter is a TCP socket, and both
answer to the same two functions once the socket is wrapped with makefile().
"""

import json


def encode(message):
    """One message, header and all, ready to write."""
    body = json.dumps(message).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def read_message(stream):
    """Read one message, or None when the stream ends or says something absurd.

    None rather than an exception for every failure here. Both callers are
    reading on a background thread from a process that is allowed to die, and a
    stream that has ended is the ordinary way a session finishes.
    """
    length = None
    while True:
        try:
            line = stream.readline()
        except (OSError, ValueError):
            return None
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        if line.lower().startswith(b"content-length:"):
            try:
                length = int(line.split(b":", 1)[1])
            except ValueError:
                return None
    if length is None:
        return None
    try:
        body = stream.read(length)
    except (OSError, ValueError):
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None
