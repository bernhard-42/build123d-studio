// What Run -> Test reads out of settings.json.
//
// A module of its own for the same reason debug/settings.js is one: the
// alternative is file.js importing the settings dialog and the dialog importing
// file.js - a cycle for the sake of a boolean.

import { getSetting } from "../store.js";

export const IGNORE_WARNINGS_KEY = "testIgnoreWarnings";

/**
 * Whether a test run is given `-W ignore`.
 *
 * Off by default, which is pytest's own behaviour and the honest one: a
 * DeprecationWarning out of build123d or OCP is something the person running
 * the suite should see at least once. It is also the noise that makes a summary
 * unreadable when a hundred tests each raise the same one, which is why the
 * switch exists at all - and why it is a setting rather than a guess made per
 * run.
 */
export function ignoreWarnings() {
  const stored = getSetting(IGNORE_WARNINGS_KEY, false);
  return typeof stored === "boolean" ? stored : false;
}
