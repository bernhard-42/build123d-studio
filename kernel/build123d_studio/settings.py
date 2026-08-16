"""The persistent half of a show's configuration: this host's Viewer settings.

`workspace_config()` is the top-level layer of the four the shared core merges,
and the only one Python cannot know by itself:

    the workspace config   ← this file: what the Settings dialog persists
      ← the viewer's live state, unless the splash logo is up
        ← whatever `set_defaults()` was told
          ← the keywords of this `show()`

So it must answer **every** setting, not only the ones a user has changed - the
same as OCP CAD Viewer for VS Code answering every key of its settings section,
Jupyter CadQuery answering all of `~/.jcq_config`, and the standalone all of
`~/.ocpvscode_standalone`. A setting left out is not "use the default": it is a
key three-cad-viewer never hears about, so whatever the viewer already holds
stays - and after startup what it holds is the splash logo's own configuration.

`settings.json` therefore stores only what differs from the defaults, exactly as
VS Code's does, and the defaults are read from `viewer_defaults.json` beside
this file. That file is the one source for both halves of the application: the
Settings dialog draws its controls from it, and this assembles the answer from
it, so 36 numbers are written down once.
"""

import json
import os

DEFAULTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "viewer_defaults.json")

ENV_SETTINGS = "BUILD123D_STUDIO_SETTINGS"

# The three grid planes are one setting to the renderer, and the order is its
# own rather than alphabetical: the second element is XZ. The VS Code extension
# assembles the same triple in the same order (`src/controller.ts`).
GRID_PLANES = ("grid_XY", "grid_XZ", "grid_YZ")


def _read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        # No file yet on a first run, or one damaged by hand. Neither is worth
        # failing a show over, and the defaults are what a first run gets.
        return fallback
    return value if isinstance(value, type(fallback)) else fallback


def defaults():
    """What the viewer does when nothing has been set."""
    return _read_json(DEFAULTS_FILE, {})


def stored(path=None):
    """The Viewer settings a user has changed, and the application's theme."""
    settings_path = os.environ.get(ENV_SETTINGS) if path is None else path
    if settings_path is None:
        return {}, "system"
    values = _read_json(settings_path, {})
    viewer = values.get("viewer")
    theme = values.get("theme")
    return (
        viewer if isinstance(viewer, dict) else {},
        theme if isinstance(theme, str) else "system",
    )


def workspace_config(path=None):
    """Every viewer setting this host persists, in the viewer's own vocabulary.

    Two values are converted rather than passed through, and both the same way
    the VS Code extension converts them, because the vocabulary belongs to the
    wire and not to a settings file:

    * `orbit_control`, a checkbox, is the renderer's `control`, a word;
    * the three grid planes are one `[XY, XZ, YZ]` triple.

    `theme` is the application's own setting rather than one of the viewer's -
    it paints the editor and the panes too - so it is stored at the top level
    and mapped here: "system" is the renderer's "browser", which it resolves
    against the surface itself.

    `_splash` is deliberately not here. It is not persistent and this process
    cannot know it: whether the logo is still on screen is the frontend's fact,
    and a second process - a Run File, a debuggee - would guess it wrong. The
    transport asks for it.
    """
    viewer, theme = stored(path)

    config = dict(defaults())
    config.update({key: value for key, value in viewer.items() if key in config})

    config["control"] = "orbit" if config.pop("orbit_control", False) else "trackball"
    config["grid"] = [bool(config.pop(plane, False)) for plane in GRID_PLANES]
    config["theme"] = "browser" if theme == "system" else theme

    return config
