// node --test tests/unit/importcode.test.mjs
//
// The Import dialog's lines of Python and its variable name. The forms are
// shaped like the kernel's answer for build123d 0.13 - see
// tests/sidecar/test_importing.py, which reads the real signatures.

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultValue } from "../../src/signatureform.js";
import {
  bufferLines,
  defaultVariableName,
  importCode,
  importedNames,
  importFilters,
  importLines,
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

test("a STEP file is assigned with nothing but its path and shown, after an announcing comment", () => {
  assert.deepEqual(importCode(STEP, "frame", "/work/frame.step", {}), [
    "# Importing frame.step as frame ...",
    [
      "from build123d import import_step",
      "from build123d_studio import show, Camera",
      'frame = import_step("/work/frame.step")',
      'show(frame, names=["frame"], reset_camera=Camera.RESET)',
    ].join("\n"),
  ]);
});

test("the lines for the buffer are the import without the announcing comment", () => {
  const [, run] = importCode(STEP, "frame", "/work/frame.step", {});
  assert.equal(importLines(STEP, "frame", "/work/frame.step", {}), run);
});

test("a changed option is passed, and an enum brings its class into the import", () => {
  const code = importLines(STL, "bracket", "/work/b.stl", { model_unit: "IN" }).split("\n");
  assert.equal(code[0], "from build123d import import_stl, Unit");
  assert.equal(code[2], 'bracket = import_stl("/work/b.stl", model_unit=Unit.IN)');
  const plain = importLines(STL, "bracket", "/work/b.stl", defaultsOf(STL)).split("\n");
  assert.equal(plain[0], "from build123d import import_stl");
  assert.equal(plain[2], 'bracket = import_stl("/work/b.stl")');
});

test("keyword-only options are passed by name like any other", () => {
  const values = { ...defaultsOf(SVG), flip_y: false, align: "CENTER", label_by: "class" };
  const code = importLines(SVG, "logo", "C:\\art\\logo.svg", values).split("\n");
  assert.equal(code[0], "from build123d import import_svg, Align");
  assert.equal(
    code[2],
    'logo = import_svg("C:\\\\art\\\\logo.svg", flip_y=False, align=Align.CENTER, label_by="class")',
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

const ASSIGN = 'frame = import_step("/work/frame.step")';

test("the buffer gets the import statement alone, with its import line when missing", () => {
  assert.equal(
    bufferLines(STEP, "frame", "/work/frame.step", {}, "x = 1\n"),
    ["from build123d import import_step", ASSIGN].join("\n"),
  );
});

test("no show() goes into the buffer, and nothing from build123d_studio", () => {
  const lines = bufferLines(STEP, "frame", "/work/frame.step", {}, "");
  assert.doesNotMatch(lines, /show\(|build123d_studio/);
});

test("a star import covers build123d", () => {
  assert.equal(bufferLines(STEP, "frame", "/work/frame.step", {}, "from build123d import *\n"), ASSIGN);
});

test("only the names the buffer lacks are imported", () => {
  // An enum an option needs is a name like any other.
  const stl = bufferLines(STL, "b", "/b.stl", { model_unit: "IN" }, "from build123d import import_stl\n");
  assert.equal(stl, 'from build123d import Unit\nb = import_stl("/b.stl", model_unit=Unit.IN)');
});

test("the names are read from every form an import takes", () => {
  const source = [
    "from build123d import *",
    "# from build123d_studio import show",
    "from build123d_studio import (",
    "    show,  # the viewer",
    "    Camera as Cam,",
    ")",
    "from build123d_studio import set_defaults, \\",
    "    Animation",
  ].join("\n");
  const names = importedNames(source);
  assert.deepEqual([...names.get("build123d")], ["*"]);
  assert.deepEqual([...names.get("build123d_studio")], ["show", "Cam", "set_defaults", "Animation"]);
});

test("an alias does not count as the name it renames", () => {
  const source = "from build123d import import_step as load\n";
  assert.equal(
    bufferLines(STEP, "frame", "/work/frame.step", {}, source),
    ["from build123d import import_step", ASSIGN].join("\n"),
  );
});

test("the console's lines always carry every import", () => {
  const [, run] = importCode(STEP, "frame", "/work/frame.step", {});
  assert.equal(run.split("\n").slice(0, 2).join("\n"),
    "from build123d import import_step\nfrom build123d_studio import show, Camera");
});
