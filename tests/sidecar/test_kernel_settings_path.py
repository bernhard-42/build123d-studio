"""Where the kernel is told the settings file is.

`workspace_config()` answers from the frontend's settings.json, and the kernel
finds that file through one environment variable. It used to be derived - "the
directory above env_root" - which is true where the environment and the settings
share a parent, macOS and Linux, and false on Windows since 0.5.0 put the
environment in %LOCALAPPDATA% and left the settings in %APPDATA%. There the
kernel read a file that did not exist and answered the shipped defaults for every
setting, silently, for four releases.

So the path is given, and this holds it to exactly what it was given - with the
two directories deliberately apart, which is the shape that broke.
"""

import os
import tempfile
import unittest

from kernel import Kernel


class KernelSettingsPathTest(unittest.TestCase):
    def test_the_environment_carries_the_path_it_was_given(self):
        with tempfile.TemporaryDirectory() as local, tempfile.TemporaryDirectory() as roaming:
            env_root = os.path.join(local, "build123d-studio", "runtime")
            settings = os.path.join(roaming, "build123d-studio", "settings.json")
            kernel = Kernel(
                env_root=env_root,
                app_dir=local,
                settings_path=settings,
                connection_file=os.path.join(env_root, "kernel.json"),
                model_port=0,
                model_token="token",
                on_iopub=lambda message: None,
                on_died=lambda: None,
            )

            given = kernel.kernel_environment()["BUILD123D_STUDIO_SETTINGS"]

            self.assertEqual(given, settings)
            # The old derivation, spelled out so that its return would be
            # caught by name rather than by a Windows machine.
            derived = os.path.join(os.path.dirname(os.path.normpath(env_root)), "settings.json")
            self.assertNotEqual(given, derived)
