"""Whether Linux can show a file dialog, and what the sidecar tells the window."""

import os
import tempfile
import unittest

from dialogs import HELPERS, dialog_helper
from instance import Instance
from main import Sidecar
from test_run_queue import FakeChannel


def which_from(installed):
    return lambda name: f"/usr/bin/{name}" if name in installed else None


class DialogHelperTest(unittest.TestCase):
    def test_windows_and_macos_draw_their_own(self):
        for platform in ("win32", "darwin"):
            self.assertEqual(dialog_helper(which=which_from(set()), platform=platform), "native")

    def test_linux_without_any_of_the_four_has_none(self):
        # gauss-x, elementary OS 8, before zenity was installed.
        self.assertIsNone(dialog_helper(which=which_from(set()), platform="linux"))

    def test_the_first_found_in_portable_file_dialogs_order_is_named(self):
        self.assertEqual(HELPERS, ("zenity", "matedialog", "qarma", "kdialog"))
        # singer, Ubuntu 26.04: zenity and kdialog both installed.
        self.assertEqual(dialog_helper(which=which_from({"kdialog", "zenity"}), platform="linux"), "zenity")
        self.assertEqual(dialog_helper(which=which_from({"kdialog"}), platform="linux"), "kdialog")


class AnnounceTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.mkdtemp(prefix="studio-dialogs-")
        instance = Instance(root)
        instance.claim()
        self.addCleanup(instance.release)
        self.sidecar = Sidecar(
            env_root=root, app_dir=root, instance=instance, settings_path=os.path.join(root, "settings.json")
        )
        self.channel = FakeChannel()
        self.sidecar.channel = self.channel

    def test_no_program_tells_the_window(self):
        self.sidecar.announce_file_dialogs(None)
        self.assertEqual(self.channel.sent, [("dialogs.missing", {})])

    def test_a_program_or_the_systems_own_says_nothing_to_it(self):
        for helper in ("zenity", "native"):
            self.sidecar.announce_file_dialogs(helper)
        self.assertEqual(self.channel.sent, [])


if __name__ == "__main__":
    unittest.main()
