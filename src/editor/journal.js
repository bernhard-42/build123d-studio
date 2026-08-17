// A copy of what is unsaved, for the ends that ask nobody.
//
// Every graceful exit already prompts: the window's close button, Cmd-Q, the
// menu, Open Folder, closing a tab. What none of them covers is the end that
// runs no JavaScript at all - a webview that dies, a kill, an OS logout that
// never delivers windowClose, a power cut. After one of those, every unsaved
// edit and every untitled buffer is simply gone, because the workspace stores
// paths and nothing else.
//
// So dirty buffers are shadowed into the application's own data directory as
// they are typed, and the copy is removed the moment it stops being the only
// one - a successful save, a closed tab, a graceful quit. What is left over at
// the next start therefore means exactly one thing: that instance ended without
// being asked.
//
// One file per buffer, and no index. An index would be a read-modify-write on
// every keystroke burst and a single file whose loss takes every entry with it;
// separate files mean a partial write costs one buffer rather than all of them.
// They go through writeFileSafely for the same reason source files do: a
// half-written recovery copy is worse than none, because it looks like a copy.
//
// **The copy is the text, unwrapped.** Not JSON with the text inside it: that
// escapes the whole document into a second string of its own size, ships a
// bigger payload, and makes recovery parse all of it back - three passes over
// the buffer, on the main thread, for something that is already exactly the
// bytes wanted. What the copy belongs to - its path, and the stamp the buffer
// last agreed with disk on - goes in a small JSON file beside it, rewritten
// only when it changes, which is a Save As and nothing else.
//
// It also means a recovery copy is an ordinary source file. Somebody who does
// not trust the prompt, or who wants it while the application is not running,
// can open it in any editor - which a JSON envelope would have taken away.
//
// Untitled buffers are included, and are the ones that matter most - they have
// no other copy anywhere on disk.

import { writeFileSafely } from "./safewrite.js";

/**
 * How long a burst of typing is allowed to run before a copy is made.
 *
 * It is also exactly how much work a crash can cost, which is the number worth
 * choosing deliberately: a second of typing. Shorter buys very little and costs
 * a write per second of every editing session; longer starts to be work
 * somebody would notice losing.
 */
export const RECORD_DELAY = 1000;

/**
 * Past this, a buffer is not shadowed at all.
 *
 * The copy is one IPC payload of the buffer's size, on the main thread. Files
 * over ten megabytes only *ask* before opening, so without a cap the worst case
 * is whatever somebody said yes to - a 32 MB buffer written every second while
 * they type in it. Two megabytes is far above any plausible Python source
 * (forty thousand lines is about one), so this bounds that case and no other,
 * and the log says so once when it bites.
 *
 * Characters, not bytes: it is a bound, not an accounting.
 */
export const MAX_RECORDED_CHARS = 2 * 1024 * 1024;

/** Whether a buffer is small enough to be worth shadowing on every burst. */
export function worthRecording(text) {
  return typeof text === "string" && text.length <= MAX_RECORDED_CHARS;
}

/** Where one instance's copies live. Per instance, so two windows never mix. */
export function journalRoot(dataDir, instanceId) {
  return `${dataDir}/recovery/${instanceId}`;
}

/** The document itself. */
function textPath(root, key) {
  return `${root}/${key}.py`;
}

/** Which file it belongs to, or that it has none. */
function metaPath(root, key) {
  return `${root}/${key}.json`;
}

/**
 * Write one buffer's copy.
 *
 * The path may be null - that is an untitled buffer, and the recovery has to be
 * able to say so rather than invent a name for it.
 *
 * The stamp is what the file looked like when this buffer last agreed with it,
 * and it travels with the copy so that recovering one restores the
 * changed-on-disk check along with the text. Without it a recovered buffer has
 * nothing to compare against and its first save overwrites whatever is there
 * now - which is the case where somebody else has been editing the file since
 * the crash. It does not change while a buffer is dirty, so it is written with
 * the path and not on every burst.
 */
export async function recordBuffer(deps, key, { path, text, stamp = null, withPath = true }) {
  const { filesystem, log, root } = deps;
  try {
    await filesystem.createDirectory(root);
  } catch {
    // Already there, which is every time after the first.
  }
  // The document, exactly as it is. No transformation on the hot path.
  await writeFileSafely(deps, textPath(root, key), text);
  if (withPath) {
    await writeFileSafely(deps, metaPath(root, key), JSON.stringify({ path, stamp }));
  }
  log.info(`Recovery copy written for ${path ?? "an untitled buffer"}`);
}

/**
 * Forget one buffer's copy, because it is no longer the only one.
 *
 * Saved, or closed after being asked about. Tolerates having nothing to remove:
 * a buffer that was never dirty has no entry, and every caller would otherwise
 * have to know which.
 */
export async function forgetBuffer({ filesystem }, root, key) {
  for (const path of [textPath(root, key), metaPath(root, key)]) {
    try {
      await filesystem.remove(path);
    } catch {
      // Nothing recorded for it, which is the ordinary case.
    }
  }
}

/**
 * Throw away this instance's whole journal.
 *
 * For a graceful quit, and the reasoning is the whole design: everything
 * unsaved has just been asked about, so whatever is left was either saved or
 * deliberately discarded. Offering it back at the next start would be arguing
 * with an answer the user already gave.
 */
export async function clearJournal({ filesystem, log }, root) {
  try {
    await filesystem.remove(root);
  } catch (error) {
    // Never fatal: this runs on the way out, and a journal left behind costs a
    // recovery prompt rather than any work.
    log.warn("Could not clear the recovery journal:", error);
  }
}

/**
 * Debounce the writing, so a burst of typing costs one copy.
 *
 * The scheduler is injected so that "one write per burst" is a property a test
 * can assert rather than a delay it has to sit through.
 */
export function createRecorder({ delay = 1000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const timers = new Map();

  return {
    /** Book a copy of this buffer, replacing any booking it already had. */
    schedule(key, write) {
      const existing = timers.get(key);
      if (existing !== undefined) {
        cancel(existing);
      }
      timers.set(key, schedule(() => {
        timers.delete(key);
        write();
      }, delay));
    },

    /** Drop a booking that has been overtaken - by a save, or by a close. */
    drop(key) {
      const existing = timers.get(key);
      if (existing === undefined) {
        return false;
      }
      cancel(existing);
      timers.delete(key);
      return true;
    },

    /** Drop every booking, for a quit that has already asked about all of them. */
    dropAll() {
      for (const timer of timers.values()) {
        cancel(timer);
      }
      timers.clear();
    },

    pending() {
      return timers.size;
    },
  };
}

/**
 * The file that says which process owns this journal.
 *
 * One line, written once: the pid of the window that created the directory.
 * Liveness is a question for the operating system - see liveness.js - and not
 * something this directory asserts.
 *
 * A lock would be better and the frontend cannot hold one: instance.py takes
 * one for the sidecar's whole life and the OS releases it on any death, but
 * Neutralino exposes no locking API, and recovery runs at startup, before the
 * sidecar exists. A pid answers the same question with the same authority, and
 * the window can ask it alone.
 */
const OWNER = "owner";

/**
 * Say which process this journal belongs to. Once, at startup.
 *
 * Before anything is copied into it, so a directory that exists always has an
 * owner. An area holding copies but naming nobody is unattributable, and the
 * only safe reading of that is "dead" - wrong for a window that is merely
 * young.
 */
export async function claim({ filesystem, log, root, pid }) {
  try {
    await filesystem.createDirectory(root);
  } catch {
    // Already there.
  }
  try {
    await filesystem.writeFile(`${root}/${OWNER}`, String(pid));
  } catch (error) {
    log.warn("Could not record which process owns the recovery journal:", error);
  }
}

/**
 * Which process owns a journal, or null when it does not say.
 *
 * Null covers three things a caller must not tell apart by guessing: a
 * directory written by a version that recorded no owner, one whose owner file
 * never landed, and one holding something that is not a pid.
 */
export async function ownerOf({ filesystem }, root) {
  try {
    const said = Number(await filesystem.readFile(`${root}/${OWNER}`));
    return Number.isInteger(said) && said > 0 ? said : null;
  } catch {
    return null;
  }
}

/**
 * When this session last wrote a copy, or 0 if it never did.
 *
 * The newest copy's own modification time, not the directory's: a directory's
 * changes only when an entry is added or removed, which is a property of how
 * the copies happen to be written rather than of when somebody was typing.
 *
 * It orders the prompt, and through that decides which copy of a path wins when
 * two sessions both held it - so it has to mean "last worked in", not "started
 * first".
 */
export async function lastWritten({ filesystem }, root) {
  let names;
  try {
    names = (await filesystem.readDirectory(root)).map((entry) => entry.entry);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const name of names.filter((entry) => entry.endsWith(".py"))) {
    try {
      const stats = await filesystem.getStats(`${root}/${name}`);
      if (typeof stats.modifiedAt === "number" && stats.modifiedAt > newest) {
        newest = stats.modifiedAt;
      }
    } catch {
      // Gone between the listing and the stat. It orders nothing.
    }
  }
  return newest;
}

/**
 * Read one instance's journal: every buffer it had unsaved.
 *
 * Entries whose text cannot be read are skipped rather than failing the whole
 * recovery - one unreadable copy must not cost somebody the other four.
 */
export async function readJournal({ filesystem, log }, root) {
  let names;
  try {
    names = (await filesystem.readDirectory(root)).map((entry) => entry.entry);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names.filter((each) => each.endsWith(".py")).sort()) {
    const key = name.slice(0, -3);
    let text;
    try {
      text = await filesystem.readFile(`${root}/${name}`);
    } catch (error) {
      log.warn(`Could not read a recovery copy at ${root}/${name}:`, error);
      continue;
    }
    let path = null;
    let stamp = null;
    try {
      const meta = JSON.parse(await filesystem.readFile(`${root}/${key}.json`));
      path = meta.path ?? null;
      stamp = meta.stamp ?? null;
    } catch {
      // No label, so it recovers as an untitled buffer. Better than not at all.
    }
    entries.push({ key, path, text, stamp, root, file: `${root}/${name}` });
  }
  return entries;
}

/**
 * Take one copy out of the recovery tree, keeping it as an ordinary file.
 *
 * For the copy that loses a path to a newer one. It is still somebody's work,
 * so it is not deleted - but leaving it where it is would offer it again at
 * every start for ever, because nothing about it will have changed. Moved to
 * the recovery root, which the scan skips: it only descends into directories.
 *
 * @returns the path it now has, or null if it could not be moved
 */
export async function setAside({ filesystem, log }, dataDir, entry) {
  const name = entry.path === null
    ? `untitled-${entry.key}`
    : entry.path.split(/[/\\]/).pop().replace(/\.py$/, "");
  const destination = `${dataDir}/recovery/unrecovered-${name}-${entry.key}.py`;
  try {
    await filesystem.move(entry.file, destination);
    return destination;
  } catch (error) {
    log.warn(`Could not set aside the recovery copy at ${entry.file}:`, error);
    return null;
  }
}
