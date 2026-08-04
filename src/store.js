import { filesystem } from "@neutralinojs/lib";

import { appDataDir } from "./bootstrap/envroot.js";
import { mergeSetting } from "./merge.js";

// UI preferences - theme, splitter fractions, package sources.
//
// This exists instead of Neutralino.storage, which writes one file per key into
// a .storage directory *inside the application's own directory*. That makes the
// installation unwritable-hostile for no benefit: a .app dragged to
// /Applications, an AppImage mount and an install under Program Files are all
// read-only, and on macOS writing into the bundle would break a signature.
//
// One JSON file next to the environment instead. It deliberately sits beside
// runtime/ rather than inside it, so deleting the environment to rebuild it -
// which the info dialog tells people to do - does not also throw away the
// layout and theme.
//
// Values are stored as-is rather than as strings, which is the other reason not
// to use Neutralino.storage: its API is string-only, so every caller had to
// JSON.stringify and JSON.parse around it.

const FILE_NAME = "settings.json";

let path = null;
let values = {};
// Writes are chained rather than fired in parallel: two settings changed in the
// same gesture (drag a splitter, which moves two fractions) would otherwise
// race on the same file.
let pending = Promise.resolve();

/** Load the settings file. Safe to call before anything reads a setting. */
export async function initStore() {
  path = `${await appDataDir()}/${FILE_NAME}`;
  try {
    const parsed = JSON.parse(await filesystem.readFile(path));
    if (typeof parsed === "object" && parsed !== null) {
      values = parsed;
    }
  } catch {
    // No file yet, or it was damaged. Defaults apply either way; a damaged file
    // is overwritten by the next write rather than reported, because losing a
    // splitter position is not worth interrupting startup for.
  }
}

/**
 * @param {string} key
 * @param {*} fallback returned when the key has never been set
 */
export function getSetting(key, fallback = null) {
  if (!Object.hasOwn(values, key)) {
    return fallback;
  }
  return values[key];
}

/**
 * Write one key, keeping whatever else is on disk.
 *
 * Re-reading rather than writing the in-memory copy is what makes a second
 * instance safe. `values` is a snapshot taken when this instance started, so
 * writing all of it back means every key another instance has changed since is
 * reverted to what it was at this one's startup - and that is not a race, it
 * happens on every write. One window changing the theme and the other dragging
 * a splitter is enough to lose the theme.
 *
 * The read is deliberately not merged back into `values`: adopting another
 * instance's theme or splitter fractions mid-session would change this window
 * because the other one was touched, which is not what either user asked for.
 * This is about not destroying the other value, not about tracking it.
 */
async function persist(key) {
  let onDisk = null;
  try {
    onDisk = await filesystem.readFile(path);
  } catch {
    // No file yet. mergeSetting falls back to this instance's own copy.
  }
  const merged = mergeSetting(onDisk, values, key);
  await filesystem.writeFile(path, JSON.stringify(merged, null, 2));
}

/** Set a value and persist it. Resolves once it is on disk. */
export function setSetting(key, value) {
  values[key] = value;
  if (path === null) {
    // Before initStore(): keep the value in memory so the session is correct,
    // and let the next write flush it.
    return Promise.resolve();
  }
  pending = pending
    .then(() => persist(key))
    .catch((error) => console.warn("Could not persist settings:", error));
  return pending;
}
