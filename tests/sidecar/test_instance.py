"""The per-instance directory, and the lock that says whether it is still live.

The defect these exist for is not subtle and does not need widening: the
connection file was `<env_root>/kernel.json` for everybody, so two instances
named the same path. What made it expensive is what happens next - the kernel
process is launched with `-f <connection_file>` and reads its ports *from that
file*, so the second instance's ports end up in the first instance's kernel,
which then dies binding ports somebody else already holds. The first test below
is the whole of that, stated as an inequality.

The liveness half needs a real process, because the property being tested is the
operating system's rather than this module's: a lock is released when its holder
dies, however it died. A `SIGKILL`ed child is the only honest way to ask, since
nothing in-process can simulate "the owner is gone" - a fake that answered "stale"
on request would be testing the fake.

Both platforms are covered by the same assertions rather than by branches.
`fcntl.flock` and `msvcrt.locking` differ in every detail except the two that
matter here, and instance.py is where that difference is allowed to live.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

from instance import Instance, is_live, remove_legacy_connection_file, sweep

# Long enough for a child interpreter to start and claim a directory on a loaded
# machine, short enough that a genuine hang does not read as a slow pass.
CLAIMED = 15.0


def claim_in_a_child(env_root, instance_id):
    """Start a process that claims `instance_id` and then waits to be killed.

    Returns once the child says it holds the lock, so nothing below has to guess
    at how long an interpreter takes to start.
    """
    source = textwrap.dedent(
        f"""
        import sys
        sys.path.insert(0, {os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) + "/sidecar"!r})
        from instance import Instance

        held = Instance({env_root!r}, instance_id={instance_id!r})
        held.claim()
        print("claimed", flush=True)
        # Killed from the test. Never released, which is the point.
        while True:
            import time
            time.sleep(3600)
        """
    )
    child = subprocess.Popen(
        [sys.executable, "-c", source],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + CLAIMED
    while time.monotonic() < deadline:
        line = child.stdout.readline()
        if line.startswith("claimed"):
            return child
        if child.poll() is not None:
            failure = child.stderr.read()
            stop_child(child)
            raise AssertionError(f"the child exited: {failure}")
    stop_child(child)
    raise AssertionError("the child never claimed its instance directory")


def stop_child(child):
    """Kill the child and close its pipes. Safe to call after it is already dead."""
    child.kill()
    child.wait(timeout=CLAIMED)
    child.stdout.close()
    child.stderr.close()


class InstanceDirectoryTest(unittest.TestCase):
    def setUp(self):
        self.env_root = tempfile.mkdtemp(prefix="instance-test-")

    def test_two_instances_never_name_the_same_connection_file(self):
        """The collision itself. One shared filename was the whole defect."""
        first = Instance(self.env_root)
        second = Instance(self.env_root)

        self.assertNotEqual(first.id, second.id)
        self.assertNotEqual(first.directory, second.directory)
        self.assertNotEqual(
            first.connection_file,
            second.connection_file,
            "two kernels writing one connection file is what made one of them read "
            "the other's ports and die binding them",
        )

    def test_both_directories_exist_at_once(self):
        """Not just different names: both are claimable at the same time."""
        first = Instance(self.env_root)
        second = Instance(self.env_root)
        first.claim()
        self.addCleanup(first.release)
        second.claim()
        self.addCleanup(second.release)

        self.assertTrue(os.path.isdir(first.directory))
        self.assertTrue(os.path.isdir(second.directory))
        self.assertTrue(is_live(first.directory))
        self.assertTrue(is_live(second.directory))

    def test_the_connection_file_sits_inside_the_claimed_directory(self):
        """jupyter_client writes it, so the directory has to be there first."""
        held = Instance(self.env_root)
        held.claim()
        self.addCleanup(held.release)

        self.assertEqual(os.path.dirname(held.connection_file), held.directory)
        self.assertTrue(os.path.isdir(os.path.dirname(held.connection_file)))

    def test_the_lock_file_is_never_empty(self):
        """Windows locks a byte range from the current position.

        A zero-length lock file cannot be locked there and can be everywhere
        else, so this is the one precondition that would fail on one platform
        only - which is to say, on a user's machine rather than on this one.
        """
        held = Instance(self.env_root)
        held.claim()
        self.addCleanup(held.release)

        lock = os.path.join(held.directory, "lock")
        self.assertGreater(os.path.getsize(lock), 0)

    def test_a_released_instance_reads_as_gone(self):
        held = Instance(self.env_root)
        held.claim()
        directory = held.directory
        self.assertTrue(is_live(directory))

        held.release()
        self.assertFalse(os.path.exists(directory), "a tidy exit removes its own directory")

    def test_release_is_idempotent(self):
        """stop() can be reached twice - a windowClose and a shutdown frame."""
        held = Instance(self.env_root)
        held.claim()
        held.release()
        held.release()

    def test_release_drops_the_lock_even_when_the_directory_cannot_go(self):
        """The lock must go even when the removal does not, or nothing collects it.

        Tested on real builds: an ordinary quit sometimes leaves the instance
        directory behind on both platforms, and the next start's sweep collects
        it. That only works because the lock is dropped unconditionally - which
        is what this asserts. The removal is best-effort and is not what makes
        the scheme correct.

        It is also why the failure is reported rather than swallowed by
        `ignore_errors=True`, which is what made the Windows half of this
        impossible to explain from the log.
        """
        held = Instance(self.env_root)
        held.claim()
        seen = []

        parent = os.path.dirname(held.directory)
        mode = os.stat(parent).st_mode
        os.chmod(parent, 0o500)
        self.addCleanup(os.chmod, parent, mode)
        try:
            held.release(on_error=lambda directory, exc: seen.append(directory))
        finally:
            os.chmod(parent, mode)

        if len(seen) == 0:
            self.skipTest("this filesystem allowed the removal anyway")
        self.assertEqual(seen, [held.directory], "the failure must be reported, not swallowed")
        self.assertFalse(is_live(held.directory), "the lock must be gone so a sweep can collect it")
        self.addCleanup(shutil.rmtree, held.directory, True)

    def test_the_paths_use_one_separator(self):
        """The env root arrives from the frontend with forward slashes.

        os.path.join then appends the platform's own, which on Windows produced
        "C:/Users/.../runtime\\instances\\<uuid>\\kernel.json" in the About
        dialog - the one field that exists to be copied into a
        `jupyter console --existing` command.
        """
        held = Instance("C:/Users/someone/AppData/Roaming/build123d-studio/runtime")
        mixed = "/" in held.connection_file and "\\" in held.connection_file
        self.assertFalse(mixed, f"both separators in {held.connection_file}")


class LivenessTest(unittest.TestCase):
    """What the operating system promises, asked of the operating system."""

    def setUp(self):
        self.env_root = tempfile.mkdtemp(prefix="instance-live-")

    def test_a_live_owner_reads_as_live_and_a_killed_one_does_not(self):
        child = claim_in_a_child(self.env_root, "owned-by-the-child")
        self.addCleanup(stop_child, child)
        directory = os.path.join(self.env_root, "instances", "owned-by-the-child")

        self.assertTrue(is_live(directory), "the child is holding its lock")

        # SIGKILL rather than a clean exit: nothing runs in the child afterwards,
        # so whatever makes this read as stale is the operating system releasing
        # the lock and not any code in instance.py.
        child.kill()
        child.wait(timeout=CLAIMED)

        self.assertFalse(is_live(directory), "a killed owner's lock must be released")

    def test_a_directory_with_no_lock_file_is_not_live(self):
        """Died between makedirs and the claim. Microseconds wide, still a state."""
        directory = os.path.join(self.env_root, "instances", "half-made")
        os.makedirs(directory)
        self.assertFalse(is_live(directory))


class SweepTest(unittest.TestCase):
    def setUp(self):
        self.env_root = tempfile.mkdtemp(prefix="instance-sweep-")

    def test_a_dead_instance_is_removed_and_a_live_one_is_left_alone(self):
        child = claim_in_a_child(self.env_root, "still-running")
        self.addCleanup(stop_child, child)

        dead = Instance(self.env_root, instance_id="crashed")
        dead.claim()
        # Drop the lock the way a crash does - the handle goes, nothing tidies up.
        dead._lock.close()
        dead._lock = None

        removed = sweep(self.env_root)

        self.assertEqual(removed, ["crashed"])
        self.assertFalse(os.path.exists(dead.directory))
        self.assertTrue(os.path.isdir(os.path.join(self.env_root, "instances", "still-running")))

    def test_the_sweep_never_removes_its_own(self):
        """Called at startup by an instance that has just claimed its directory."""
        mine = Instance(self.env_root)
        mine.claim()
        self.addCleanup(mine.release)

        removed = sweep(self.env_root, keep_id=mine.id)

        self.assertEqual(removed, [])
        self.assertTrue(os.path.isdir(mine.directory))

    def test_a_sweep_before_anything_has_ever_run_is_quiet(self):
        self.assertEqual(sweep(self.env_root), [])

    def test_a_removal_that_fails_is_reported_rather_than_swallowed(self):
        """Windows refuses to delete a live process's open file.

        That refusal is the platform offering a free consistency check on this
        function, and swallowing it would throw the check away. Driven here by
        making the directory itself unremovable, since the interesting failure
        cannot be produced on this platform.
        """
        broken = os.path.join(self.env_root, "instances", "unremovable")
        os.makedirs(broken)
        seen = []

        original = os.path.join(broken, "lock")
        with open(original, "wb") as handle:
            handle.write(b"\x00")

        # A directory whose removal raises: read-only parent on POSIX. Skipped
        # where that does not hold - running as root, or a filesystem that
        # ignores the mode - rather than asserted about.
        parent = os.path.join(self.env_root, "instances")
        mode = os.stat(parent).st_mode
        os.chmod(parent, 0o500)
        self.addCleanup(os.chmod, parent, mode)
        try:
            removed = sweep(self.env_root, on_error=lambda directory, exc: seen.append(directory))
        finally:
            os.chmod(parent, mode)

        if len(seen) == 0:
            self.skipTest("this filesystem allowed the removal anyway")
        self.assertEqual(removed, [], "a directory that could not be removed is not reported gone")
        self.assertEqual(seen, [broken])


class LegacyConnectionFileTest(unittest.TestCase):
    def setUp(self):
        self.env_root = tempfile.mkdtemp(prefix="instance-legacy-")

    def test_the_old_shared_connection_file_is_removed(self):
        """Every environment root built before this change has one.

        Left in place it is a trap rather than clutter: it is the path Phase 1
        told people to attach to, and nothing writes it any more, so it names a
        kernel that stopped days ago.
        """
        legacy = os.path.join(self.env_root, "kernel.json")
        with open(legacy, "w", encoding="utf-8") as handle:
            handle.write("{}")

        self.assertTrue(remove_legacy_connection_file(self.env_root))
        self.assertFalse(os.path.exists(legacy))

    def test_an_install_that_never_had_one_says_so(self):
        self.assertFalse(remove_legacy_connection_file(self.env_root))


if __name__ == "__main__":
    unittest.main()
