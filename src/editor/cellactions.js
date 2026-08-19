// The stored half of the cell actions, which is one switch.
//
// Split from monaco.js for the same reason formatting.js is split from
// format.js: reading a setting reaches store.js, which reaches Neutralino.
// What the switch *does* is in monaco.js, where the editor is.

import { getSetting } from "../store.js";

export const CELL_ACTIONS_KEY = "cellActions";

/**
 * Whether the buttons are drawn above each "# %%" marker.
 *
 * On by default. They are how the cell commands are discovered at all - the
 * three this application added for them have no chord out of the box - and
 * somebody who never uses cells has one switch to turn five buttons per marker
 * into none.
 */
export function cellActionsShown() {
  const stored = getSetting(CELL_ACTIONS_KEY, true);
  return typeof stored === "boolean" ? stored : true;
}
