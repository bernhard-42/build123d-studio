"""Namespace inspection for the variable explorer.

Runs inside the kernel, called through `user_expressions` on a silent
execute_request - so nothing here ever appears in the console transcript or
moves the In[n] counter.

Three rules shape it:

* Listing must stay cheap. It runs after every execution, on every name in the
  namespace, so it only reads what is already there - type, length, a short
  repr. Nothing that computes geometry.
* Expanding a row may do a little more work, but only a little. It is one
  click, the user cannot see what it will cost, and the cost scales with their
  model - so what a click can buy is bounded, and what does not fit is
  reported as missing rather than waited for.
* Anything genuinely expensive is not offered at all. Measured on a suspension
  assembly, and none of it cached: bounding_box() 19.1 s, volume 2.8 s, area
  2.2 s, the topology counts 0.8 s together. The first exceeded the sidecar's
  whole inspection budget and hung the pane; the next two are five seconds
  after a click. They belong in the console, where the user asks for them and
  can see what they cost. See _build123d_details.

Everything crossing back to the sidecar goes as a JSON string, never as a
Python object. user_expressions results are rendered by IPython's pretty
printer, which truncates any sequence at 1000 items by emitting a literal
"...", and ast.literal_eval on the far side happily reads that as Ellipsis -
which json.dumps then refuses, on every idle, for ever. Reproduced against the
pinned environment: 1200 rows in, 1001 out, the last one Ellipsis. A single
string has nothing for the printer to truncate.
"""

import json
import reprlib
import sys
import time
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

# Rows past this are summarised rather than sent. A namespace with thousands of
# names is a star-import, not something anyone reads down; the count says so in
# one line and the pane stays usable.
MAX_ROWS = 500

# How long one expansion may spend computing geometry. The sidecar gives an
# inspection fifteen seconds, so this has to leave room for the reply to be
# built and sent, and for anything already queued on the kernel's serial shell
# channel to clear.
DETAIL_BUDGET = 8.0


_REPR = reprlib.Repr()
_REPR.maxstring = MAX_REPR
_REPR.maxother = MAX_REPR
_REPR.maxlist = 8
_REPR.maxtuple = 8
_REPR.maxset = 8
_REPR.maxfrozenset = 8
_REPR.maxdict = 6
_REPR.maxarray = 8
_REPR.maxlevel = 3


def _short_repr(value):
    """A one-line repr, without building a huge one first.

    reprlib rather than repr(): repr() on a large list materialises the whole
    string - hundreds of megabytes for something with a million elements - and
    then this used to throw all but 120 characters of it away. reprlib stops
    early, so the cost is bounded by what is kept rather than by what exists.

    The build123d objects this pane is mostly used on have short reprs, so the
    difference does not show there. It shows on the numpy array or the list of
    points beside them, which is exactly the sort of thing a CAD script makes.
    """
    try:
        text = _REPR.repr(value)
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
    """One row per user variable, as a JSON string. No geometry is evaluated.

    A string rather than a list, because a list is rendered by IPython's pretty
    printer on the way out and truncated at 1000 items with a literal "..." -
    which the sidecar's literal_eval reads as Ellipsis and json.dumps then
    refuses, silently, on every idle from then on.
    """
    namespace = sys.modules["__main__"].__dict__
    rows = []
    for name, value in list(namespace.items()):
        # str(), because a namespace key need not be one: globals()[42] = x is
        # legal and made name.startswith("_") raise, which killed the refresh
        # exactly as quietly as the Ellipsis did.
        name = str(name)
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

    if len(rows) > MAX_ROWS:
        hidden = len(rows) - MAX_ROWS
        rows = rows[:MAX_ROWS]
        # An explicit row rather than silent truncation: a pane that stops at
        # five hundred without saying so is indistinguishable from one that has
        # lost the rest.
        rows.append({
            "name": f"… {hidden} more",
            "type": "",
            "module": "",
            "size": None,
            "repr": "not shown",
        })
    return json.dumps(rows)


def _build123d_details(value):
    """Facts about a shape that are cheap enough for a click.

    Three measurements on a suspension assembly decided what is here, and all
    three are per-expansion - OCCT caches none of them, so a second look costs
    the same as the first:

        bounding_box()  19.1 s
        volume           2.8 s
        area             2.2 s
        faces/edges/vertices, together   0.8 s

    So only the counts remain. bounding_box() alone exceeded the sidecar's
    fifteen-second inspection budget, which is what made the pane say "loading"
    for ever; volume and area were another five seconds between them, and five
    seconds after a click is not a pane anyone would call working. The counts
    describe the shape well enough to tell two versions of a model apart, which
    is what this pane is for.

    What is gone is not lost, only no longer automatic: rc.volume in the console
    answers in under three seconds, on request, where the cost is visible and
    the user has asked for it. The viewer already shows the extent that
    bounding_box() would report, and show() prints it.

    The budget stays even though everything left is well inside it. These are
    other people's objects and the next one may not be a Compound - a property
    that runs a solver, or a __getattr__ that does something expensive, costs
    nothing to bound and would otherwise be the same bug again.
    """
    details = {}
    deadline = time.monotonic() + DETAIL_BUDGET
    skipped = []

    for label, attribute in (("faces", "faces"), ("edges", "edges"), ("vertices", "vertices")):
        if time.monotonic() >= deadline:
            skipped.append(f"# {label}")
            continue
        try:
            items = getattr(value, attribute, None)
            if callable(items):
                details[f"# {label}"] = len(items())
        except Exception:  # noqa: BLE001
            pass

    if len(skipped) > 0:
        # Named rather than dropped: a fact that is missing and a fact that is
        # zero must not look the same.
        details["not computed"] = ", ".join(skipped) + f" (over {DETAIL_BUDGET:.0f}s)"
    return details


def detail(name):
    """Expand one variable, as a JSON string. See variables() for why a string.

    This is where expensive work is allowed, within DETAIL_BUDGET.
    """
    namespace = sys.modules["__main__"].__dict__
    if name not in namespace:
        return json.dumps({"name": name, "error": "no longer defined"})

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

    return json.dumps(result)
