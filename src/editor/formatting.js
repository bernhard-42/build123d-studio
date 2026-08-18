// The stored half of formatting, which is one number.
//
// Split from format.js exactly as debug/settings.js is split from the debug
// logic: reading a setting means reaching store.js, which reaches Neutralino,
// and a module that does that has no tests. Everything that can be wrong about
// the value lives next door in format.js instead.

import { getSetting } from "../store.js";
import { usableLineLength } from "./format.js";

export const LINE_LENGTH_KEY = "formatLineLength";
export const FORMAT_ON_SAVE_KEY = "formatOnSave";

/** The line length ruff is asked for, and the column the ruler is drawn at. */
export function formatLineLength() {
  return usableLineLength(getSetting(LINE_LENGTH_KEY));
}

/**
 * Whether Cmd-S formats before it writes.
 *
 * On by default, which is a deliberate choice rather than an oversight: a
 * formatter nobody remembers to press is a file that drifts, and every editor
 * that ships this ships it as the thing people turn on first. It is safe in the
 * way that matters here - ruff changes layout and never meaning, the result is
 * one undo away, and a buffer that does not parse is left exactly as it is
 * rather than half-formatted.
 */
export function formatOnSave() {
  const stored = getSetting(FORMAT_ON_SAVE_KEY, true);
  return typeof stored === "boolean" ? stored : true;
}
