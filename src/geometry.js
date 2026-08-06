// Where the window should open, given where it was left and what screens exist.
//
// Pure, and separated for the usual reason: every way this goes wrong is a
// decision rather than an API call. A remembered position belongs to a monitor
// that may not be attached now - a laptop undocked, a second screen unplugged,
// a resolution changed - and restoring it faithfully puts the window somewhere
// the user cannot reach it. There is no keyboard shortcut for "bring back the
// window that opened at x=3000 on a screen that is gone".
//
// Why this exists at all: Neutralino remembers geometry in
// .tmp/window_state.config.json *beside its own binary*. The path is hardcoded.
// So it survives a restart and is lost on every new install - unpack a new
// version and the window opens at the shipped default, which reads as the
// layout having been forgotten. Everything else this application remembers goes
// to the per-user directory precisely so an update cannot take it, and the
// window is now no exception.

/** Nothing smaller is worth restoring; it matches the config's minimums. */
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

/** How much of the window must be on a screen for it to be reachable. */
const VISIBLE_MARGIN = 80;

/**
 * Whether a stored value is a usable pixel count.
 *
 * settings.json is a file people edit, and a width of "1600" or null must not
 * reach setSize - which would either throw or size the window to nothing.
 */
function isSize(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether the remembered geometry can be used as it stands.
 *
 * @param {object|null} stored what was saved
 * @param {Array<{x: number, y: number, width: number, height: number}>} displays
 */
export function usableGeometry(stored, displays) {
  if (stored === null || typeof stored !== "object") {
    return null;
  }
  const { width, height, x, y } = stored;
  if (!isSize(width) || !isSize(height)) {
    return null;
  }

  const geometry = {
    width: Math.max(MIN_WIDTH, Math.round(width)),
    height: Math.max(MIN_HEIGHT, Math.round(height)),
  };

  // The position is optional and separately validated: a window whose size is
  // remembered and whose monitor is gone should still open at the right size,
  // centred by the window manager, rather than losing both facts.
  if (isCoordinate(x) && isCoordinate(y) && onSomeDisplay(x, y, displays)) {
    geometry.x = Math.round(x);
    geometry.y = Math.round(y);
  }
  return geometry;
}

/**
 * Whether that corner lands somewhere a person can reach.
 *
 * The test is the *title bar* rather than the whole window: a window may
 * legitimately hang off the right or bottom of a screen, but if its top-left is
 * outside every display there is nothing left to drag it back by.
 */
function onSomeDisplay(x, y, displays) {
  if (!Array.isArray(displays) || displays.length === 0) {
    // Nothing to check against - answering "no" would throw away a perfectly
    // good position because a query failed.
    return true;
  }
  return displays.some((display) => {
    const left = display?.x ?? 0;
    const top = display?.y ?? 0;
    const width = display?.width ?? 0;
    const height = display?.height ?? 0;
    return x >= left - VISIBLE_MARGIN
      && y >= top - VISIBLE_MARGIN
      && x <= left + width - VISIBLE_MARGIN
      && y <= top + height - VISIBLE_MARGIN;
  });
}

/**
 * What to write down, given what the window reports.
 *
 * Returns null when there is nothing worth saving, so a failed query does not
 * overwrite a good remembered geometry with rubbish. A maximised window records
 * that fact and keeps the size it would return to, which is what every editor
 * does - restoring a maximised window as a 1600x1000 one in the corner would be
 * a strange answer to "put it back".
 */
export function geometryToStore({ size, position, maximized }) {
  if (size === null || size === undefined) {
    return null;
  }
  const { width, height } = size;
  if (!isSize(width) || !isSize(height)) {
    return null;
  }
  const stored = { width: Math.round(width), height: Math.round(height) };
  if (position !== null && position !== undefined
      && isCoordinate(position.x) && isCoordinate(position.y)) {
    stored.x = Math.round(position.x);
    stored.y = Math.round(position.y);
  }
  if (maximized === true) {
    stored.maximized = true;
  }
  return stored;
}
