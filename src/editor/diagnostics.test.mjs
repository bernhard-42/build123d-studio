// node --test src/editor/diagnostics.test.mjs
//
// Squiggle placement, which is the only thing about a diagnostic that this side
// can get wrong. The message is the server's; where it is drawn is ours, and
// LSP counts lines and characters from zero while Monaco counts both from one.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { markersFor } from "./diagnostics.js";

// Stands in for monaco.MarkerSeverity, whose real values are 8/4/2/1.
const SEVERITY = { Error: "sev:Error", Warning: "sev:Warning", Info: "sev:Info", Hint: "sev:Hint" };

// basedpyright's answer for `plate.nonexistent_attribute` on line 20, columns
// 6 to 28 as it counts them.
const REAL = {
  diagnostics: [
    {
      range: { start: { line: 19, character: 6 }, end: { line: 19, character: 28 } },
      severity: 1,
      code: "reportAttributeAccessIssue",
      source: "basedpyright",
      message: 'Cannot access attribute "nonexistent_attribute" for class "Part"',
    },
  ],
};

test("a diagnostic is drawn on the line the server meant", () => {
  const [marker] = markersFor(REAL, SEVERITY);
  assert.equal(marker.startLineNumber, 20);
  assert.equal(marker.endLineNumber, 20);
  assert.equal(marker.startColumn, 7);
  assert.equal(marker.endColumn, 29);
});

test("the message, rule and source all survive", () => {
  const [marker] = markersFor(REAL, SEVERITY);
  assert.match(marker.message, /nonexistent_attribute/);
  assert.equal(marker.code, "reportAttributeAccessIssue");
  assert.equal(marker.source, "basedpyright");
  assert.equal(marker.severity, "sev:Error");
});

test("each LSP severity maps to its own Monaco one", () => {
  const of = (severity) =>
    markersFor({ diagnostics: [{ ...REAL.diagnostics[0], severity }] }, SEVERITY)[0].severity;
  assert.equal(of(1), "sev:Error");
  assert.equal(of(2), "sev:Warning");
  assert.equal(of(3), "sev:Info");
  assert.equal(of(4), "sev:Hint");
});

test("an unrecognised severity warns rather than shouts", () => {
  // The severity is the server's opinion and a missing one is not licence to
  // put a red mark in the overview ruler, which reads as "this will not run".
  for (const severity of [undefined, null, 0, 9, "error"]) {
    const [marker] = markersFor({ diagnostics: [{ ...REAL.diagnostics[0], severity }] }, SEVERITY);
    assert.equal(marker.severity, "sev:Warning");
  }
});

test("a rule given as a code with a documentation link keeps its name", () => {
  const linked = {
    diagnostics: [{ ...REAL.diagnostics[0], code: { value: "reportUndefinedVariable", target: "…" } }],
  };
  assert.equal(markersFor(linked, SEVERITY)[0].code, "reportUndefinedVariable");
});

test("a diagnostic with no usable range is dropped rather than drawn at 1:1", () => {
  // A squiggle in the wrong place is worse than none: it sends the reader to a
  // line that has nothing wrong with it.
  const broken = [
    { ...REAL.diagnostics[0], range: undefined },
    { ...REAL.diagnostics[0], range: { start: { line: 1 }, end: { line: 1, character: 2 } } },
    { ...REAL.diagnostics[0], range: { start: null, end: null } },
  ];
  for (const diagnostic of broken) {
    assert.deepEqual(markersFor({ diagnostics: [diagnostic] }, SEVERITY), []);
  }
});

test("a clean file clears the squiggles rather than leaving the last ones up", () => {
  // The empty list is the whole mechanism: the server republishes everything it
  // knows about a document each time, so "no diagnostics" arrives as an empty
  // array and has to reach setModelMarkers to take the old ones away.
  assert.deepEqual(markersFor({ diagnostics: [] }, SEVERITY), []);
});

test("no frame is no markers rather than a failure", () => {
  for (const frame of [null, undefined, {}, { diagnostics: null }]) {
    assert.deepEqual(markersFor(frame, SEVERITY), []);
  }
});
