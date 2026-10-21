// node --test tests/unit/importcode.test.mjs
//
// The Import dialog's lines of Python and its variable name. The forms are
// shaped like the kernel's answer for build123d 0.13 - see
// tests/sidecar/test_importing.py, which reads the real signatures.

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultValue } from "../../src/signatureform.js";
import {
  defaultVariableName,
  importCode,
  importFilters,
  variableProblem,
} from "../../src/editor/importcode.js";

const STEP = { format: "STEP", function: "import_step", available: true, options: [] };
const STL = {
  format: "STL",
  function: "import_stl",
  available: true,
  options: [
    { name: "model_unit", kind: "enum", enum: "Unit", choices: ["MC", "MM", "CM", "M", "IN", "FT"], default: "MM", doc: "" },
  ],
};
const SVG = {
  format: "SVG",
  function: "import_svg",
  available: true,
  options: [
    { name: "flip_y", kind: "bool", default: true, doc: "" },
    { name: "align", kind: "enum", enum: "Align", choices: ["MIN", "CENTER", "MAX", "NONE"], default: "MIN", doc: "" },
    { name: "ignore_visibility", kind: "bool", default: false, doc: "" },
    { name: "label_by", kind: "text", optional: false, default: "id", doc: "" },
  ],
};

function defaultsOf(form) {
  return Object.fromEntries(form.options.map((option) => [option.name, defaultValue(option)]));
}

test("a STEP file is assigned with nothing but its path, after an announcing comment", () => {
  assert.deepEqual(importCode(STEP, "frame", "/work/frame.step", {}), [
    "# Importing frame.step as frame ...",
    'from build123d import import_step\nframe = import_step("/work/frame.step")',
  ]);
});

test("a changed option is passed, and an enum brings its class into the import", () => {
  const [, code] = importCode(STL, "bracket", "/work/b.stl", { model_unit: "IN" });
  assert.equal(code, 'from build123d import import_stl, Unit\nbracket = import_stl("/work/b.stl", model_unit=Unit.IN)');
  const [, plain] = importCode(STL, "bracket", "/work/b.stl", defaultsOf(STL));
  assert.equal(plain, 'from build123d import import_stl\nbracket = import_stl("/work/b.stl")');
});

test("keyword-only options are passed by name like any other", () => {
  const values = { ...defaultsOf(SVG), flip_y: false, align: "CENTER", label_by: "class" };
  const [, code] = importCode(SVG, "logo", "C:\\art\\logo.svg", values);
  assert.equal(
    code,
    'from build123d import import_svg, Align\nlogo = import_svg("C:\\\\art\\\\logo.svg", flip_y=False, align=Align.CENTER, label_by="class")',
  );
});

test("the suggested name is the file's, made into a Python name", () => {
  assert.equal(defaultVariableName("/work/frame.step"), "frame");
  assert.equal(defaultVariableName("/work/frame-v2 final.STEP"), "frame_v2_final");
  assert.equal(defaultVariableName("C:\\work\\Träger.stl"), "Träger");
  assert.equal(defaultVariableName("/work/3d-print.stl"), "shape_3d_print");
  assert.equal(defaultVariableName("/work/_hidden.brep"), "hidden");
  assert.equal(defaultVariableName("/work/class.svg"), "class_");
  assert.equal(defaultVariableName("/work/---.dxf"), "imported");
});

test("a name Python cannot assign to is refused with the reason", () => {
  assert.equal(variableProblem("frame"), null);
  assert.equal(variableProblem("Träger_2"), null);
  assert.equal(variableProblem("_private"), null);
  assert.equal(variableProblem(""), "A variable name is needed.");
  assert.match(variableProblem("2frame"), /not a Python name/);
  assert.match(variableProblem("my frame"), /not a Python name/);
  assert.equal(variableProblem("lambda"), "lambda is a Python keyword.");
  // Soft keywords are ordinary names outside their statements.
  assert.equal(variableProblem("match"), null);
});

test("the open dialog filters for every file build123d imports", () => {
  const [cad, all] = importFilters();
  assert.deepEqual([...cad.extensions].sort(), ["brep", "dxf", "step", "stl", "stp", "svg"]);
  assert.deepEqual(all, { name: "All files", extensions: ["*"] });
});
