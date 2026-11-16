"""What the Export dialog is offered, read from the installed build123d.

Against the real export_* functions rather than stand-ins: the point of reading
signatures is that the dialog follows whatever build123d says, so the test has
to ask the same build123d. The stand-ins below are only for the cases the real
functions do not have - a default the dialog cannot write back, an annotation
left as a string.
"""

import enum
import inspect
import json
import unittest

import build123d as bd

from build123d_studio import exporting
from build123d_studio import inspector
from build123d_studio import signatures


def forms():
    return {form["format"]: form for form in json.loads(exporting.forms())}


def options(form):
    return {option["name"]: option for option in form["options"]}


class FormsTest(unittest.TestCase):
    def test_the_five_formats_come_in_order_with_their_extensions(self):
        answer = json.loads(exporting.forms())
        self.assertEqual(
            [(f["format"], f["function"], f["extension"]) for f in answer],
            [
                ("STEP", "export_step", ".step"),
                ("STL", "export_stl", ".stl"),
                ("BREP", "export_brep", ".brep"),
                ("OBJ", "export_obj", ".obj"),
                ("GLTF", "export_gltf", ".gltf"),
            ],
        )

    def test_every_format_matches_its_function_in_this_build123d(self):
        for form in json.loads(exporting.forms()):
            self.assertEqual(form["available"], callable(getattr(bd, form["function"], None)), form["format"])

    def test_the_object_and_the_path_are_never_options(self):
        for form in json.loads(exporting.forms()):
            names = {option["name"] for option in form["options"]}
            self.assertFalse(names & {"to_export", "file_path"}, form["format"])

    def test_step_options_carry_their_kinds_and_defaults(self):
        step = options(forms()["STEP"])
        self.assertEqual(step["unit"]["kind"], "enum")
        self.assertEqual(step["unit"]["enum"], "Unit")
        self.assertEqual(step["unit"]["default"], "MM")
        self.assertIn("IN", step["unit"]["choices"])
        self.assertEqual(step["write_pcurves"], {**step["write_pcurves"], "kind": "bool", "default": True})
        self.assertEqual(step["precision_mode"]["enum"], "PrecisionMode")
        self.assertEqual(step["timestamp"]["kind"], "text")
        self.assertTrue(step["timestamp"]["optional"])
        self.assertIsNone(step["timestamp"]["default"])

    def test_numbers_are_numbers_with_the_signature_default(self):
        stl = options(forms()["STL"])
        default = inspect.signature(bd.export_stl).parameters["tolerance"].default
        self.assertEqual(stl["tolerance"]["kind"], "number")
        self.assertFalse(stl["tolerance"]["integer"])
        self.assertEqual(stl["tolerance"]["default"], default)

    def test_brep_offers_what_export_brep_takes(self):
        # Whatever this build123d's signature says, besides the object and the
        # path: none in 0.13.0, and `binary`, `version` and `triangulation`
        # once build123d added them - the dialog follows without a change.
        taken = [name for name in inspect.signature(bd.export_brep).parameters if name not in {"to_export", "file_path"}]
        self.assertEqual([option["name"] for option in forms()["BREP"]["options"]], taken)

    def test_the_tooltip_comes_from_the_docstring(self):
        unit = options(forms()["STEP"])["unit"]
        self.assertIn("unit", unit["doc"].lower())


class OptionKindsTest(unittest.TestCase):
    """The kinds the real functions do not exercise."""

    def kind_of(self, default, annotation=inspect.Parameter.empty):
        parameter = inspect.Parameter(
            "x", inspect.Parameter.POSITIONAL_OR_KEYWORD, default=default, annotation=annotation
        )
        return signatures.option(bd, parameter)

    def test_an_enum_build123d_does_not_export_is_shown_fixed(self):
        class Local(enum.Enum):
            A = 1

        self.assertEqual(self.kind_of(Local.A)["kind"], "fixed")

    def test_an_integer_default_asks_for_a_whole_number(self):
        option = self.kind_of(3)
        self.assertEqual((option["kind"], option["integer"]), ("number", True))

    def test_none_takes_text_only_where_the_annotation_allows_str(self):
        self.assertEqual(self.kind_of(None, str | None)["kind"], "text")
        self.assertEqual(self.kind_of(None, "str | None")["kind"], "text")
        self.assertEqual(self.kind_of(None, int | None)["kind"], "fixed")
        self.assertEqual(self.kind_of(None)["kind"], "fixed")

    def test_anything_else_is_fixed_at_its_repr(self):
        self.assertEqual(self.kind_of((1, 2)), {"name": "x", "kind": "fixed", "default": "(1, 2)"})


class ExportTargetTest(unittest.TestCase):
    def test_a_shape_exports_itself(self):
        self.assertEqual(exporting.export_target(bd.Box(1, 1, 1)), "")
        self.assertEqual(exporting.export_target(bd.Compound(children=[bd.Box(1, 1, 1)])), "")

    def test_a_builder_exports_what_it_built(self):
        with bd.BuildPart() as part:
            bd.Box(1, 1, 1)
        with bd.BuildSketch() as sketch:
            bd.Circle(1)
        with bd.BuildLine() as line:
            bd.Line((0, 0), (1, 0))
        self.assertEqual(exporting.export_target(part), ".part")
        self.assertEqual(exporting.export_target(sketch), ".sketch")
        self.assertEqual(exporting.export_target(line), ".line")

    def test_anything_else_has_no_export(self):
        for value in (42, "text", [bd.Box(1, 1, 1)], bd.Vector(1, 2, 3)):
            self.assertIsNone(exporting.export_target(value), repr(value))

    def test_the_explorer_rows_carry_it(self):
        import __main__

        namespace = __main__.__dict__
        added = {"probe_box": bd.Box(1, 1, 1), "probe_number": 7}
        namespace.update(added)
        try:
            rows = {row["name"]: row for row in json.loads(inspector.variables())}
        finally:
            for name in added:
                namespace.pop(name, None)
        self.assertEqual(rows["probe_box"]["export"], "")
        self.assertIsNone(rows["probe_number"]["export"])

    def test_so_do_the_rows_below_them(self):
        """A part in a list, a builder in a dict, a box inside an assembly inside an assembly, a part's Solid."""
        import __main__

        namespace = __main__.__dict__
        with bd.BuildPart() as builder:
            bd.Box(1, 1, 1)
        upper = bd.Box(1, 1, 1)
        upper.label = "upper"
        leg = bd.Compound(label="leg", children=[upper])
        added = {
            "probe_list": [bd.Box(1, 1, 1), 7],
            "probe_dict": {"builder": builder},
            "probe_asm": bd.Compound(label="asm", children=[bd.Box(2, 2, 2), leg]),
        }
        namespace.update(added)
        try:
            listed = json.loads(inspector.detail(["probe_list"]))["children"]
            mapped = json.loads(inspector.detail(["probe_dict"]))["children"]
            nested = json.loads(inspector.detail(["probe_asm", 1]))["children"]
            topology = json.loads(inspector.detail(["probe_asm", 0]))["children"]
            solid = eval(topology[0]["expression"], namespace)
            walked = inspector._walk(namespace, ["probe_asm", 0, 0])
        finally:
            for name in added:
                namespace.pop(name, None)

        self.assertEqual([(c["expression"], c["export"]) for c in listed], [("probe_list[0]", ""), ("probe_list[1]", None)])
        self.assertEqual([(c["expression"], c["export"]) for c in mapped], [("probe_dict['builder']", ".part")])
        self.assertEqual([(c["expression"], c["export"], c["label"]) for c in nested], [("probe_asm.children[1].children[0]", "", "upper")])
        # The part's Solid: not a child, its topology - reached by position.
        self.assertEqual([(c["type"], c["expression"], c["export"]) for c in topology], [("Solid", "list(probe_asm.children[0])[0]", "")])
        self.assertTrue(solid.wrapped.IsSame(walked.wrapped))


if __name__ == "__main__":
    unittest.main()
