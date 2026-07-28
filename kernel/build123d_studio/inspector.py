"""Namespace inspection for the variable explorer.

Runs inside the kernel, called through `user_expressions` on a silent
execute_request - so nothing here ever appears in the console transcript or
moves the In[n] counter.

Two rules shape it:

* Listing must stay cheap. It runs after every execution, on every name in the
  namespace, so it only reads what is already there - type, length, a short
  repr. Nothing that computes geometry.
* Anything expensive is opt-in. Volume and area of a build123d object mean real
  work in OCCT, so they are computed only when a row is expanded.
"""

import sys
import types

# Names that are always noise in this context: IPython's own machinery and the
# modules the app pre-imports to make the first run fast.
HIDDEN = {
    "In",
    "Out",
    "exit",
    "quit",
    "open",
    "get_ipython",
    "show",
    "show_object",
    "show_clear",
    "reset_show",
}

MAX_REPR = 120
MAX_CHILDREN = 200


def _short_repr(value):
    try:
        text = repr(value)
    except Exception as exc:  # noqa: BLE001 - a broken __repr__ must not break the pane
        return f"<unrepresentable: {exc.__class__.__name__}>"
    text = " ".join(text.split())
    if len(text) > MAX_REPR:
        return text[: MAX_REPR - 1] + "…"
    return text


def _size_of(value):
    """A length if the object has a cheap one, otherwise None."""
    try:
        if isinstance(value, (str, bytes)):
            return len(value)
        if isinstance(value, (list, tuple, set, frozenset, dict)):
            return len(value)
        shape = getattr(value, "shape", None)
        if shape is not None and isinstance(shape, tuple):
            return "×".join(str(n) for n in shape)
    except Exception:  # noqa: BLE001
        return None
    return None


# Modules whose contents commonly arrive by `from x import *`. A star-import of
# build123d alone adds some sixty classes, enums and unit constants, which would
# bury the handful of names the user actually created.
LIBRARY_MODULES = (
    "build123d",
    "build123d_studio",
    "ocp_vscode",
    "ocp_tessellate",
    "numpy",
    "math",
)

_MISSING = object()


def _from_library(name, value):
    """True if this name is the very object a known library exports.

    Compared by identity rather than by name, so a variable that merely shadows
    a library name - `part = ...` over build123d's `part` - is still shown.
    """
    for module_name in LIBRARY_MODULES:
        module = sys.modules.get(module_name)
        if module is None:
            continue
        if getattr(module, name, _MISSING) is value:
            return True
    return False


def _is_interesting(name, value):
    if name.startswith("_") or name in HIDDEN:
        return False

    if isinstance(value, types.ModuleType):
        return False

    # Classes and functions are shown only when the user defined them here;
    # imported ones are library surface, not data.
    if isinstance(value, type) or isinstance(
        value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)
    ):
        return getattr(value, "__module__", None) == "__main__"

    return not _from_library(name, value)


def variables():
    """One row per user variable. Cheap: no geometry is evaluated."""
    namespace = sys.modules["__main__"].__dict__
    rows = []
    for name, value in list(namespace.items()):
        if not _is_interesting(name, value):
            continue
        rows.append(
            {
                "name": name,
                "type": type(value).__name__,
                "module": type(value).__module__.split(".")[0],
                "size": _size_of(value),
                "repr": _short_repr(value),
            }
        )
    rows.sort(key=lambda row: row["name"].lower())
    return rows


def _build123d_details(value):
    """Geometry facts, computed on demand only."""
    details = {}
    for label, attribute in (
        ("volume", "volume"),
        ("area", "area"),
    ):
        try:
            result = getattr(value, attribute, None)
            if isinstance(result, (int, float)):
                details[label] = round(float(result), 6)
        except Exception:  # noqa: BLE001
            pass

    try:
        box = value.bounding_box()
        details["bbox min"] = [round(v, 6) for v in (box.min.X, box.min.Y, box.min.Z)]
        details["bbox max"] = [round(v, 6) for v in (box.max.X, box.max.Y, box.max.Z)]
    except Exception:  # noqa: BLE001
        pass

    for label, attribute in (("faces", "faces"), ("edges", "edges"), ("vertices", "vertices")):
        try:
            items = getattr(value, attribute, None)
            if callable(items):
                details[f"# {label}"] = len(items())
        except Exception:  # noqa: BLE001
            pass

    return details


def detail(name):
    """Expand one variable. This is where the expensive work is allowed."""
    namespace = sys.modules["__main__"].__dict__
    if name not in namespace:
        return {"name": name, "error": "no longer defined"}

    value = namespace[name]
    result = {"name": name, "type": type(value).__name__, "attributes": {}}

    if isinstance(value, dict):
        result["children"] = [
            {"name": str(k), "type": type(v).__name__, "repr": _short_repr(v)}
            for k, v in list(value.items())[:MAX_CHILDREN]
        ]
    elif isinstance(value, (list, tuple, set, frozenset)):
        result["children"] = [
            {"name": str(i), "type": type(v).__name__, "repr": _short_repr(v)}
            for i, v in enumerate(list(value)[:MAX_CHILDREN])
        ]
    else:
        result["attributes"] = _build123d_details(value)

    return result
