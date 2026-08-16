"""Exact measurement, computed from the real geometry.

The viewer's measure tools work on a triangulated mesh, so anything derived
from it alone would be an approximation - a "circle" is a fan of triangles, and
its radius depends on the tessellation tolerance. `ocp_viewer_core`'s
ViewerBackend keeps the BRep shapes that produced the mesh and answers selection
queries from those instead, so a radius is the radius.

It is used unchanged now. This file used to subclass it to answer by *returning*
rather than sending, and to skip a constructor that stored a port and opened a
websocket back to a viewer - both of which the shared backend has since adopted
outright: `ViewerBackend()` takes nothing, holds no transport, and `handle_event`
returns the measurement or None. Jupyter CadQuery had always answered that way
and this host had arrived at it independently, which is what settled it.

What is left here is this host's own: when a model is indexed, which model an
answer describes, and the notification shape the frontend sends.
"""

import threading

import orjson
from ocp_viewer_core.backend import ViewerBackend

from channel import log


class ShownModel:
    """One shown model, and the index built from it on demand.

    Immutable in the sense that matters: the mapping it was constructed with
    never changes, so everything derived from it describes that one model. A
    newly shown model produces a new instance rather than mutating this one.

    That is the fix for a check-then-use spread across three fields.
    Measurements.load ran on the model socket's thread and set _mapping_bytes,
    _loaded and backend one after another, while _ensure_loaded read the same
    three on the inspect lane - and indexing is slow, because it deserialises a
    BRep per face, edge and vertex. A show() landing inside it left
    _loaded=True with backend=None, after which every measurement raised
    AttributeError for the rest of the session; the other interleaving was
    worse and quieter, answering a selection from the superseded model's
    geometry, which is the one thing this backend exists to prevent.

    Now a show() rebinds one reference. A measurement already in flight keeps
    the instance it started with and finishes describing the model that was on
    screen when the selection was made, which is the honest answer; the next one
    picks up the new model.
    """

    def __init__(self, mapping_bytes):
        self.mapping_bytes = mapping_bytes
        self._backend = None
        # The index is built once, on first use. The inspect lane is serial so
        # two callers cannot arrive together today, but the cost of being wrong
        # about that is indexing a large assembly twice.
        self._lock = threading.Lock()

    def backend(self):
        """The indexed backend for this model, building it on first use.

        Indexing is deferred rather than done at show(): load_model explodes
        every solid into its faces, edges and vertices and deserialises a BRep
        per entry, which is wasted work for the common case of looking at a
        model without ever measuring it.
        """
        with self._lock:
            if self._backend is None:
                backend = ViewerBackend()
                backend.load_model(orjson.loads(self.mapping_bytes))
                self._backend = backend
                log("Measurement model indexed")
            return self._backend


class _Loaded:
    """A backend that is already indexed, with `ShownModel`'s shape.

    So that `handle_changes` can take either without asking which it has: the
    splash is built once and never rebuilt, a shown model indexes on first use.
    """

    def __init__(self, backend):
        self._backend = backend

    def backend(self):
        return self._backend


class Measurements:
    """Owns the shown model and translates the viewer's notifications for it."""

    def __init__(self):
        self._shown = None
        # The splash, which is measurable before anything has been shown - and
        # was not, for as long as this host had a measurement backend of its
        # own. The logo is a real model with real BREP behind it, so a distance
        # across it is a distance; the shared backend loads it in `start()` for
        # exactly this, and until now nothing here called that.
        #
        # Built on demand rather than at construction: indexing it walks every
        # face, edge and vertex, and a session where nobody measures the logo -
        # which is most of them - should not pay for it.
        self._splash = None
        self._splash_lock = threading.Lock()
        # Tracked here rather than on the backend, so that a tool can be
        # activated without forcing the model to be indexed first. It belongs to
        # the session rather than to a model, which is why it survives a show().
        self._active_tool = None

    def _splash_model(self):
        """The logo, indexed, standing in for a model nobody has shown yet."""
        with self._splash_lock:
            if self._splash is None:
                backend = ViewerBackend()
                # Prints what it is doing, which reaches the Backend tab: this
                # is the one indexing pass a user did not ask for, so it should
                # say so rather than appear as a pause.
                backend.start()
                self._splash = _Loaded(backend)
            return self._splash

    def load(self, mapping_bytes):
        """Take the mapping for a freshly shown model.

        One assignment, and that is the point: there is no window in which the
        object describes a mixture of two models.
        """
        self._shown = ShownModel(mapping_bytes)

    def handle_changes(self, changes):
        """Handle a UI change notification from the viewer.

        Mirrors ViewerBackend.handle_event's UPDATES branch: a tool becomes
        active, then selections arrive and are answered while it stays active.
        """
        # Read once, used throughout. A show() arriving while this runs replaces
        # the attribute, and re-reading it halfway would be the same
        # check-then-use this class was restructured to remove.
        shown = self._shown or self._splash_model()
        if shown is None:
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
        backend = shown.backend()
        backend.activated_tool = self._active_tool

        try:
            return backend.handle_activated_tool(changes)
        except Exception as exc:  # noqa: BLE001 - a bad selection must not kill the sidecar
            log(f"Measurement failed: {exc}")
            return None
