// Which lines the user has marked, per buffer.
//
// Not persisted, deliberately: a breakpoint is a thing you put down for the
// next run and forget, and a file that reopens with last week's breakpoints in
// it is a file that stops somewhere nobody asked for. That decision removes
// storage, migration, and reconciling a stored line against a file that has
// changed underneath it.
//
// The lines here are the record, but they are not the *truth* while a buffer is
// being edited - Monaco moves a decoration when text is inserted above it, and
// this cannot. See monaco.js, which reads the decorations back after every edit
// and hands the result to `replace`.

const byBuffer = new Map();

/** The marked lines of a buffer, ascending. Empty for one that has none. */
export function linesOf(key) {
  const lines = byBuffer.get(key);
  return lines === undefined ? [] : [...lines].sort((a, b) => a - b);
}

/**
 * Add or remove one line. Returns the lines afterwards.
 *
 * A line number below one is not a line; Monaco will not produce one, and
 * silently dropping it is better than a breakpoint the adapter refuses for
 * reasons the user cannot see.
 */
export function toggle(key, line) {
  if (!Number.isInteger(line) || line < 1) {
    return linesOf(key);
  }
  const lines = byBuffer.get(key) ?? new Set();
  if (lines.has(line)) {
    lines.delete(line);
  } else {
    lines.add(line);
  }
  byBuffer.set(key, lines);
  return linesOf(key);
}

/**
 * Replace a buffer's lines wholesale, which is what an edit does.
 *
 * Deduplicated on the way in: two breakpoints can be pushed onto one line by
 * deleting the lines between them, and two identical entries in a
 * setBreakpoints request is a request that describes a file nobody has.
 */
export function replace(key, lines) {
  const kept = new Set(
    (lines ?? []).filter((line) => Number.isInteger(line) && line >= 1),
  );
  if (kept.size === 0) {
    byBuffer.delete(key);
  } else {
    byBuffer.set(key, kept);
  }
  return linesOf(key);
}

/** Forget a buffer, when its tab closes. */
export function forget(key) {
  byBuffer.delete(key);
}

/** Forget everything. */
export function clear() {
  byBuffer.clear();
}

/** Whether a line is marked - what the gutter draws from. */
export function has(key, line) {
  return byBuffer.get(key)?.has(line) === true;
}
