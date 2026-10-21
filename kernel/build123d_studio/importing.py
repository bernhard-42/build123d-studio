"""What the File menu's Import dialog offers, read from build123d.

The import side of exporting.py: one entry per importer, with the options its
signature has besides the file. The frontend picks the entry by the chosen
file's extension - the mapping lives in src/editor/importfile.js, which the
file tree's Show uses too.

The file is each importer's first parameter, whatever it is called - build123d
names it file_name, filename, dxf_file and svg_file in different functions.
"""

import inspect
import json
import sys

from .signatures import options

# The importers the dialog knows, in the order the formats are named.
IMPORTERS = (
    ("BREP", "import_brep"),
    ("DXF", "import_dxf"),
    ("STEP", "import_step"),
    ("STL", "import_stl"),
    ("SVG", "import_svg"),
)


def forms():
    """One entry per importer, as a JSON string - see exporting.forms."""
    build123d = sys.modules.get("build123d")
    return json.dumps([_form(build123d, *entry) for entry in IMPORTERS])


def _form(build123d, label, name):
    entry = {"format": label, "function": name, "available": False, "options": []}
    function = None if build123d is None else getattr(build123d, name, None)
    if not callable(function):
        return entry
    try:
        parameters = list(inspect.signature(function).parameters)
        entry["options"] = options(build123d, function, set(parameters[:1]))
    except (TypeError, ValueError):
        return entry  # no signature to read: offered as unavailable
    entry["available"] = True
    return entry
