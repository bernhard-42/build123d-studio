"""One directory per running instance, and a lock file that says whether it is live.

Every port this application uses is already OS-assigned, so two instances never
contend for one. What collided was a filename: `envRoot/kernel.json` was a single
hardcoded path, and the failure was worse than "the file is wrong". The kernel
process is launched with `-f <connection_file>` and reads its ports *from that
file*, so instance A wrote ports P, instance B overwrote them with ports Q, B's
kernel bound Q, and A's kernel then read Q and died on a zmq bind because B
already held them. A's client waited sixty seconds for a kernel that had never
existed, and the sidecar exited.

So each instance owns `<env_root>/instances/<uuid>/` and puts its connection file
there. Phase 1 promises that path is discoverable, so an external `jupyter
console --existing <path>` can attach to the same namespace; with several
instances running, "the same namespace" stops being well defined, and choosing a
primary would be a guess at which one the user meant. A directory per instance
answers it honestly - the About dialog names this instance's own.

**A uuid rather than the port, and identity kept separate from liveness.**
`NL_PORT` was the first suggestion, on the reasoning that the operating system
frees a port when a process dies, unlike a pid file, which goes stale exactly
when it matters. But ports are reused, and that breaks both jobs at once: a new
instance can be handed a dead one's number and inherit its directory, so an
external console reads a connection file naming ports that now belong to
something else - and the sweep asks "does that port still serve this
application", gets "yes" because the *new* instance holds it, and never cleans
the old directory up.

A uuid is never reused. Liveness is a separate question, answered by a `lock`
file inside the directory that the instance holds open under an exclusive lock
for as long as it runs. That keeps what the port was chosen for and drops what it
was bad at: the operating system releases the lock when the process dies -
including under SIGKILL - and unlike a port, nobody else can acquire it and be
mistaken for the owner. The sweep is then simply "try to take each lock; if it is
granted, the owner is gone".

**Two details exist only because Windows differs**, and both were measured on all
three platforms before this was written rather than reasoned about afterwards:

- Its locks cover a byte range from the current file position, so a zero-length
  lock file cannot be locked at all. The file needs a byte written into it first.
  That fails on Windows and nowhere else, which is exactly the kind of thing that
  reaches a user before it reaches a developer.
- A file held open by a live process cannot be deleted there. That is a property
  worth having rather than working around: a sweep with a bug in it fails loudly
  on Windows instead of quietly removing a running instance's connection file.

The sidecar is the natural owner of all of this. It already writes the connection
file, it lives exactly as long as the instance, and it already reports the path
to the frontend in its `ready` frame.
"""

import os
import shutil
import uuid

# One of these exists on any platform this application runs on, and the module
# that is missing is the one whose branch never executes. Written as a top-level
# conditional rather than an import inside the lock helpers: which primitive to
# use is a property of the platform, settled once, not a decision to re-take on
# every call.
if os.name == "nt":
    import msvcrt
else:
    import fcntl

INSTANCES_DIR = "instances"
LOCK_NAME = "lock"
CONNECTION_NAME = "kernel.json"

# The same name, at the old *place*: `<env_root>/kernel.json`, where the single
# connection file lived before there was one per instance - which is why this is
# the same string as CONNECTION_NAME above rather than a different one. Removed
# when it is found rather than left, because a stale file at the advertised path
# is worse than no file: `jupyter console --existing` reads it and tries to
# attach to a kernel that stopped days ago.
LEGACY_CONNECTION_NAME = "kernel.json"


def instances_root(env_root):
    return os.path.join(env_root, INSTANCES_DIR)


def _take_lock(handle):
    """Try to take the exclusive lock, without blocking. True if it was granted.

    Granted means the previous owner is gone: on both platforms the lock is
    released by the operating system when the holding process dies, however it
    died.
    """
    try:
        if os.name == "nt":
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


def _drop_lock(handle):
    """Release a lock this process holds. Closing the file would do it too."""
    try:
        if os.name == "nt":
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        # Already released, or the file went away underneath us. Either way the
        # lock is not held any more, which is all this was asked to achieve.
        pass


def _open_lock_file(path):
    """Open a lock file, with the byte Windows needs in order to lock it at all.

    Opened append-and-read so that an existing file is neither truncated nor
    rewritten - truncating it would be a write to a file another process may be
    holding a lock on.
    """
    handle = open(path, "a+b")  # noqa: SIM115 - the lock lives as long as the instance
    if handle.tell() == 0:
        handle.write(b"\x00")
        handle.flush()
    handle.seek(0)
    return handle


def is_live(directory):
    """Whether some process still holds this instance directory's lock.

    A directory with no lock file in it, or with an empty one, has no live owner:
    that is an instance that died between creating the directory and claiming it,
    which is a window of microseconds but not a state to guess about.
    """
    path = os.path.join(directory, LOCK_NAME)
    try:
        handle = _open_lock_file(path)
    except OSError:
        return False
    try:
        if _take_lock(handle) is False:
            return True
        _drop_lock(handle)
        return False
    finally:
        handle.close()


class Instance:
    """This process's own instance directory, held for as long as it runs."""

    def __init__(self, env_root, instance_id=None):
        self.env_root = env_root
        self.id = str(uuid.uuid4()) if instance_id is None else instance_id
        # Normalised, because the env root arrives from the frontend written
        # with forward slashes even on Windows, and os.path.join then appends
        # backslashes - giving
        # "C:/Users/.../runtime\instances\<uuid>\kernel.json". Windows accepts
        # it, but this is the path the About dialog exists to be copied from,
        # and a path with both separators in it reads as a bug.
        self.directory = os.path.normpath(os.path.join(instances_root(env_root), self.id))
        self.connection_file = os.path.join(self.directory, CONNECTION_NAME)
        self._lock = None

    def claim(self):
        """Create the directory and take its lock. Raises if it cannot be taken.

        Failing here is fatal by design. Everything downstream - the connection
        file, the sweep's idea of what is alive - depends on this process being
        the sole owner of this directory, and a uuid that is already locked means
        something is true that this module believes cannot be.
        """
        os.makedirs(self.directory, exist_ok=True)
        handle = _open_lock_file(os.path.join(self.directory, LOCK_NAME))
        if _take_lock(handle) is False:
            handle.close()
            raise RuntimeError(f"Instance directory is already locked: {self.directory}")
        self._lock = handle
        return self.directory

    def release(self, on_error=None):
        """Best-effort tidy exit. Idempotent.

        **`sweep` is what guarantees cleanup, not this.** Tested on both
        platforms: an ordinary quit *sometimes* leaves the directory behind, and
        the next instance's sweep collects it. Do not read this as the primary
        path with the sweep as a backstop for crashes - it is the other way
        round.

        Two candidate reasons, only one of them established. On Windows a file
        open by a live process cannot be deleted, and a kernel asked to stop has
        not necessarily stopped, so the removal is refused. That does not
        explain macOS, where POSIX unlinks open files quite happily - a
        directory surviving there means this never ran, most likely because
        quitting races the sidecar's own termination and `Sidecar.stop` has five
        other things to close before it reaches here. That last part is a
        hypothesis and is labelled as one: the frontend writes the log and is
        gone before anything printed here at quit could be captured, so this
        path cannot report on itself.

        Left alone deliberately. The directory is 295 bytes and a lock file, the
        sweep is deterministic, and reordering a shutdown path to win a race is
        how this project once spent 90 s refusing a single Run.

        The lock is dropped first and always, because that is the part the sweep
        reads: once it is gone the directory is collectable whether or not the
        removal below succeeds. The failure is reported rather than swallowed -
        `ignore_errors=True` here is what made the Windows behaviour impossible
        to explain from the log in the first place - though on the quit path
        there may be nobody left to hear it. `sweep`'s reporting runs at startup
        with the frontend alive, and that is the one that matters.
        """
        if self._lock is None:
            return
        _drop_lock(self._lock)
        self._lock.close()
        self._lock = None
        try:
            shutil.rmtree(self.directory)
        except OSError as exc:
            if on_error is not None:
                on_error(self.directory, exc)


def sweep(env_root, keep_id=None, on_error=None):
    """Remove the directories of instances that are no longer running.

    Called at startup, so a crashed instance is tidied up by the next one rather
    than by a background timer nobody can reason about.

    Deliberately not `ignore_errors`: on Windows a live process's open lock file
    cannot be deleted, so a failure here means this function was wrong about who
    is alive. That is worth reporting rather than swallowing - it is the loudness
    the platform is offering for free.

    @param keep_id this instance's own id, never swept
    @returns the ids that were removed
    """
    root = instances_root(env_root)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        # Nothing has ever run from this environment root.
        return []

    removed = []
    for name in names:
        if name == keep_id:
            continue
        directory = os.path.join(root, name)
        if os.path.isdir(directory) is False:
            continue
        if is_live(directory):
            continue
        try:
            shutil.rmtree(directory)
        except OSError as exc:
            if on_error is not None:
                on_error(directory, exc)
            continue
        removed.append(name)
    return removed


def remove_legacy_connection_file(env_root):
    """Delete the pre-instance `envRoot/kernel.json`, if this install has one.

    Every environment root built before this change has one, and nothing writes
    it any more. Left in place it is a trap rather than clutter: it is the path
    Phase 1 told people to attach to, and it now names a kernel that is gone.

    @returns whether a file was removed
    """
    path = os.path.join(env_root, LEGACY_CONNECTION_NAME)
    try:
        os.remove(path)
    except OSError:
        return False
    return True
