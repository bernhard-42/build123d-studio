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
 * `marked` says whether the cell began with a real "# %%" line or is the
 * synthesised one covering text ahead of the first marker. The two are otherwise
 * indistinguishable by start line - both can begin at line 1 - and telling them
 * apart is what stops a plain script's first line being decorated as a cell
 * boundary it does not have.
 *
 * @returns {Array<{startLine: number, endLine: number, code: string,
 *                  marked: boolean}>}
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

  // Content ahead of the first marker is still a cell - but it is one this
  // function invented, not one the author wrote a marker for.
  const synthesised = boundaries.length === 0 || boundaries[0] !== 0;
  if (synthesised) {
    boundaries.unshift(0);
  }

  return boundaries.map((start, index) => {
    const end = index + 1 < boundaries.length ? boundaries[index + 1] - 1 : lines.length - 1;
    return {
      startLine: start + 1,
      endLine: end + 1,
      code: lines.slice(start, end + 1).join("\n"),
      marked: !(synthesised && index === 0),
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

/** The cell whose own "# %%" marker is on this line, or null. */
export function cellStartingAt(source, line) {
  const found = findCells(source).find(
    (cell) => cell.marked && cell.startLine === line,
  );
  return found === undefined ? null : found;
}

/** The cell before the given one, or null at the top of the file. */
export function previousCell(source, cell) {
  const cells = findCells(source);
  const index = cells.findIndex((c) => c.startLine === cell.startLine);
  if (index <= 0) {
    return null;
  }
  return cells[index - 1];
}

/**
 * Everything above a line, and everything from it down.
 *
 * A pair, because "all above" and "all below" are one idea cut in two places,
 * and the cut is the line itself: above stops before it, below starts at it.
 * The marker line goes with the code below it, where its own cell is - and it
 * is a comment either way, so including it costs nothing and losing it would
 * mean the two halves did not add up to the file.
 */
export function codeAbove(source, line) {
  return source.split("\n").slice(0, Math.max(0, line - 1)).join("\n");
}

export function codeFrom(source, line) {
  return source.split("\n").slice(Math.max(0, line - 1)).join("\n");
}
