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
from collections.abc import Iterable, Iterator, Mapping, Sequence, Sized
from itertools import islice

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

# Children per page. A CAD script's list of points or faces runs to thousands,
# and sending them all costs the socket, the DOM and the reader's attention -
# nobody scrolls five thousand rows looking for one. A hundred is more than fits
# on screen, so paging is something you notice only when you need it.
PAGE = 100

# Rows past this are summarised rather than sent. A namespace with thousands of
# names is a star-import, not something anyone reads down; the count says so in
# one line and the pane stays usable.
MAX_ROWS = 500

# How long one expansion may spend computing geometry. The sidecar gives an
# inspection fifteen seconds, so this has to leave room for the reply to be
# built and sent, and for anything already queued on the kernel's serial shell
# channel to clear.
DETAIL_BUDGET = 8.0

# Counts a shape of this kind cannot tell you anything by. A Face has one face
# and that is what makes it a Face; an Edge has one edge, two vertices and no
# faces, all three fixed by its definition. Printing them is not wrong, it is
# noise in the three rows where the answer was known before the object existed.
#
# By type name rather than by class, because this module runs in the kernel and
# must not import build123d to describe it - it is called on every idle, and the
# import costs over two seconds of loading OCCT. Everything else here is
# duck-typed for the same reason.
IMPLIED_COUNTS = {
    "Vertex": ("faces", "edges", "vertices"),
    "Edge": ("faces", "edges", "vertices"),
    "Face": ("faces",),
}

# How much of a label is worth showing beside a name. A label is meant to be an
# identifier a person chose, so a long one is either a sentence or a mistake,
# and either way the column is not where it should be read.
MAX_LABEL = 40


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




# The plain containers, whose contents are the whole of what they are - so the
# repr column has nothing to add once the row is open. Anything else that
# unrolls keeps its repr: a numpy array's says its shape and dtype, and a
# Compound's says what it is, neither of which the elements repeat.
CONTAINERS = (dict, list, tuple, set, frozenset)

# Values with nothing inside them worth opening. str and bytes are the ones that
# matter here: both are Iterable and Sized, and unrolling "hello" into five
# one-character rows is not what anybody meant by expanding it.
SCALARS = (str, bytes, bytearray, int, float, complex, bool, type(None))


def _unrolls(value):
    """Whether a value's elements can be listed - any Iterable, with two rules.

    **Never an Iterator.** A generator, a zip, a map, an open file: iterating
    one consumes it, so a pane that unrolled them would destroy the thing it was
    asked to describe, silently, by being looked at. That is the one way this
    pane could damage a session rather than merely misreport it.

    **Sized, or not at all.** Paging needs a total and a total needs a length.
    An Iterable without one may also be endless - itertools.count() is Iterable
    and answering "how many" would never return. Measured against build123d,
    that excludes Vector and Location, whose len() raises; they keep the
    attribute view, which is what they had before.

    Everything else follows: a list, a dict, a set, a range, a numpy array, a
    ShapeList, and a user's own class with __iter__ and __len__ all unroll the
    same way, which is what "every Iterable" has to mean if it is to mean
    anything.
    """
    if isinstance(value, SCALARS):
        return False
    if isinstance(value, Iterator):
        return False
    return isinstance(value, Iterable) and isinstance(value, Sized)


def _expandable(value):
    """Whether a row is worth offering to open.

    Cheap by construction - type checks and, where it unrolls, a len. Nothing
    here may touch the object's own attributes: this runs on every child of
    every expansion, and a property that computes geometry would then cost the
    whole pane rather than the one row somebody clicked.
    """
    if isinstance(value, Iterator):
        # Nothing to offer. Opening it does not consume it - _children refuses
        # an Iterator too, which is the property that matters - but a chevron
        # on a generator invites a click that can only answer "no further
        # detail", and the invitation is what reads as a promise.
        return False
    if _unrolls(value):
        try:
            if len(value) > 0:
                return True
        except Exception:  # noqa: BLE001
            return False
        # An empty container has nothing to show. A shape that happens to be
        # empty may still have attributes, so fall through rather than refuse.
        return not isinstance(value, CONTAINERS)
    return not isinstance(value, SCALARS)


def _label_of(value):
    """The name the user gave this object, if it has one.

    build123d shapes carry a `label`, and it is the only thing that tells one
    Face from another: a list of six of them otherwise reads as six lines of
    "<Face object at 0x…>", which is the address of a thing rather than the
    thing. Enum members and open files answer to `name` in the same spirit, so
    both are tried.

    One guarded attribute read per row, deliberately, and the same exception
    _size_of's `.shape` is: this runs on every name after every execution, so it
    reads only what is already there and never anything that computes. A
    property that does work behind `label` would cost the pane - but it would
    cost it once per row rather than compounding, and an object whose *name* is
    expensive to ask for is not a shape this application produces.
    """
    for attribute in ("label", "name"):
        try:
            text = getattr(value, attribute, None)
        except Exception:  # noqa: BLE001 - a property that objects to being read
            continue
        if isinstance(text, str) and text != "":
            text = " ".join(text.split())
            return text[:MAX_LABEL - 1] + "…" if len(text) > MAX_LABEL else text
    return ""


def _row_repr(value):
    """The repr a row shows in its third column, or nothing.

    Nothing for a container that unrolls, because the expansion *is* its
    contents: "[1, 2, 3, 4, 5, 6]" in the column and then the same six numbers
    one per line underneath says the same thing twice, and the column is needed
    for the rows where opening the object is not an option.

    An empty list is not one of those - it has nothing to unroll into, so "[]"
    is the only thing that will ever describe it.
    """
    if _expandable(value) and isinstance(value, CONTAINERS):
        return ""
    return _short_repr(value)


def _elements(value):
    """What a row unrolls into, which is not always the object itself.

    A build123d assembly is a Compound, and iterating one gives its *topology* -
    unlabelled Compound wrappers - while `.children` gives the objects the user
    built and named. Measured on a three-part assembly:

        iter(asm)     [('Compound', ''), ('Compound', ''), ('Compound', '')]
        asm.children  [('Box', 'bottom'), ('Box', 'top'), ('Box', 'leg')]

    The second is what the viewer's own tree shows and what somebody means by
    opening it, and it is the only one of the two that carries the labels. So
    `.children` wins wherever there are any, at every level - which is what
    makes hexapod > left_middle_leg > upper_leg reachable by name.

    An ordinary shape has a `children` too and it is empty, so this falls
    through to the topology for anything that is not an assembly.
    """
    try:
        children = getattr(value, "children", None)
    except Exception:  # noqa: BLE001 - a property that objects to being read
        return value
    if children is None or children is value or not _unrolls(children):
        return value
    try:
        return children if len(children) > 0 else value
    except Exception:  # noqa: BLE001
        return value


def _child_at(value, index):
    """The index-th element, without materialising the rest.

    Sequences index directly. Anything else has no index, so islice walks to the
    one wanted - O(index) rather than O(len), which matters on the
    hundred-thousand-entry dict somebody has built out of a mesh.

    This and _children are two separate walks of the same object, and they must
    agree: one decides what a row says and the other decides what opening it
    shows. For a set that is a real question, and it is what
    test_a_set_can_be_opened holds them to.
    """
    value = _elements(value)
    if not _unrolls(value):
        raise LookupError("nothing to index")
    try:
        if isinstance(value, Mapping):
            return next(islice(value.values(), index, index + 1))
        if isinstance(value, Sequence):
            return value[index]
        return next(islice(iter(value), index, index + 1))
    except StopIteration:
        # Ran off the end, which is the same thing an index error says and
        # should read the same way to whoever asked.
        raise LookupError("no longer defined") from None


def _children(value, offset, limit):
    """One page of a container's children, and how many there are in all.

    Ordinals rather than keys, all the way down. A dict key can be any hashable
    - a tuple, a Vector, an object with no faithful text form - so a path built
    out of keys either loses information or invents an encoding for it. The
    position within the parent is a number, survives JSON, and is what the pane
    is displaying anyway.

    The cost of that is a path that stops meaning what it meant if the object is
    mutated underneath it. That is already true of everything in this pane: it
    describes the namespace at the moment it was asked, and the next idle asks
    again.
    """
    value = _elements(value)
    if not _unrolls(value):
        return None, 0

    try:
        total = len(value)
    except Exception:  # noqa: BLE001
        return None, 0

    try:
        if isinstance(value, Mapping):
            page = islice(value.items(), offset, offset + limit)
            pairs = [(str(key), item) for key, item in page]
        elif isinstance(value, Sequence):
            pairs = [
                (str(offset + i), item)
                for i, item in enumerate(value[offset:offset + limit])
            ]
        else:
            page = islice(iter(value), offset, offset + limit)
            pairs = [(str(offset + i), item) for i, item in enumerate(page)]
    except Exception:  # noqa: BLE001 - somebody else's __iter__ or __getitem__
        return None, 0

    children = [
        {
            "name": name,
            "type": type(item).__name__,
            "size": _size_of(item),
            "repr": _row_repr(item),
            "label": _label_of(item),
            "expandable": _expandable(item),
        }
        for name, item in pairs
    ]
    return children, total


def _walk(namespace, path):
    """Follow a path from the namespace to the value it names.

    The first step is a variable name; every step after it is an ordinal into
    whatever the previous step produced. Raises LookupError if any step no
    longer leads anywhere, which is ordinary rather than exceptional - the
    namespace is re-read after every execution and a list can have got shorter.
    """
    if len(path) == 0:
        raise LookupError("empty path")
    name = str(path[0])
    if name not in namespace:
        raise LookupError("no longer defined")

    value = namespace[name]
    for step in path[1:]:
        value = _child_at(value, int(step))
    return value


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

    # Classes and functions are never shown, wherever they were defined.
    #
    # They used to be, if the user had written them in this session, on the
    # reasoning that something you defined is something you might want to look
    # at. But this pane answers "what is in my model now" - it is read after a
    # Run to see what the code produced - and a class definition is part of the
    # code rather than part of the answer. A file with half a dozen helper
    # functions and a couple of shape classes pushed the shapes off the top of
    # the pane with rows that never change.
    if isinstance(value, type) or isinstance(
        value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)
    ):
        return False

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
                "repr": _row_repr(value),
                "label": _label_of(value),
                # So the pane can offer a chevron only where opening one leads
                # somewhere. An int with a twisty is a promise the row cannot
                # keep.
                "expandable": _expandable(value),
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
            "label": "",
            "expandable": False,
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
    implied = IMPLIED_COUNTS.get(type(value).__name__, ())
    counts = []

    for label, attribute in (("faces", "faces"), ("edges", "edges"), ("vertices", "vertices")):
        if label in implied:
            continue
        if time.monotonic() >= deadline:
            skipped.append(label)
            continue
        try:
            items = getattr(value, attribute, None)
            if callable(items):
                counts.append(f"{len(items())} {label}")
        except Exception:  # noqa: BLE001
            pass

    # One row, not three. They used to be three keyed rows, and once shapes
    # unrolled into their contents that put the counts between the object and
    # the thing somebody opened it to see - three lines of scrolling per shape,
    # every time, to reach the children. Read together on one line they also say
    # more: "6 faces, 12 edges, 8 vertices" is a box at a glance, where the same
    # numbers stacked are three facts to assemble.
    if len(counts) > 0:
        details["topology"] = ", ".join(counts)

    if len(skipped) > 0:
        # Named rather than dropped: a fact that is missing and a fact that is
        # zero must not look the same.
        details["not computed"] = ", ".join(skipped) + f" (over {DETAIL_BUDGET:.0f}s)"
    return details


def detail(path, offset=0):
    """Expand one value, as a JSON string. See variables() for why a string.

    ``path`` is a variable name followed by ordinals - ["a", 3, 0] is the first
    child of the fourth child of `a` - so the same call answers for the top
    level and for anything nested under it, however deep. This is where
    expensive work is allowed, within DETAIL_BUDGET.

    ``offset`` pages a container's children. The reply always says which page it
    is and how many there are in total, so the pane can say "1-100 of 5000"
    rather than stopping at a hundred and leaving the reader to wonder.
    """
    namespace = sys.modules["__main__"].__dict__
    try:
        value = _walk(namespace, path)
    except LookupError:
        return json.dumps({"path": path, "error": "no longer defined"})
    except Exception as exc:  # noqa: BLE001 - somebody else's __getitem__
        return json.dumps({"path": path, "error": f"could not be read: {exc.__class__.__name__}"})

    result = {"path": path, "type": type(value).__name__, "attributes": {}}

    # Both, where both apply. A build123d Part is Iterable and Sized - it
    # unrolls into the solids it is made of - and it also has the face, edge and
    # vertex counts this pane has always shown for a shape. Choosing between
    # them would mean that making shapes iterable took the counts away, which is
    # a change nobody asked for arriving through the back door.
    if not isinstance(value, CONTAINERS):
        result["attributes"] = _build123d_details(value)

    children, total = _children(value, offset, PAGE)
    if children is not None:
        result["children"] = children
        result["offset"] = offset
        result["total"] = total
        # Sent rather than assumed on the other side. The pane has to work out
        # the previous page's offset, and the last page is short - so deriving
        # the step from the number of children in hand is right going forwards
        # and wrong coming back.
        result["page"] = PAGE

    return json.dumps(result)
