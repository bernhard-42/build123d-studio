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

import json
import sys

from .signatures import options

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
        entry["options"] = options(build123d, function, SUPPLIED)
    except (TypeError, ValueError):
        return entry  # no signature to read: offered as unavailable
    entry["available"] = True
    return entry
