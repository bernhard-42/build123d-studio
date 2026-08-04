// What a settings write keeps from the file that is already on disk.
//
// Split out of store.js so it can be tested at all: store.js imports Neutralino
// for filesystem access, and nothing a *.test.mjs reaches may do that. The same
// split as keys/keybindings and tabs/tabstrip - the decision here, the I/O
// there.
//
// The decision is small and it is the whole of the multi-instance fix for
// settings. store.js used to write its entire in-memory copy, and that copy is a
// snapshot taken when the instance started. Two instances therefore reverted
// each other continuously: one window changing the theme and the other dragging
// a splitter is enough to lose the theme, and it is not a race - it happens on
// every write, whatever the timing.

/**
 * Combine the file on disk with the one key this write is for.
 *
 * @param {string|null} diskText the settings file as read, or null if unreadable
 * @param {object} values this instance's in-memory settings
 * @param {string} key the only key this write is entitled to change
 * @returns {object} what should be written back
 */
export function mergeSetting(diskText, values, key) {
  // The in-memory copy is the fallback rather than an empty object. A damaged or
  // unreadable file must not become the reason to discard the settings this
  // session does know about - that would turn one bad write into a reset.
  let merged = { ...values };

  if (typeof diskText === "string") {
    try {
      const parsed = JSON.parse(diskText);
      // A settings file is something a user can open and edit, so a JSON scalar
      // or an array is possible and neither can be merged into. Falling back to
      // the in-memory copy replaces it with something valid.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        merged = parsed;
      }
    } catch {
      // Not JSON at all. Same answer.
    }
  }

  // Last, so this instance's own value for this key wins over whatever the file
  // said about it - the file is authoritative for every key except the one being
  // written.
  merged[key] = values[key];
  return merged;
}
