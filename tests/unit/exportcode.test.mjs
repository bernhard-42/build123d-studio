// node --test tests/unit/exportcode.test.mjs
//
// The Export dialog's line of Python. The forms here are shaped like the
// kernel's answer for build123d 0.13 - see kernel/build123d_studio/exporting.py
// and tests/sidecar/test_exporting.py, which reads the real signatures.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultValue,
  exportCode,
  filtersFor,
  fits,
  problems,
  pythonString,
  suggestedName,
} from "../../src/vars/exportcode.js";

const STEP = {
  format: "STEP",
  function: "export_step",
  extension: ".step",
  available: true,
  options: [
    { name: "unit", kind: "enum", enum: "Unit", choices: ["MC", "MM", "CM", "M", "IN", "FT"], default: "MM", doc: "" },
    { name: "write_pcurves", kind: "bool", default: true, doc: "" },
    { name: "precision_mode", kind: "enum", enum: "PrecisionMode", choices: ["SESSION", "GREATEST", "AVERAGE", "LEAST"], default: "AVERAGE", doc: "" },
    { name: "timestamp", kind: "text", optional: true, default: null, doc: "" },
  ],
};

const STL = {
  format: "STL",
  function: "export_stl",
  extension: ".stl",
  available: true,
  options: [
    { name: "tolerance", kind: "number", integer: false, default: 0.001, doc: "" },
    { name: "angular_tolerance", kind: "number", integer: false, default: 0.1, doc: "" },
    { name: "ascii_format", kind: "bool", default: false, doc: "" },
  ],
};

function defaultsOf(form) {
  return Object.fromEntries(form.options.map((option) => [option.name, defaultValue(option)]));
}

test("with every default the call passes only the object and the path", () => {
  assert.equal(
    exportCode(STEP, "bracket", "/work/bracket.step", defaultsOf(STEP)),
    [
      "from build123d import export_step",
      'if export_step(bracket, "/work/bracket.step"):',
      '    print("Exported bracket to /work/bracket.step")',
      "else:",
      '    print("export_step returned False: /work/bracket.step was not written")',
    ].join("\n"),
  );
});

test("a changed option is passed, and an enum brings its class into the import", () => {
  const values = { ...defaultsOf(STEP), unit: "IN", write_pcurves: false };
  const code = exportCode(STEP, "bracket", "/work/bracket.step", values);
  assert.match(code, /^from build123d import export_step, Unit$/m);
  assert.match(code, /export_step\(bracket, "\/work\/bracket\.step", unit=Unit\.IN, write_pcurves=False\)/);
  assert.doesNotMatch(code, /precision_mode/);
});

test("an optional text left empty is None, and typed text is a Python string", () => {
  assert.doesNotMatch(exportCode(STEP, "b", "/b.step", defaultsOf(STEP)), /timestamp/);
  const code = exportCode(STEP, "b", "/b.step", { ...defaultsOf(STEP), timestamp: 'it\'s "now"' });
  assert.match(code, /timestamp="it's \\"now\\""/);
});

test("a number equal to its default is not passed, however it is written", () => {
  const same = exportCode(STL, "p", "/p.stl", { ...defaultsOf(STL), tolerance: "1e-3" });
  assert.doesNotMatch(same, /tolerance=/);
  const other = exportCode(STL, "p", "/p.stl", { ...defaultsOf(STL), tolerance: " 0.01 " });
  assert.match(other, /export_stl\(p, "\/p\.stl", tolerance=0\.01\)/);
});

test("a builder exports its attribute, and a Windows path survives as a literal", () => {
  const code = exportCode(STL, "bp.part", "C:\\Users\\me\\bp.stl", defaultsOf(STL));
  assert.match(code, /export_stl\(bp\.part, "C:\\\\Users\\\\me\\\\bp\.stl"\)/);
});

test("a number field that is empty, not a number, or fractional where whole is wanted", () => {
  assert.deepEqual(problems(STL, defaultsOf(STL)), []);
  assert.deepEqual(problems(STL, { ...defaultsOf(STL), tolerance: "" }), ["tolerance needs a number."]);
  assert.deepEqual(problems(STL, { ...defaultsOf(STL), tolerance: "fine" }), ["tolerance needs a number."]);
  const integer = { ...STL, options: [{ name: "count", kind: "number", integer: true, default: 3 }] };
  assert.deepEqual(problems(integer, { count: "2.5" }), ["count needs a whole number."]);
  assert.deepEqual(problems(integer, { count: "4" }), []);
});

test("a remembered value is used only where it still fits its option", () => {
  const [unit, pcurves, , timestamp] = STEP.options;
  assert.equal(fits(unit, "IN"), true);
  assert.equal(fits(unit, "PARSEC"), false);
  assert.equal(fits(pcurves, "yes"), false);
  assert.equal(fits(timestamp, ""), true);
  assert.equal(fits({ name: "x", kind: "fixed", default: "<object>" }, "<object>"), false);
});

test("the defaults are what the controls start with", () => {
  assert.deepEqual(defaultsOf(STEP), { unit: "MM", write_pcurves: true, precision_mode: "AVERAGE", timestamp: "" });
  assert.deepEqual(defaultsOf(STL), { tolerance: "0.001", angular_tolerance: "0.1", ascii_format: false });
});

test("the save panel suggests the variable's name with the extension, and filters by format", () => {
  assert.equal(suggestedName("bp", STEP), "bp.step");
  assert.deepEqual(filtersFor(STL), [
    { name: "STL", extensions: ["stl"] },
    { name: "All files", extensions: ["*"] },
  ]);
});

test("a JavaScript string becomes a Python string literal", () => {
  assert.equal(pythonString("a\\b\n\"c\""), '"a\\\\b\\n\\"c\\""');
});
