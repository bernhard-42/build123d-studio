// Saving a file, which is the one thing in this application that can destroy
// work the user cannot get back.
//
// It lives in its own module for the same reason quoting.js does: the logic is
// pure given a filesystem, every branch in it is a decision about a file that
// may be the only copy of something, and none of it can be exercised through
// the application without a person sitting in front of it. Taking `filesystem`
// and `log` as arguments rather than importing them is what lets the branches
// be tested from node - files.js passes the real ones, safewrite.test.mjs
// passes a filesystem that fails wherever a real one might.

/**
 * The real file behind a path, with any symlinks resolved.
 *
 * The write below goes through a symlink of its own accord - opening one opens
 * its target - so this is not what keeps a link intact. It is what the caller
 * is told: a save reports the file it actually wrote, so a `part.py` symlinked
 * into a repository names the file in the repository.
 *
 * getJoinedPath is the resolver, which is not where anyone would look for it:
 * Neutralino implements it with std::filesystem::weakly_canonical, while
 * getAbsolutePath is std::filesystem::absolute and resolves nothing. "Weakly"
 * is what makes it safe for Save As, where the target does not exist yet - the
 * leading part that does exist is canonicalised and the rest is left alone.
 *
 * A failure here is not fatal. An unresolvable path is one the write is about
 * to fail on anyway, and failing with the path the user typed is better than
 * failing with a different one.
 */
async function resolveTarget({ filesystem, log }, path) {
  try {
    return await filesystem.getJoinedPath(path);
  } catch (error) {
    log.warn("Could not resolve the save target, using the path as given:", error);
    return path;
  }
}

/**
 * What is in a file now: its text, or that there is nothing there, or neither.
 *
 * Three answers rather than two, because the difference decides whether the
 * failed write below may delete what it wrote over. A path that does not exist
 * can be removed if a write half-creates it. A path that exists but cannot be
 * *read* - a directory somebody put there, a file the platform is refusing -
 * must never be removed: it holds something, and this module has no idea what.
 *
 * @returns {Promise<{text: string|null, exists: boolean}>}
 */
async function contentOf({ filesystem }, path) {
  try {
    return { text: await filesystem.readFile(path), exists: true };
  } catch {
    // Unreadable, so ask a cheaper question: is anything there at all?
  }
  try {
    await filesystem.getStats(path);
    return { text: null, exists: true };
  } catch {
    // Nothing there, which is a Save As or a new file.
    return { text: null, exists: false };
  }
}

/**
 * Undo a direct write that failed, so the file is as it was.
 *
 * writeFile opens the target and empties it before the new content is there,
 * so a write that fails has already destroyed whatever was in it. That is the
 * one outcome this module exists to prevent, and on the fallback path it is
 * reached exactly when the filesystem is already refusing things - so this is
 * best effort by nature and says so rather than throwing over it.
 */
async function putBack({ filesystem, log }, path, original) {
  if (original.text === null && original.exists) {
    // Something is there and we could not read it, so we cannot put it back -
    // and removing it would destroy whatever it is. Leaving it is the only
    // honest answer; the caller is already throwing.
    log.error(`${path} exists but could not be read, so it was left alone`);
    return;
  }
  try {
    if (original.text === null) {
      await filesystem.remove(path);
    } else {
      await filesystem.writeFile(path, original.text);
    }
  } catch (error) {
    log.error(`${path} could not be put back as it was:`, error);
  }
}

/**
 * Write a file in place, keeping it the same file.
 *
 * The obvious alternative - write a temporary beside it and rename it over the
 * target - is what this used to do, and it is what makes a save atomic: the
 * path is either the old file or the new one, never a fragment. It also
 * replaces the inode, and that is not a detail. A hard link to the file keeps
 * the old contents for ever, extended attributes go (on macOS that includes
 * Finder tags and labels), and so do ownership and ACLs. Measured: after one
 * save, `part.py` and a hard link to it had different inodes and different
 * text.
 *
 * Users expect a file to stay the file they linked or tagged, and every editor
 * they compare this one to keeps it. So the file is opened and written, and its
 * identity is preserved by never replacing it.
 *
 * **What replaces the atomicity is the recovery journal.** The copy of a
 * modified buffer is written when typing stops and is dropped only after a save
 * has *succeeded*, so a process killed mid-write leaves the journal holding the
 * work - see files.js, bufferSettled. Two gaps in that, and both are stated
 * rather than hidden: anything typed since the last journal beat is not in the
 * copy, and a buffer past MAX_RECORDED_CHARS has no copy at all.
 *
 * A write that *fails* is covered here rather than by the journal. writeFile
 * opens the target and empties it before the new content arrives, so a full
 * disk destroys the file it was replacing; the original is read into memory
 * first and put back if the write throws, which turns that into "the file is as
 * it was and the buffer is still modified".
 *
 * Permissions need no restoring now. The mode belongs to the file, and the file
 * is the same one it was.
 *
 * @returns {Promise<string>} the path actually written, symlinks resolved
 */
export async function writeFileSafely(deps, requestedPath, content) {
  const { filesystem } = deps;
  const path = await resolveTarget(deps, requestedPath);

  // Read before anything empties it, and only for as long as the write takes.
  // A source file is small; this is the copy that makes a failed write
  // recoverable.
  const original = await contentOf(deps, path);

  try {
    await filesystem.writeFile(path, content);
  } catch (error) {
    await putBack(deps, path, original);
    throw error;
  }

  return path;
}
