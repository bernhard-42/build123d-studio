"""build123d-studio's kernel-side API: show() and friends.

The tessellation itself is ocp_vscode's - ``_convert`` does the real work of
turning build123d objects into meshes, and reimplementing it would be pointless
duplication. What is replaced is only the delivery: ocp_vscode ends in
``send_data``/``send_backend``, which open a websocket to a fixed port, and this
package writes to the application's local socket instead.

The signatures mirror ocp_vscode's, so ``show(part)`` and the usual keyword
arguments behave the way they do everywhere else in these tools.
"""

import os
import warnings

from ocp_vscode.comms import set_port

# Import _convert by name rather than reaching for it through the module:
# ocp_vscode/__init__.py exports a show() *function*, which shadows the
# ocp_vscode.show submodule, so `ocp_vscode.show._convert` fails.
#
# Guarded, because _convert is private and is the one function this whole
# package rests on. ocp_vscode is pinned for exactly that reason, but the config
# dialog exists to unpin *neighbouring* packages and a pin does move eventually;
# when it does, this should say so rather than surface as an ImportError from a
# module nobody expects to be importing ocp_vscode internals. The failure is
# deliberately deferred to the first show(): the sidecar imports this package
# during warm-up, and refusing there would take out a session that can still
# edit, run code and use the console perfectly well.
try:
    from ocp_vscode.show import _convert, reset_show, show_clear  # noqa: F401 - re-exported

    _INCOMPATIBLE = None
    for _name in ("_convert", "reset_show", "show_clear"):
        if not callable(locals()[_name]):
            _INCOMPATIBLE = f"ocp_vscode.show.{_name} is not callable"
            break
except ImportError as _exc:  # pragma: no cover - depends on the installed ocp_vscode
    _convert = reset_show = show_clear = None
    _INCOMPATIBLE = str(_exc)

from ocp_vscode.utils import CommsWarning

# Settle the port up front.
#
# ocp_vscode's get_port() otherwise runs viewer discovery on first use and then
# set_connection_file(), which probes the kernel's iopub *TCP* port - and this
# kernel speaks over Unix sockets, so the probe fails and it prints an alarming
# "Jupyter kernel not responding". Calling set_port() marks discovery as done,
# so neither runs. The port itself is one the sidecar owns and refuses; see
# Kernel.kernel_environment for why it is pointed there.
_ISOLATION_PORT = os.environ.get("OCP_PORT")
if _ISOLATION_PORT is not None and _ISOLATION_PORT.isdigit():
    set_port(int(_ISOLATION_PORT))

# _convert() still tries to read viewer settings over that socket and falls back
# to its defaults when refused, which is exactly what build123d-studio wants - the viewer
# is the pane above, not an ocp_vscode instance. Both complaints it makes on the
# way are noise here:
#
#   * CommsWarning - "cannot connect to the viewer", by design;
#   * "Unknown collapse value" - ocp_vscode's own offline fallback puts a
#     Collapse enum where status() expects the wire value, so it warns about
#     its own default (config.py:688-693). Worth fixing upstream.
warnings.filterwarnings("ignore", category=CommsWarning)
warnings.filterwarnings("ignore", message="Unknown collapse value from viewer")

from .buffers import split_buffers
from .transport import NotConnected, send_model

__all__ = ["show", "show_object", "reset_show", "show_clear", "NotConnected"]


def _require_ocp_vscode():
    """Fail with an explanation rather than an AttributeError on None."""
    if _INCOMPATIBLE is not None:
        raise RuntimeError(
            "This ocp_vscode is not compatible with build123d Studio: "
            f"{_INCOMPATIBLE}. show() tessellates through ocp_vscode.show._convert(), "
            "a private function, which is why ocp_vscode is pinned in the "
            "application's runtime. Reinstall the environment, or report this "
            "against the build123d Studio release you are running."
        )


def _deliver(converted, mapping):
    """Split the buffers out of a converted model and send it."""
    # _convert returns ({"data", "type", "config", "count"}, mapping) with the
    # arrays already base64-wrapped by numpy_to_buffer_json.
    payload_free, payload = split_buffers(converted.get("data"))

    header = {
        "type": converted.get("type", "data"),
        "config": converted.get("config", {}),
        "count": converted.get("count"),
        "data": payload_free,
    }
    send_model(header, mapping, payload)


def show(*cad_objs, **kwargs):
    """Tessellate objects and display them in the build123d-studio viewer pane."""
    _require_ocp_vscode()
    converted, mapping = _convert(*cad_objs, **kwargs)
    _deliver(converted, mapping)


def show_object(obj, name=None, options=None, parent=None, clear=False, **kwargs):
    """CQ-editor compatible entry point, as ocp_vscode provides."""
    _require_ocp_vscode()
    names = None if name is None else [name]
    if options is not None:
        kwargs = {**options, **kwargs}
    objects = [obj] if parent is None else [parent, obj]
    if clear:
        reset_show()
    converted, mapping = _convert(*objects, names=names, **kwargs)
    _deliver(converted, mapping)


# show_all() is deliberately absent for now. ocp_vscode's version walks the
# caller's namespace with type checks that are worth reusing rather than
# reinventing badly; it will be wired up the same way show() is.
