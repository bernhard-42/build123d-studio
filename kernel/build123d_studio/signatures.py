"""Dialog controls from a build123d function's signature.

Shared by the Export and Import dialogs - see exporting.py and importing.py.
Each parameter with a default becomes one option of five kinds: bool, number,
enum, text, or fixed (shown, and left at its default, because the dialog could
not write any other value back as Python). The frontend draws them and writes
the call - see src/signatureform.js.
"""

import enum
import inspect
import math
import re
import typing


def options(build123d, function, supplied):
    """Every parameter of `function` with a default, as a list of options.

    `supplied` says which parameters the dialog fills in itself - the object
    and the path - and they are left out, as are *args and **kwargs.
    """
    signature = inspect.signature(function)
    docs = argument_docs(inspect.getdoc(function) or "")
    found = []
    for parameter in signature.parameters.values():
        if parameter.name in supplied or parameter.default is inspect.Parameter.empty:
            continue
        if parameter.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        entry = option(build123d, parameter)
        entry["doc"] = docs.get(parameter.name, "")
        found.append(entry)
    return found


def option(build123d, parameter):
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


def argument_docs(docstring):
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
