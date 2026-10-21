// The stored half of the minimap, which is one switch.
//
// Split from monaco.js for the same reason cellactions.js is: reading a setting
// reaches store.js, which reaches Neutralino. What the switch *does* is in
// monaco.js, where the editor is.

import { getSetting } from "../store.js";

export const MINIMAP_KEY = "minimap";

/**
 * Whether Monaco draws the minimap at the editor's right edge.
 *
 * On by default, which is Monaco's own default.
 */
export function minimapShown() {
  const stored = getSetting(MINIMAP_KEY, true);
  return typeof stored === "boolean" ? stored : true;
}
