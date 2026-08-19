// node --test tests/unit/editor/cells.test.mjs
//
// Which lines are cell boundaries, and - the part that had a bug in it - which
// of them the author actually wrote a "# %%" on. A file beginning with a marker
// and a plain script both report a cell starting at line 1, so the start line
// alone cannot tell them apart. The editor decorates the first kind and must not
// decorate the second, and for one release it did neither.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  cellAt,
  cellStartingAt,
  codeAbove,
  codeFrom,
  findCells,
  nextCell,
  previousCell,
} from "../../../src/editor/cells.js";

const starts = (source) => findCells(source).map((cell) => cell.startLine);
const marked = (source) => findCells(source).filter((cell) => cell.marked).map((c) => c.startLine);

// --- what counts as a marker ---

test("a file opening with a marker has a marked cell on line 1", () => {
  const source = "# %%\nx = 1\n# %%\ny = 2\n";
  assert.deepEqual(starts(source), [1, 3]);
  assert.deepEqual(marked(source), [1, 3]);
});

test("a plain script is one cell and it is not marked", () => {
  const source = "x = 1\ny = 2\n";
  assert.deepEqual(starts(source), [1]);
  assert.deepEqual(marked(source), []);
});

test("text ahead of the first marker is a cell nobody wrote a marker for", () => {
  const source = "import os\n# %%\nx = 1\n";
  assert.deepEqual(starts(source), [1, 2]);
  // Line 1 is a cell so that "run cell" works up there, but it is not a
  // boundary to draw - there is no marker on it.
  assert.deepEqual(marked(source), [2]);
});

test("an empty file is one unmarked cell rather than none", () => {
  assert.deepEqual(starts(""), [1]);
  assert.deepEqual(marked(""), []);
});

test("the marker is recognised with the spacing people actually type", () => {
  assert.deepEqual(marked("#%%\nx = 1\n"), [1]);
  assert.deepEqual(marked("#  %%\nx = 1\n"), [1]);
  assert.deepEqual(marked("  # %%\nx = 1\n"), [1]);
  assert.deepEqual(marked("# %% loading the part\nx = 1\n"), [1]);
});

test("a percent sign that is not a marker starts nothing", () => {
  assert.deepEqual(marked("# 50%% done\nx = 1\n"), []);
  assert.deepEqual(marked("x = 5 % 2\n"), []);
});

// --- the ranges the run actions use ---

test("a cell runs to the line before the next marker", () => {
  // The trailing newline makes a sixth, empty line, and it belongs to the last
  // cell - which is why the second range ends at 6 rather than 5.
  const cells = findCells("# %%\na = 1\nb = 2\n# %%\nc = 3\n");
  assert.deepEqual(
    cells.map((cell) => [cell.startLine, cell.endLine]),
    [
      [1, 3],
      [4, 6],
    ],
  );
  assert.equal(cells[0].code, "# %%\na = 1\nb = 2");
});

test("the cursor finds the cell it is standing in, wherever in it", () => {
  const source = "# %%\na = 1\nb = 2\n# %%\nc = 3\n";
  assert.equal(cellAt(source, 1).startLine, 1);
  assert.equal(cellAt(source, 3).startLine, 1);
  assert.equal(cellAt(source, 4).startLine, 4);
  assert.equal(cellAt(source, 5).startLine, 4);
});

test("the last cell has no next one, which is what stops the caret advancing", () => {
  const source = "# %%\na = 1\n# %%\nb = 2\n";
  const cells = findCells(source);
  assert.equal(nextCell(source, cells[0]).startLine, 3);
  assert.equal(nextCell(source, cells[1]), null);
});

// --- what the buttons above a marker need ----------------------------------
//
// The lenses are drawn on a marker line and act from it, so every one of these
// takes a line number rather than a caret: "run the cell this button sits on",
// "run the one before it", "run everything above it". A caret-based answer
// would be wrong the moment somebody clicks a button belonging to a different
// cell than the one they are typing in, which is most clicks.

const FILE = "# %%\nfirst = 1\n# %%\nsecond = 2\n# %%\nthird = 3\n";

test("a marker line names its own cell", () => {
  assert.equal(cellStartingAt(FILE, 3).code, "# %%\nsecond = 2");
  assert.equal(cellStartingAt(FILE, 1).code, "# %%\nfirst = 1");
});

test("and a line that is not a marker names none", () => {
  // The lens is only ever drawn on a marker, so anything else arriving here is
  // a buffer that changed under the click - answer nothing rather than guess.
  assert.equal(cellStartingAt(FILE, 2), null);
  assert.equal(cellStartingAt(FILE, 99), null);
});

test("the unmarked first cell of a plain script is not one of them", () => {
  // It has no marker, so it has no lens, so nothing can ask for it by line.
  assert.equal(cellStartingAt("x = 1\ny = 2\n", 1), null);
});

test("a cell knows the one before it, and the first has none", () => {
  const second = cellStartingAt(FILE, 3);
  assert.equal(previousCell(FILE, second).code, "# %%\nfirst = 1");
  assert.equal(previousCell(FILE, cellStartingAt(FILE, 1)), null);
});

test("above stops before the line, and below starts at it", () => {
  assert.equal(codeAbove(FILE, 3), "# %%\nfirst = 1");
  assert.equal(codeFrom(FILE, 3), "# %%\nsecond = 2\n# %%\nthird = 3\n");
});

test("and the two halves add up to the whole file", () => {
  // The property that makes the pair safe to reason about: nothing is dropped
  // between them and nothing is run twice.
  for (const line of [1, 2, 3, 4, 5, 6]) {
    const above = codeAbove(FILE, line);
    const below = codeFrom(FILE, line);
    assert.equal(above === "" ? below : `${above}\n${below}`, FILE, `at line ${line}`);
  }
});

test("above the first line is nothing at all", () => {
  assert.equal(codeAbove(FILE, 1), "");
});
