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
 * Saving through a symlink used to destroy it. std::filesystem::rename replaces
 * the *link*, not its target, so a `part.py` symlinked into a repository became
 * an ordinary file holding the content while the real file silently stopped
 * receiving edits - and the editor reported a successful save every time.
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

/** A file's permissions, or null when there is no file there yet. */
async function permissionsOf({ filesystem }, path) {
  try {
    return await filesystem.getPermissions(path);
  } catch {
    // A new file. Whatever the platform gives it is right.
    return null;
  }
}

/**
 * Put the original permissions back on a file that has just been replaced.
 *
 * The temporary is created fresh, so it carries the default mode rather than
 * the target's: a script the user had made executable, or a file deliberately
 * kept at 0600, quietly became 0644 on every save.
 *
 * Reported rather than thrown. The content is already safely in place, and
 * losing a mode is not worth failing a save that otherwise worked.
 */
async function restorePermissions({ filesystem, log }, path, permissions) {
  if (permissions === null) {
    return;
  }
  try {
    await filesystem.setPermissions(path, permissions, "REPLACE");
  } catch (error) {
    log.warn(`Saved ${path} but could not restore its permissions:`, error);
  }
}

/** Remove a temporary, tolerating one that was never created. */
async function discardTemporary({ filesystem }, temporary) {
  try {
    await filesystem.remove(temporary);
  } catch {
    // It is not there, which is the common case and not a problem.
  }
}

/**
 * The scratch name to write beside the target.
 *
 * Named for the instance, because two windows can have the same file open and
 * a shared scratch name makes their saves collide: one overwrites the other's
 * temporary and then moves it into place, so a save that reported success
 * wrote the other window's content. The identity is the same one the log
 * stamps its lines with, passed in rather than imported because this module
 * takes its whole world as arguments.
 */
function temporaryFor({ instanceId }, path) {
  return `${path}.${instanceId}.b123d-tmp`;
}

/** What is in a file now, or null when there is nothing there to lose. */
async function contentOf({ filesystem }, path) {
  try {
    return await filesystem.readFile(path);
  } catch {
    // No file yet, which is a Save As or a new file. Nothing to put back.
    return null;
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
  try {
    if (original === null) {
      await filesystem.remove(path);
    } else {
      await filesystem.writeFile(path, original);
    }
  } catch (error) {
    log.error(`${path} could not be put back as it was:`, error);
  }
}

/**
 * Write a file without ever truncating the existing one.
 *
 * writeFile opens the target and truncates it before the new contents are
 * there, so a crash, a full disk or the process being killed mid-write leaves a
 * half-written .py. Writing beside it and moving into place means the target is
 * either the old file or the new one, never a fragment.
 *
 * The temporary lives in the same directory deliberately: a move within one
 * filesystem is a rename, while /tmp would be a copy across devices and no
 * better than writing directly.
 *
 * What this does *not* promise: nothing is fsynced, because Neutralino offers
 * no way to. The guarantee is against this process dying or being killed, not
 * against losing power - after a power cut the directory entry can point at a
 * file whose contents never reached the disk. Worth stating, because "atomic
 * save" is usually read as the stronger claim.
 *
 * The fallback is not decoration. std::filesystem::rename onto an existing file
 * is well defined on POSIX and not on Windows, and there is no Windows machine
 * here to find that out on. It covers the temporary write as well as the move,
 * which is a fix rather than tidying: with the write outside the try, a
 * writable file in a non-writable directory - the file accepts a write, the
 * directory refuses a new entry - stopped saving at all the day the atomic
 * write landed, having saved perfectly well before it.
 *
 * @returns {Promise<string>} the path actually written, symlinks resolved
 */
export async function writeFileSafely(deps, requestedPath, content) {
  const { filesystem, log } = deps;
  const path = await resolveTarget(deps, requestedPath);
  const temporary = temporaryFor(deps, path);
  const permissions = await permissionsOf(deps, path);

  // Whether the temporary holds the whole of the user's work, which is what
  // decides between deleting it and telling the user where it is.
  let temporaryIsComplete = false;

  try {
    await filesystem.writeFile(temporary, content);
    temporaryIsComplete = true;
    await filesystem.move(temporary, path);
    await restorePermissions(deps, path, permissions);
    return path;
  } catch (error) {
    log.warn("Could not save through a temporary file, writing directly:", error);
  }

  // What is on disk now, read before anything empties it.
  //
  // The direct write below is not atomic - that is the whole point of it - so
  // if it fails, the file it was replacing is already gone. That is the one
  // outcome this module exists to prevent, and it is reachable: a full disk
  // refuses the temporary and can refuse this too. Held here so it can be put
  // back, which turns a failed save from "the file is destroyed" into "the
  // file is as it was and the buffer is still modified".
  //
  // Cheap, and only on this path. A source file is small and the fallback runs
  // only once something has already gone wrong.
  const original = await contentOf(deps, path);

  try {
    await filesystem.writeFile(path, content);
  } catch (error) {
    await putBack(deps, path, original);
    if (temporaryIsComplete) {
      // Both writes failed, and the temporary is now the only copy of the work.
      // Naming it is the entire value left here.
      log.error(`Save failed. Your content is in ${temporary}`);
      throw new Error(`${path} could not be saved. Your content is in ${temporary}`,
        { cause: error });
    }
    // The temporary never completed, so it is a truncated fragment rather than
    // a copy of anything. Left beside the user's source it would be litter that
    // looks like a backup.
    await discardTemporary(deps, temporary);
    throw error;
  }

  await restorePermissions(deps, path, permissions);
  await discardTemporary(deps, temporary);
  return path;
}
