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
// bytes wanted. The path it belongs to goes in a separate file of about sixty
// bytes, rewritten only when it changes, which is a Save As and nothing else.
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
 * Nothing on the keystroke path does I/O, but the copy itself is a
 * JSON.stringify of the whole buffer and an IPC payload of the same size, and
 * both are O(size) on the main thread. Files above ten megabytes only *ask*
 * before opening rather than being refused, so without a cap the worst case is
 * whatever somebody said yes to - a 32 MB buffer serialised every second while
 * they type in it, which would be felt in the editor and is exactly what this
 * must not do.
 *
 * Two megabytes is far above any plausible Python source - forty thousand lines
 * is about one - so in practice this bounds the pathological case and no other.
 * A buffer past it is said so in the log once, because silently having no
 * recovery is worse than having none.
 *
 * Characters rather than bytes: it is a bound, not an accounting, and length is
 * free where encoding the whole string to measure it is not.
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
 */
export async function recordBuffer(deps, key, { path, text, withPath = true }) {
  const { filesystem, log, root } = deps;
  try {
    await filesystem.createDirectory(root);
  } catch {
    // Already there, which is every time after the first.
  }
  // The document, exactly as it is. No transformation on the hot path.
  await writeFileSafely(deps, textPath(root, key), text);
  if (withPath) {
    await writeFileSafely(deps, metaPath(root, key), JSON.stringify({ path }));
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

    pending() {
      return timers.size;
    },
  };
}

/**
 * How often a window says it is still here, and how long before it is not.
 *
 * The frontend has no lock. The sidecar does - instance.py holds one for its
 * whole life and the operating system releases it on any death, including a
 * kill - but recovery has to run at startup, and the sidecar is spawned last,
 * after the window is already usable. So liveness here is a file whose
 * modification time is refreshed while the window runs.
 *
 * Stale is three missed beats rather than one, because the cost of the two
 * mistakes is not symmetric: calling a live sibling dead offers somebody their
 * own unsaved work back while they are typing it, and calling a dead session
 * live only defers the offer to the next start.
 */
export const BEAT = 30 * 1000;
export const STALE_AFTER = 3 * BEAT;

const ALIVE = "alive";

/** Say this window is still running. Costs one write of nothing. */
export async function beat({ filesystem, log, root }) {
  try {
    await filesystem.createDirectory(root);
  } catch {
    // Already there.
  }
  try {
    await filesystem.writeFile(`${root}/${ALIVE}`, "");
  } catch (error) {
    log.warn("Could not mark this session as running:", error);
  }
}

/**
 * Whether a journal belongs to a session that is no longer running.
 *
 * A directory with no beat at all is dead: it was written by a version that
 * did not beat, or the beat never landed. Both mean nobody is refreshing it.
 */
export function isStale(beatAt, now, staleAfter = STALE_AFTER) {
  if (beatAt === null || beatAt === undefined) {
    return true;
  }
  return now - beatAt > staleAfter;
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
    try {
      path = JSON.parse(await filesystem.readFile(`${root}/${key}.json`)).path ?? null;
    } catch {
      // No label, so it recovers as an untitled buffer. Better than not at all.
    }
    entries.push({ key, path, text, file: `${root}/${name}` });
  }
  return entries;
}
