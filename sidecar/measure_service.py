"""Keeps the measurement backend's import off the startup path.

`measure` imports ocp_vscode.backend, which drags in build123d and OCP - about
2.5 seconds of native library loading. With that at the top of main.py the
sidecar could not bind its socket until it finished, so the app's Run actions
stayed dead for the first few seconds after launch.

This is *not* a lazy import in the sense the project rule forbids. The module is
loaded unconditionally, at startup, from one documented place; it simply happens
on a background thread instead of on the one that answers the webview. A broken
dependency still surfaces at launch, in the log, rather than on first use. The
alternative - importing on first measurement - would move the whole 2.5 seconds
onto the user's first click, which is exactly what we are avoiding.

`importlib.import_module` rather than an import statement because the point is
*where the work happens*, and an import statement here would run on the main
thread at module load, which is the thing being avoided.
"""

import importlib
import threading
import time

from channel import log


class MeasurementService:
    """The Measurements instance, plus the deferred import behind it."""

    def __init__(self):
        self._module = None
        self._error = None
        self._instance = None

        # A model may be shown before the import lands; hold its mapping until
        # there is something to give it to.
        self._pending_mapping = None

        self._lock = threading.Lock()
        self._thread = threading.Thread(
            target=self._load, name="measure-import", daemon=True
        )

    def start(self):
        self._thread.start()

    def _load(self):
        started = time.perf_counter()
        try:
            self._module = importlib.import_module("measure")
            log(f"Measurement backend loaded in {time.perf_counter() - started:.2f}s")
        except Exception as exc:  # noqa: BLE001 - report, do not take the sidecar down
            self._error = exc
            log(f"Measurement backend failed to load: {exc}")

    def _resolve(self):
        """The Measurements instance, waiting for the import if it is still running.

        Normally a no-op: the import finishes during startup, and a measurement
        needs a model, which needs a kernel run first. The join only matters if
        something measures unusually early, and then it waits for the remainder
        rather than starting the import from scratch.
        """
        self._thread.join()

        with self._lock:
            if self._error is not None:
                return None
            if self._instance is None:
                self._instance = self._module.Measurements()
                if self._pending_mapping is not None:
                    self._instance.load(self._pending_mapping)
                    self._pending_mapping = None
            return self._instance

    def load(self, mapping_bytes):
        """Take a freshly shown model's mapping. Never waits for the import."""
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
