// node --test src/editor/hover.test.mjs

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { hoverContents } from "./hover.js";

// basedpyright's answer over `bd` in `with BuildPart() as bd:`.
const REAL = {
  hover: {
    value: "```python\n(variable) bd: BuildPart\n```",
    range: { start: { line: 3, character: 19 }, end: { line: 3, character: 21 } },
  },
};

test("the text is handed to Monaco as it arrived", () => {
  const hover = hoverContents(REAL);
  assert.equal(hover.contents.length, 1);
  assert.match(hover.contents[0].value, /BuildPart/);
});

test("the range is Monaco's, counting from one", () => {
  const hover = hoverContents(REAL);
  assert.deepEqual(hover.range, {
    startLineNumber: 4,
    startColumn: 20,
    endLineNumber: 4,
    endColumn: 22,
  });
});

test("a hover with no range still shows, and Monaco highlights the word", () => {
  const hover = hoverContents({ hover: { value: "(class) Box" } });
  assert.equal(hover.range, undefined);
  assert.equal(hover.contents[0].value, "(class) Box");
});

test("markdown from the server is not trusted to execute anything", () => {
  // Monaco renders hover contents as markdown, and isTrusted is what decides
  // whether a command: link in it can be clicked into running something. The
  // text here is a docstring out of somebody's dependency.
  assert.equal(hoverContents(REAL).contents[0].isTrusted, false);
});

test("nothing under the pointer is null rather than an empty tooltip", () => {
  for (const frame of [null, undefined, {}, { hover: null }, { hover: {} },
                       { hover: { value: "" } }, { hover: { value: "   \n " } }]) {
    assert.equal(hoverContents(frame), null);
  }
});

test("a malformed range costs the highlight, not the hover", () => {
  const hover = hoverContents({ hover: { value: "(class) Box", range: { start: { line: 1 } } } });
  assert.equal(hover.contents[0].value, "(class) Box");
  assert.equal(hover.range, undefined);
});
