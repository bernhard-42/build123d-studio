"""Loads the measurement backend, on the main thread, before any other starts.

`measure` imports ocp_vscode.backend, which drags in build123d and OCP - about
2.5 seconds of native library loading on macOS, and rather more on Windows.

This used to run on a background thread, to keep those seconds off the startup
path. On Windows that deadlocks, permanently, and it took the application's
whole viewer with it.

Loading a .pyd is LoadLibrary, and LoadLibrary holds the OS loader lock while
CPython holds the GIL across the call. Starting a thread runs DLL_THREAD_ATTACH
in every loaded DLL, which wants that same loader lock. OCP is a very large
native stack - the two collided reliably. Observed on Windows: this import
entered importlib's create_module and never came out; stack dumps ninety
seconds apart were identical, and the sidecar never logged either outcome
below. Two things died with it. The measurement backend never became available,
so a measure click would have joined a thread that never finished. Worse, the
websockets server's accept loop starts a thread per incoming connection, so it
blocked in Thread.start() and stopped accepting anything at all - and
ocp_vscode's viewer discovery, which _convert() performs six times per show()
against the port we deliberately point at ourselves, then waited its full
ten-second connect timeout on every one. show(Box(1,1,1)) cost seventy seconds
of doing nothing.

So it happens here, synchronously, called first from Sidecar.start(): the
channel is already bound and the webview already connected, so nothing else in
the process is creating a thread while it runs. What it delays is the "ready"
frame, not the handshake - the frontend's 30 s handshake deadline is long past
by this point, and its wait for "ready" has a 90 s backstop.

`importlib.import_module` rather than an import statement because the module is
optional in the sense that the sidecar must survive its absence, not because
the timing is clever: a broken dependency is reported here and the rest of the
application still runs.
"""

import importlib
import threading
import time

from channel import log


class MeasurementService:
    """The Measurements instance, and the import behind it."""

    def __init__(self):
        self._module = None
        self._error = None
        self._instance = None

        # A model may be shown before the backend is asked for anything; hold
        # its mapping until there is something to give it to.
        self._pending_mapping = None

        self._lock = threading.Lock()

    def load_backend(self):
        """Import the measurement backend. Main thread, before other threads."""
        started = time.perf_counter()
        try:
            self._module = importlib.import_module("measure")
            log(f"Measurement backend loaded in {time.perf_counter() - started:.2f}s")
        except Exception as exc:  # noqa: BLE001 - report, do not take the sidecar down
            self._error = exc
            log(f"Measurement backend failed to load: {exc}")

    def _resolve(self):
        """The Measurements instance, or None if the backend did not load."""
        with self._lock:
            if self._error is not None or self._module is None:
                return None
            if self._instance is None:
                self._instance = self._module.Measurements()
                if self._pending_mapping is not None:
                    self._instance.load(self._pending_mapping)
                    self._pending_mapping = None
            return self._instance

    def load(self, mapping_bytes):
        """Take a freshly shown model's mapping."""
        with self._lock:
            if self._instance is not None:
                self._instance.load(mapping_bytes)
            else:
                self._pending_mapping = mapping_bytes

    def handle_changes(self, changes):
        instance = self._resolve()
        if instance is None:
            return None
        return instance.handle_changes(changes)
