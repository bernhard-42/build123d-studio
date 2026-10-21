"""What the variable explorer's Export dialog offers, read from build123d.

Runs inside the kernel, called by the sidecar on the inspection lane like the
inspector - see inspector.py for why every answer is a JSON string.

The dialog's controls are not written down anywhere in the application. They
are read from the `export_*` functions' own signatures, so the options and their
defaults are whatever the installed build123d says they are, and a build123d
that adds a parameter gets a control for it without a change here.

build123d is never imported from here. It is taken from sys.modules, so a
namespace that has not imported it has nothing to export and pays nothing.
"""

import enum
import inspect
import json
import math
import re
import sys
import typing

# The dialog's dropdown, in this order: label, function, file extension.
FORMATS = (
    ("STEP", "export_step", ".step"),
    ("STL", "export_stl", ".stl"),
    ("BREP", "export_brep", ".brep"),
    ("OBJ", "export_obj", ".obj"),
    ("GLTF", "export_gltf", ".gltf"),
)

# The two parameters the dialog supplies itself: the object and the path.
SUPPLIED = {"to_export", "file_path"}

# A builder is not a Shape; what it built is. The suffix is the attribute that
# holds it, and it becomes part of the exported expression - `bp.part`.
BUILDERS = (
    ("BuildPart", ".part"),
    ("BuildSketch", ".sketch"),
    ("BuildLine", ".line"),
)


def export_target(value):
    """How a variable is exported: "" for a Shape, ".part" for a builder.

    None when it cannot be exported. Called for every row of every listing, so
    it only asks isinstance - nothing a builder computes is touched.
    """
    build123d = sys.modules.get("build123d")
    if build123d is None:
        return None
    shape = getattr(build123d, "Shape", None)
    if isinstance(shape, type) and isinstance(value, shape):
        return ""
    for name, suffix in BUILDERS:
        builder = getattr(build123d, name, None)
        if isinstance(builder, type) and isinstance(value, builder):
            return suffix
    return None


def forms():
    """One entry per format, as a JSON string.

    Each entry names its function and extension, says whether the installed
    build123d has the function at all, and lists the options the dialog draws -
    every parameter with a default, apart from the two the dialog supplies.
    """
    build123d = sys.modules.get("build123d")
    return json.dumps([_form(build123d, *entry) for entry in FORMATS])


def _form(build123d, label, name, extension):
    entry = {
        "format": label,
        "function": name,
        "extension": extension,
        "available": False,
        "options": [],
    }
    function = None if build123d is None else getattr(build123d, name, None)
    if not callable(function):
        return entry
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        return entry

    entry["available"] = True
    docs = _argument_docs(inspect.getdoc(function) or "")
    for parameter in signature.parameters.values():
        if parameter.name in SUPPLIED or parameter.default is inspect.Parameter.empty:
            continue
        if parameter.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        option = _option(build123d, parameter)
        option["doc"] = docs.get(parameter.name, "")
        entry["options"].append(option)
    return entry


def _option(build123d, parameter):
    """One control: its kind decides how the dialog draws and writes it.

    Decided by the default first, because the default is a value and an
    annotation may be a string, a union or missing. A value the dialog could not
    write back as Python is offered as "fixed": shown, and left at its default.
    """
    name = parameter.name
    default = parameter.default

    if isinstance(default, bool):
        return {"name": name, "kind": "bool", "default": default}

    if isinstance(default, enum.Enum):
        cls = type(default)
        # Written into the line as `Unit.MM`, so the class has to be importable
        # from build123d under its own name.
        if getattr(build123d, cls.__name__, None) is cls:
            return {
                "name": name,
                "kind": "enum",
                "enum": cls.__name__,
                "choices": [member.name for member in cls],
                "default": default.name,
            }
        return _fixed(name, default)

    if isinstance(default, int):
        return {"name": name, "kind": "number", "integer": True, "default": default}

    if isinstance(default, float):
        if not math.isfinite(default):
            return _fixed(name, default)
        return {"name": name, "kind": "number", "integer": False, "default": default}

    if isinstance(default, str):
        return {"name": name, "kind": "text", "optional": False, "default": default}

    if default is None and _accepts_str(parameter.annotation):
        return {"name": name, "kind": "text", "optional": True, "default": None}

    return _fixed(name, default)


def _fixed(name, default):
    return {"name": name, "kind": "fixed", "default": repr(default)}


def _accepts_str(annotation):
    """Whether a text field may answer this parameter: str, or a union with it."""
    if annotation is str:
        return True
    if isinstance(annotation, str):
        # An annotation left as a string by `from __future__ import annotations`.
        return re.search(r"\bstr\b", annotation) is not None
    return str in typing.get_args(annotation)


def _argument_docs(docstring):
    """The `Args:` section of a Google-style docstring, by parameter name.

    For the tooltip on each control. Best effort: a docstring in another style
    yields nothing, and the control is simply drawn without a tooltip.
    """
    docs = {}
    lines = docstring.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "Args:")
    except StopIteration:
        return docs

    entry = re.compile(r"^(\s+)(\w+)\s*(?:\([^)]*\))?\s*:\s*(.*)$")
    current = None
    indent = None
    for line in lines[start + 1:]:
        if line.strip() == "":
            continue
        if not line.startswith((" ", "\t")):
            break  # the next section, "Returns:" and the like
        match = entry.match(line)
        if match is not None and (indent is None or len(match.group(1)) == indent):
            indent = len(match.group(1))
            current = match.group(2)
            docs[current] = match.group(3).strip()
        elif current is not None:
            docs[current] = f"{docs[current]} {line.strip()}".strip()
    return docs
