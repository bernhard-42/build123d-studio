"""build123d Studio's kernel-side API: show() and friends.

This host is a transport and a settings source. Everything above that - the
show family, the configuration semantics, the tessellation, the camera policy,
the measurement backend - is `ocp_viewer_core`, shared with OCP CAD Viewer for
VS Code, the standalone viewer and Jupyter CadQuery, so that the same script
behaves the same way in all four.

`from build123d_studio import show` sits beside `from ocp_vscode import show`
and `from ocp_viewer import show`. Per-host imports, deliberately: a single
universal import with the host discovered at runtime makes cross-talk
representable, and there is a receipt - with a VS Code viewer on the default
port, this application's `show()` once silently drew into *that* viewer.

The names below are bound methods off one `Viewer` and one `Config`, never
`partial` and never `@wraps`: a bound method hovers with the full signature,
`self` gone and `config` invisible, which is what gives 90 keyword parameters
working completion in the editor.
"""

from ocp_tessellate.cad_objects import ImageFace
from ocp_viewer_core.colors import BaseColorMap, ColorMap, web_to_rgb
from ocp_viewer_core.selectors import (
    select_edge,
    select_edges,
    select_face,
    select_faces,
    select_vertex,
    select_vertices,
)
from ocp_viewer_core.comms import Session
from ocp_viewer_core.config import (
    AnalysisTool,
    Camera,
    Collapse,
    Config,
    Render,
    StudioBackground,
    StudioEnvironment,
    StudioTextureMapping,
    StudioToneMapping,
    UiTab,
)
from ocp_viewer_core.show import Viewer, ignore_camera_warnings, none_filter

from .comms import StudioComms
from .transport import NotConnected

__all__ = [
    "Animation",
    "AnalysisTool",
    "ImageFace",
    "select_edge",
    "select_edges",
    "select_face",
    "select_faces",
    "select_vertex",
    "select_vertices",
    "BaseColorMap",
    "Camera",
    "Collapse",
    "ColorMap",
    "NotConnected",
    "Render",
    "StudioBackground",
    "StudioEnvironment",
    "StudioTextureMapping",
    "StudioToneMapping",
    "UiTab",
    "combined_config",
    "get_colormap",
    "get_default",
    "get_defaults",
    "get_last_paths",
    "ignore_camera_warnings",
    "none_filter",
    "push_object",
    "remove_object",
    "reset_defaults",
    "reset_show",
    "save_screenshot",
    "set_colormap",
    "set_defaults",
    "set_viewer_config",
    "show",
    "show_all",
    "show_clear",
    "show_object",
    "show_objects",
    "status",
    "unset_colormap",
    "web_to_rgb",
    "workspace_config",
]

# The keywords that belong to other hosts. The show signature is the superset of
# every client's, so a key one host owns is a key another has to refuse - and
# refusing it by name is what tells a user their `anchor=` went nowhere instead
# of leaving them to wonder.
#
# `cad_width` and `height` are the pane's, decided by the layout and the
# splitter rather than by a caller; `viewer`, `anchor` and `pinning` name a
# notebook sidecar this host does not have; and `port` addresses one viewer
# among several, where this application has exactly one and reaches it over a
# socket whose port the sidecar assigns.
EXCLUDE_KEYS = ("cad_width", "height", "viewer", "anchor", "pinning", "port")

comms = StudioComms()
session = Session(comms)
config = Config(session, EXCLUDE_KEYS)

# `None` is the handle type: the viewer is the pane above the editor and hands
# nothing back, so `show` returns None here as it does in ocp_vscode.
viewer = Viewer[None](config)

show = viewer.show
show_object = viewer.show_object
show_objects = viewer.show_objects
show_all = viewer.show_all
show_clear = viewer.show_clear
push_object = viewer.push_object
remove_object = viewer.remove_object
reset_show = viewer.reset_show
save_screenshot = viewer.save_screenshot

get_colormap = viewer.get_colormap
set_colormap = viewer.set_colormap
unset_colormap = viewer.unset_colormap
get_last_paths = viewer.get_last_paths

# The core's Animation, bound like the show family: `Animation()` constructs
# an animation over this viewer's last show.
Animation = viewer.animation

set_defaults = config.set_defaults
get_defaults = config.get_defaults
get_default = config.get_default
reset_defaults = config.reset_defaults
set_viewer_config = config.set_viewer_config
status = config.status
workspace_config = config.workspace_config
combined_config = config.combined_config
