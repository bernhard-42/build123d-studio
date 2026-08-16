// Whether the file under a buffer is still the one that was loaded.
//
// Nothing compared anything before this. openPath deliberately never re-reads a
// file that is already open - switching to a tab must not throw away what is in
// it - and the only external change ever noticed was deletion, on a manual tree
// refresh. So editing a file in another program, or in a second window of this
// one, and then saving here replaced those edits without a word.
//
// Two windows on one project is a supported workflow and the second editor need
// not even be this application: a formatter, a git checkout, a script that
// rewrites a parameter. The cost of missing it is somebody else's work.
//
// Pure, and apart from the filesystem, for the same reason quoting.js is: what
// is worth testing is the decision, not the reading.

/**
 * What is worth remembering about a file, from a stat of it.
 *
 * Size and modification time together rather than either alone. A size alone
 * misses an edit that replaced a character; a time alone misses a filesystem
 * whose clock is coarse, and on some of them it is a whole second.
 *
 * Deliberately not a hash. That means reading every open file on every save, and
 * the thing being defended against is an edit somebody made, not a bit flip.
 *
 * **The time is kept only when it is a real number.** Neutralino's Stats type
 * declares modifiedAt on every platform, but a type declaration is a promise
 * rather than a measurement, and the failure if it is wrong somewhere is the
 * worst kind: two absent values compare equal, so every file looks unchanged
 * and nothing is ever detected. Recording null instead makes that visible to
 * changedSince, which then says what it can say from the size alone. Whether
 * any platform actually needs this is a question for tests/manual.md, not for
 * a guess here.
 *
 * @returns {{size: number, modifiedAt: number|null}|null} null when there is no file.
 */
export function stampOf(stats) {
  if (stats === null || stats === undefined) {
    return null;
  }
  // Zero counts as absent. It is a real epoch value - the first of January
  // 1970 - and a file will not have it, whereas a platform that does not fill
  // the field in will. Read the other way round it is the silent failure again:
  // every file stamped zero, every comparison equal, nothing ever detected.
  const usable = typeof stats.modifiedAt === "number"
    && Number.isFinite(stats.modifiedAt)
    && stats.modifiedAt !== 0;
  const modifiedAt = usable ? stats.modifiedAt : null;
  return { size: stats.size, modifiedAt };
}

/** Whether a stamp carries a usable modification time, for saying so once. */
export function hasTimestamp(stamp) {
  return stamp !== null && stamp !== undefined && stamp.modifiedAt !== null;
}

/**
 * Whether the file moved underneath us since it was last read or written.
 *
 * Answers false whenever it cannot know, which is the important half:
 *
 * - **Nothing recorded.** A buffer with no stamp was never loaded from a file -
 *   an untitled one, or a Save As to a name that did not exist. There is
 *   nothing it could have diverged from.
 * - **Nothing there now.** The file has been deleted since. Saving it writes it
 *   back, which is what somebody pressing Cmd-S over a struck-through tab is
 *   asking for, and a prompt about a file that no longer exists could only
 *   offer to reload nothing.
 *
 * A false negative here is one save; a false positive is a dialog in front of
 * somebody whose file nobody touched, on every save, which is how a warning
 * becomes something people click through without reading.
 */
export function changedSince(recorded, current) {
  if (recorded === null || recorded === undefined) {
    return false;
  }
  if (current === null || current === undefined) {
    return false;
  }
  if (recorded.size !== current.size) {
    return true;
  }
  if (recorded.modifiedAt === null || current.modifiedAt === null) {
    // No usable time from this platform, so the size is the whole of what can
    // be known - and the sizes match. Degraded rather than broken: an edit that
    // changed the length is still caught, one that replaced a character is not.
    return false;
  }
  return recorded.modifiedAt !== current.modifiedAt;
}
