// Where the window should open, given where it was left.
//
// Pure, and separated for the usual reason: what goes wrong here is a decision
// rather than an API call. settings.json is a file people edit, so a stored
// size has to be a usable number before it reaches setSize.
//
// The position is restored as it was saved, on whatever screen that was.
// Whether that screen is still attached cannot be checked: Neutralino's
// computer.getDisplays reports each display's resolution, dpi and refresh rate
// but not where it sits, so a second monitor's place is unknown.
//
// The geometry is kept in settings.json, in the per-user directory an update
// cannot take, like everything else this application remembers. Neutralino's
// own memory of it is switched off; windowstate.js says why.

/** Nothing smaller is worth restoring; it matches the config's minimums. */
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

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
 */
export function usableGeometry(stored) {
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

  // The position is optional and separately validated: without one the window
  // opens where the config puts it, centred, at the remembered size.
  if (isCoordinate(x) && isCoordinate(y)) {
    geometry.x = Math.round(x);
    geometry.y = Math.round(y);
  }
  return geometry;
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
