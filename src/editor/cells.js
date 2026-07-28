// Cell detection for "# %%" markers.
//
// The same convention VS Code, Spyder and jupytext use: a line whose first
// non-whitespace content is "# %%" starts a new cell, and everything up to the
// next marker (or the end of the file) belongs to it. Text before the first
// marker is a cell in its own right, so a file with no markers at all is simply
// one cell - which keeps "run cell" meaningful in a plain script.

const CELL_MARKER = /^\s*#\s*%%/;

/**
 * Split source into cells.
 *
 * @returns {Array<{startLine: number, endLine: number, code: string}>}
 *          1-based inclusive line numbers, matching Monaco's convention.
 */
export function findCells(source) {
  const lines = source.split("\n");
  const boundaries = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (CELL_MARKER.test(lines[i])) {
      boundaries.push(i);
    }
  }

  // Content ahead of the first marker is still a cell.
  if (boundaries.length === 0 || boundaries[0] !== 0) {
    boundaries.unshift(0);
  }

  return boundaries.map((start, index) => {
    const end = index + 1 < boundaries.length ? boundaries[index + 1] - 1 : lines.length - 1;
    return {
      startLine: start + 1,
      endLine: end + 1,
      code: lines.slice(start, end + 1).join("\n"),
    };
  });
}

/** The cell containing a 1-based line number, or null if there is none. */
export function cellAt(source, line) {
  for (const cell of findCells(source)) {
    if (line >= cell.startLine && line <= cell.endLine) {
      return cell;
    }
  }
  return null;
}

/** The cell after the given one, or null at the end of the file. */
export function nextCell(source, cell) {
  const cells = findCells(source);
  const index = cells.findIndex((c) => c.startLine === cell.startLine);
  if (index < 0 || index + 1 >= cells.length) {
    return null;
  }
  return cells[index + 1];
}
