// Which rows of the variable explorer a filter keeps.
//
// Pure, because the decision is one line and the tests for it should not need
// a window: a query matches a top-level row by name or by build123d's label,
// case-insensitively, anywhere in the text. Children are never filtered - a
// row that is open shows what it holds - and an empty query keeps everything.

/**
 * @param {{name: string, label?: string}} row a top-level row
 * @param {string} query what was typed, untrimmed
 * @returns {boolean}
 */
export function matchesFilter(row, query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  if (String(row.name).toLowerCase().includes(needle)) {
    return true;
  }
  return typeof row.label === "string" && row.label.toLowerCase().includes(needle);
}

/**
 * The rows to show, in their original order.
 *
 * @param {Array<{name: string, label?: string}>} rows
 * @param {string} query
 */
export function filterRows(rows, query) {
  return rows.filter((row) => matchesFilter(row, query));
}
