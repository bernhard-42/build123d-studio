// node --test tests/unit/editor/importfile.test.mjs
//
// What a click on a CAD file sends to the kernel. The path is the only input
// that is not ours, and it is the part that ends up inside a Python string.
//
// Proof, at writing: with the backslash escape removed from pythonLiteral,
// "a Windows path survives as a Python literal" fails; with "stp" removed from
// IMPORTERS, "STEP has two extensions" fails.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { importCode, importerFor, pythonLiteral } from "../../../src/editor/importfile.js";

test("each of build123d's importers is chosen by extension, case-insensitively", () => {
  assert.equal(importerFor("/cad/plate.stl"), "import_stl");
  assert.equal(importerFor("/cad/plate.STL"), "import_stl");
  assert.equal(importerFor("/cad/frame.step"), "import_step");
  assert.equal(importerFor("/cad/frame.brep"), "import_brep");
  assert.equal(importerFor("/cad/outline.dxf"), "import_dxf");
  assert.equal(importerFor("/cad/logo.svg"), "import_svg");
});

test("STEP has two extensions", () => {
  assert.equal(importerFor("/cad/frame.stp"), "import_step");
});

test("anything else opens in the editor as before", () => {
  assert.equal(importerFor("/cad/part.py"), null);
  assert.equal(importerFor("/cad/notes.txt"), null);
  assert.equal(importerFor("/cad/README"), null);
  assert.equal(importerFor("/cad/.stl"), null);
  assert.equal(importerFor("/cad.stl/part.py"), null);
});

test("two requests: the announcement on its own, then import, bind _imported and show", () => {
  assert.deepEqual(importCode("/cad/frame.step"), [
    "# Importing frame.step ...",
    'from build123d import import_step; from build123d_studio import show, Camera; ' +
      '_imported = import_step("/cad/frame.step"); show(_imported, reset_camera=Camera.RESET)',
  ]);
  assert.equal(importCode("/cad/part.py"), null);
});

test("a Windows path survives as a Python literal", () => {
  assert.equal(pythonLiteral("C:\\Users\\me\\CAD\\plate.stl"), '"C:\\\\Users\\\\me\\\\CAD\\\\plate.stl"');
  assert.equal(pythonLiteral('/cad/2" pipe.step'), '"/cad/2\\" pipe.step"');
  assert.equal(pythonLiteral("/cad/Gehäuse.stl"), '"/cad/Gehäuse.stl"');
});
