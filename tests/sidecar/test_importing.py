"""What the Import dialog is offered, read from the installed build123d.

Against the real import_* functions, as test_exporting.py is against the
export_* ones: the dialog follows whatever build123d says.
"""

import inspect
import json
import unittest

import build123d as bd

from build123d_studio import importing


def forms():
    return {form["format"]: form for form in json.loads(importing.forms())}


def options(form):
    return {option["name"]: option for option in form["options"]}


class ImportFormsTest(unittest.TestCase):
    def test_the_five_importers_come_in_order(self):
        self.assertEqual(
            [(f["format"], f["function"]) for f in json.loads(importing.forms())],
            [
                ("BREP", "import_brep"),
                ("DXF", "import_dxf"),
                ("STEP", "import_step"),
                ("STL", "import_stl"),
                ("SVG", "import_svg"),
            ],
        )

    def test_every_importer_matches_its_function_in_this_build123d(self):
        for form in json.loads(importing.forms()):
            self.assertEqual(form["available"], callable(getattr(bd, form["function"], None)), form["format"])

    def test_the_file_is_never_an_option_whatever_it_is_called(self):
        for form in json.loads(importing.forms()):
            first = next(iter(inspect.signature(getattr(bd, form["function"])).parameters))
            self.assertNotIn(first, {option["name"] for option in form["options"]}, form["format"])

    def test_stl_asks_for_the_model_unit(self):
        unit = options(forms()["STL"])["model_unit"]
        self.assertEqual((unit["kind"], unit["enum"], unit["default"]), ("enum", "Unit", "MM"))

    def test_svg_offers_its_keyword_options(self):
        svg = options(forms()["SVG"])
        self.assertEqual(svg["flip_y"]["kind"], "bool")
        self.assertEqual(svg["align"]["enum"], "Align")
        self.assertEqual(svg["label_by"], {**svg["label_by"], "kind": "text", "default": "id"})

    def test_brep_dxf_and_step_have_no_options(self):
        for name in ("BREP", "DXF", "STEP"):
            self.assertEqual(forms()[name]["options"], [], name)


if __name__ == "__main__":
    unittest.main()
