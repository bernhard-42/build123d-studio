// The variable explorer's arithmetic: which row is which, which page is shown,
// and how wide the columns are.
//
// Separated from the pane itself because none of it needs a DOM, and all of it
// is the sort of thing that is quietly wrong by one - an off-by-one in a page
// offset shows up as a row that is silently never reachable, which is exactly
// the class of bug nobody reports because it looks like the data.

/**
 * A row's identity, as one string.
 *
 * Rows are addressed by path: a variable name, then an ordinal per level -
 * ["a", 3, 0] is the first child of the fourth child of `a`. Ordinals rather
 * than keys, because a dict key may be a tuple, a Vector, or anything else with
 * no faithful text form, and the position is what the pane is showing anyway.
 *
 * JSON rather than a join, because a variable name can contain anything a
 * Python identifier can and a separator is a thing to collide with.
 */
export function pathKey(path) {
  return JSON.stringify(path);
}

/** Whether one path is the same row as another. */
export function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

/** Whether `path` lies under `ancestor` - used to drop a closed subtree. */
export function isUnder(path, ancestor) {
  if (path.length <= ancestor.length) {
    return false;
  }
  return pathKey(path.slice(0, ancestor.length)) === pathKey(ancestor);
}

/**
 * What the pager should say and offer, for a page of children.
 *
 * `page` is the size the kernel used, which arrives with the reply rather than
 * being assumed here: the last page is short, so the number of children in hand
 * gives the right step forwards and the wrong one back.
 *
 * Returns null when everything fits, because a pager under a list of three is
 * furniture that says nothing.
 *
 * @param {{offset?: number, total?: number, page?: number, count: number}} reply
 */
export function pageInfo({ offset = 0, total = 0, page = 100, count = 0 }) {
  if (!Number.isInteger(total) || total <= count) {
    return null;
  }
  const first = offset + 1;
  const last = offset + count;
  return {
    // One-based and inclusive, because that is how a person reads "1–100 of
    // 5000" - the offsets stay zero-based everywhere they are arithmetic.
    label: `${first}–${last} of ${total}`,
    hasPrev: offset > 0,
    hasNext: last < total,
    prevOffset: Math.max(0, offset - page),
    nextOffset: last,
  };
}

// The three columns, and the least each may be squeezed to. A column dragged to
// nothing cannot be dragged back, because there is no handle left to grab.
const MIN_WIDTH = 8;
const DEFAULTS = { name: 30, type: 26 };

/**
 * Column widths as percentages, from whatever settings.json holds.
 *
 * Only the first two are stored: the last takes the remainder, so there is no
 * arrangement in which the three fail to add up. Both are clamped, and a stored
 * value that is not a number at all falls back to the default rather than
 * producing a table with a NaN in it - settings.json is a file a user may edit.
 */
export function columnWidths(stored) {
  const held = stored === null || stored === undefined ? {} : stored;
  const name = clamp(held.name, DEFAULTS.name);
  const type = clamp(held.type, DEFAULTS.type);
  // The repr column keeps what is left, and is never allowed to vanish either.
  if (name + type > 100 - MIN_WIDTH) {
    return DEFAULTS;
  }
  return { name, type };
}

function clamp(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(100 - 2 * MIN_WIDTH, Math.max(MIN_WIDTH, value));
}

/**
 * Where a drag puts a boundary, as a percentage of the table.
 *
 * The boundary between name and type moves the first column; the one between
 * type and repr moves the second. Both are clamped so neither the column being
 * resized nor the one after it can be squeezed away.
 *
 * @param {"name"|"type"} column which boundary was dragged
 * @param {{name: number, type: number}} widths the widths before the drag
 * @param {number} fraction where the pointer is, 0..1 across the table
 */
export function resized(column, widths, fraction) {
  const percent = fraction * 100;
  if (column === "name") {
    const name = Math.min(100 - 2 * MIN_WIDTH - widths.type, Math.max(MIN_WIDTH, percent));
    return { ...widths, name };
  }
  const type = Math.min(100 - MIN_WIDTH - widths.name, Math.max(MIN_WIDTH, percent - widths.name));
  return { ...widths, type };
}
