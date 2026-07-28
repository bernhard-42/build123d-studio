"""Exact measurement, computed from the real geometry.

The viewer's measure tools work on a triangulated mesh, so anything derived
from it alone would be an approximation - a "circle" is a fan of triangles, and
its radius depends on the tessellation tolerance. ocp_vscode solves this with
ViewerBackend: it keeps the BRep shapes that produced the mesh and answers
selection queries from those instead, so a radius is the radius.

That class is reused here as-is for the part that matters - load_model(), which
walks the model and indexes every face, edge and vertex by the same ids the
viewer uses - and subclassed to return responses rather than send them.

The base class already has a return mode, but it is gated on a JUPYTER_CADQUERY
environment variable that also rewires ocp_vscode's imports at module scope.
That integration is known tech debt upstream, so build123d-studio overrides the two
handlers instead of switching it on.
"""

import orjson
from ocp_vscode.backend import Tool, ViewerBackend
from ocp_vscode.measure import get_distance, get_properties

from channel import log


class MeasurementBackend(ViewerBackend):
    """ViewerBackend that answers in-process."""

    def __init__(self):
        # Deliberately not calling super().__init__: it only stores a port and
        # calls comms.set_port() to prepare a websocket back to a viewer, and
        # there is no websocket here - the answer is returned to the caller.
        self.port = None
        self.model = None
        self.activated_tool = None
        self.filter_type = "none"
        self.jcv_id = None

    def handle_properties(self, shape_id):
        """Volume, area, centre and so on for one selected shape."""
        shape = self.model[shape_id]
        response = get_properties(shape)
        response["type"] = "backend_response"
        response["subtype"] = "tool_response"
        response["tool_type"] = Tool.Properties
        return response

    def handle_distance(self, id1, id2, center):
        """Exact distance between two selected shapes."""
        shape1 = self.model[id1]
        shape2 = self.model[id2]
        response = get_distance(shape1, shape2, center)
        response["type"] = "backend_response"
        response["subtype"] = "tool_response"
        response["tool_type"] = Tool.Distance
        return response


class Measurements:
    """Owns the backend and translates the viewer's notifications for it."""

    def __init__(self):
        self.backend = None
        self._mapping_bytes = None
        self._loaded = False
        # Tracked here rather than on the backend, so that a tool can be
        # activated without forcing the model to be indexed first.
        self._active_tool = None

    def load(self, mapping_bytes):
        """Take the mapping for a freshly shown model.

        Only stored here. Both the JSON parse and the model walk are deferred
        to the first measurement: load_model explodes every solid into its
        faces, edges and vertices and deserialises a BRep per entry, which is
        wasted work for the common case of looking at a model without ever
        measuring it.
        """
        self._mapping_bytes = mapping_bytes
        self._loaded = False
        self.backend = None

    def _ensure_loaded(self):
        if self._loaded:
            return
        if self.backend is None:
            self.backend = MeasurementBackend()
        self.backend.load_model(orjson.loads(self._mapping_bytes))
        self._loaded = True
        log("Measurement model indexed")

    def handle_changes(self, changes):
        """Handle a UI change notification from the viewer.

        Mirrors ViewerBackend.handle_event's UPDATES branch: a tool becomes
        active, then selections arrive and are answered while it stays active.
        """
        if self._mapping_bytes is None:
            return None

        if "activeTool" in changes:
            tool = changes.get("activeTool")
            self._active_tool = None if tool in (None, "None") else tool

        if self._active_tool is None:
            return None

        # Indexing happens when a measure tool is switched on - a deliberate
        # user action - rather than on show(). Rendering fires plenty of
        # notifications, and indexing on those would deserialise a BRep per
        # face, edge and vertex of every model ever shown, in sessions that
        # never measure anything. Doing it at activation rather than at the
        # first click also means that first click answers immediately.
        self._ensure_loaded()
        self.backend.activated_tool = self._active_tool

        try:
            return self.backend.handle_activated_tool(changes)
        except Exception as exc:  # noqa: BLE001 - a bad selection must not kill the sidecar
            log(f"Measurement failed: {exc}")
            return None
