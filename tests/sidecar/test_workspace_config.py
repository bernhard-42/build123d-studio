"""What this host answers when the shared show pipeline asks for its settings.

`workspace_config()` is the top layer of the four the core merges - the
persistent one, which Python cannot know by itself - and every host answers the
*whole* set: OCP CAD Viewer for VS Code its settings section, the standalone
`~/.ocpvscode_standalone`, Jupyter CadQuery `~/.jcq_config`, and this host its
Viewer tab.

Answering only the changed part is what went wrong: a key that is left out is
not "use the default", it is a key three-cad-viewer never hears about, so the
value it already holds survives - and after startup that is the splash logo's
own configuration. `ortho=False` and `grid=(True, False, False)` from the logo
were still in force after the first `show()`.
"""

import json
import os
import tempfile
import unittest

from build123d_studio import settings


def with_settings(values):
    """A settings.json holding `values`, as the frontend writes it."""
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(values, handle)
    handle.close()
    return handle.name


class WorkspaceConfigTest(unittest.TestCase):
    def tearDown(self):
        for path in getattr(self, "_paths", []):
            os.unlink(path)

    def settings_file(self, values):
        path = with_settings(values)
        self._paths = getattr(self, "_paths", []) + [path]
        return path

    def test_the_whole_set_is_answered_even_with_nothing_stored(self):
        config = settings.workspace_config(path="/nonexistent")
        # The dialog's 36, in the renderer's vocabulary: the three grid planes
        # and `orbit_control` are spent on `grid` and `control`, and `theme`
        # comes from the top level - 36 - 4 + 2 + 1. The transport adds
        # `_splash`, which makes 36 on the wire, the same count the other three
        # hosts answer.
        self.assertEqual(len(config), 35)
        for key in ("ortho", "grid", "axes", "control", "collapse", "theme", "metalness"):
            self.assertIn(key, config)

    def test_the_defaults_are_the_shipped_ones(self):
        config = settings.workspace_config(path="/nonexistent")
        self.assertEqual(config["ortho"], True)
        self.assertEqual(config["grid"], [False, False, False])
        self.assertEqual(config["collapse"], "leaves")
        self.assertEqual(config["reset_camera"], "KEEP")
        self.assertEqual(config["tree_width"], 240)

    def test_a_stored_value_replaces_its_default(self):
        path = self.settings_file({"viewer": {"ticks": 10, "ortho": False}})
        config = settings.workspace_config(path=path)
        self.assertEqual(config["ticks"], 10)
        self.assertEqual(config["ortho"], False)
        self.assertEqual(config["axes"], False, "an untouched setting keeps its default")

    def test_orbit_control_becomes_a_word(self):
        """A checkbox here, a string on the wire - and a boolean reaching the
        renderer's `switch` crashed its controls when this went wrong once."""
        self.assertEqual(settings.workspace_config(path="/nonexistent")["control"], "trackball")
        path = self.settings_file({"viewer": {"orbit_control": True}})
        config = settings.workspace_config(path=path)
        self.assertEqual(config["control"], "orbit")
        self.assertNotIn("orbit_control", config)

    def test_the_three_planes_become_one_triple_in_XY_XZ_YZ_order(self):
        """The order is the renderer's and it is not alphabetical: the second
        element is XZ. The VS Code extension assembles it the same way."""
        path = self.settings_file({"viewer": {"grid_XZ": True}})
        config = settings.workspace_config(path=path)
        self.assertEqual(config["grid"], [False, True, False])
        for plane in ("grid_XY", "grid_XZ", "grid_YZ"):
            self.assertNotIn(plane, config)

    def test_the_theme_is_the_applications_own_setting(self):
        """It paints the editor and the panes too, so it lives at the top level
        rather than among the viewer's, and "system" is the renderer's
        "browser" - which it resolves against the surface itself."""
        self.assertEqual(settings.workspace_config(path="/nonexistent")["theme"], "browser")
        path = self.settings_file({"theme": "dark", "viewer": {}})
        self.assertEqual(settings.workspace_config(path=path)["theme"], "dark")

    def test_an_unknown_stored_key_is_ignored(self):
        """A settings file is a user's to edit. A key the schema does not know
        must not reach the viewer, which would drop it without a word."""
        path = self.settings_file({"viewer": {"nonsense": 1}})
        self.assertNotIn("nonsense", settings.workspace_config(path=path))

    def test_a_damaged_settings_file_answers_rather_than_raises(self):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        handle.write("{ not json")
        handle.close()
        self._paths = getattr(self, "_paths", []) + [handle.name]
        config = settings.workspace_config(path=handle.name)
        self.assertEqual(config["ortho"], True)

    def test_splash_is_not_here(self):
        """It is not persistent and this process cannot know it - whether the
        logo is still on screen is the frontend's fact. The transport asks."""
        self.assertNotIn("_splash", settings.workspace_config(path="/nonexistent"))


if __name__ == "__main__":
    unittest.main()
