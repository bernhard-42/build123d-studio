// The order of the variable explorer's top-level rows.
//
// Pure, as filter.js is. The kernel sends rows in the namespace's own order,
// which is the order things were defined in and is worth keeping as the
// default: it reads as the script does. A click on Name or Type sorts by that
// column, a second click reverses it, a third goes back to the kernel's order.
// Children are never sorted - a list's items are in their positions.

/** @typedef {{column: "name"|"type", direction: "asc"|"desc"}|null} Order */

/**
 * What a click on a column header makes of the current order.
 *
 * @param {Order} order
 * @param {"name"|"type"} column
 * @returns {Order}
 */
export function nextOrder(order, column) {
  if (order === null || order.column !== column) {
    return { column, direction: "asc" };
  }
  if (order.direction === "asc") {
    return { column, direction: "desc" };
  }
  return null;
}

/**
 * The rows in the given order; the kernel's order when there is none.
 *
 * Case-insensitive, so `Box` and `box` sit together; ties keep the kernel's
 * order, which is what a stable sort gives.
 *
 * @param {Array<{name: string, type?: string}>} rows
 * @param {Order} order
 */
export function sortRows(rows, order) {
  if (order === null) {
    return rows;
  }
  const key = (row) => String(row[order.column] ?? "").toLowerCase();
  const sign = order.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    if (x === y) {
      return 0;
    }
    return x < y ? -sign : sign;
  });
}
