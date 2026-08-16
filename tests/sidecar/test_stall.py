"""The watch that turns a stall into a sentence.

Written against the afternoon it exists for: a warm-up that logged "started" and
never logged anything else, everything queued behind it, and a diagnosis that
came from timestamps and a `sample` of the process. What is held here is that
the log stops being silent, that it stays silent when nothing is wrong, and that
it keeps talking while a stall continues - because one report cannot say whether
a queue is growing.
"""

import time
import unittest

from stall import StallWatch


class StallWatchTest(unittest.TestCase):
    def setUp(self):
        self.said = []

    def watch(self, what="Something", describe=lambda: "the picture", first=0.05, repeat=0.05):
        return StallWatch(what, describe, self.said.append, first=first, repeat=repeat)

    def test_it_says_nothing_when_the_thing_arrives(self):
        # The common case, and the one that has to cost nothing: every execute
        # and every warm-up comes through here.
        watch = self.watch(first=5).start()
        watch.finish()
        time.sleep(0.2)
        self.assertEqual(self.said, [])

    def test_it_reports_with_the_picture_when_the_thing_is_late(self):
        self.watch().start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(self.said) == 0:
            time.sleep(0.01)

        self.assertEqual(len(self.said), 1, self.said)
        self.assertIn("Something", self.said[0])
        self.assertIn("the picture", self.said[0])

    def test_it_keeps_saying_it_and_asks_again_each_time(self):
        # Each report describes the process *now*: a queue that is growing and
        # one that is stuck are the same single sample and different sequences.
        answers = iter(["first", "second", "third", "later", "later", "later"])
        self.watch(describe=lambda: next(answers)).start()

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(self.said) < 2:
            time.sleep(0.01)

        self.assertGreaterEqual(len(self.said), 2, self.said)
        self.assertIn("first", self.said[0])
        self.assertIn("second", self.said[1])

    def test_the_end_is_reported_only_if_the_start_was(self):
        watch = self.watch().start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(self.said) == 0:
            time.sleep(0.01)
        watch.finish()

        self.assertIn("finished after", self.said[-1])

    def test_a_description_that_raises_is_reported_rather_than_lost(self):
        # It runs on a timer thread, where an exception goes nowhere at all -
        # and it is asked precisely when the process is in a state nobody
        # anticipated.
        def broken():
            raise RuntimeError("no idea")

        self.watch(describe=broken).start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(self.said) == 0:
            time.sleep(0.01)

        self.assertEqual(len(self.said), 1, self.said)
        self.assertIn("no idea", self.said[0])

    def test_finishing_twice_is_harmless(self):
        watch = self.watch(first=5).start()
        watch.finish()
        watch.finish()
        self.assertEqual(self.said, [])


if __name__ == "__main__":
    unittest.main()
