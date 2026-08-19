// Getting lines onto disk, apart from deciding what to write.
//
// Separated from log.js for the reason quoting.js and safewrite.js are
// separate: it is pure given a filesystem, and the property that matters is one
// no unit test of a single call can show - that two processes appending to one
// file do not remove each other's lines. Testing that needs real files and real
// concurrency, which needs the filesystem to be an argument.
//
// The rule the whole module exists to enforce: **a process only ever adds its
// own lines**. It never reads the file, never rewrites it, and never decides
// what somebody else's lines were worth.

/**
 * Move the log aside once it gets large, rather than emptying it.
 *
 * Renaming is the only bounding step that is safe when several instances are
 * appending. Truncating means deciding what another process's lines were worth,
 * and reading-then-rewriting - which is what this replaced - does exactly that
 * by accident: each instance keeps its own copy of the file and the last writer
 * silently discards everyone else's.
 *
 * Every failure is deliberately ignored. Another instance may have won the same
 * race a millisecond earlier, and on Windows a file another process holds open
 * cannot be renamed at all. In both cases the right answer is to carry on
 * appending to a file that is slightly too big, which costs nothing; some later
 * start will rotate it.
 *
 * @returns {Promise<boolean>} whether the file was actually moved
 */
export async function rotate(filesystem, path, maxBytes) {
  try {
    const stats = await filesystem.getStats(path);
    if (stats.size <= maxBytes) {
      return false;
    }
  } catch {
    // No log yet, so nothing to rotate.
    return false;
  }

  try {
    await filesystem.remove(`${path}.1`);
  } catch {
    // No previous rotation, which is the common case.
  }
  try {
    await filesystem.move(path, `${path}.1`);
    return true;
  } catch {
    // Lost the race, or the file is held open.
    return false;
  }
}

/**
 * Add text to the log, and never do anything else to it.
 *
 * Returns whether it worked rather than throwing: logging must not be able to
 * break its caller, and a failure here has nowhere left to be reported.
 */
export async function append(filesystem, path, text) {
  if (text === "") {
    return true;
  }
  try {
    await filesystem.appendFile(path, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A serial writer that cannot be stopped by one write that never answers.
 *
 * Appends are serialised so two of them cannot interleave mid-line, and that
 * serialisation used to be a plain promise chain - which meant a single append
 * that never settled stopped every later line for the rest of the session.
 * There is a real way for that to happen: `filesystem.appendFile` is a call to
 * the application's own server, whose client resolves calls by id, so a reply
 * lost while the machine was suspended leaves that promise pending for ever.
 * Observed on Windows waking from sleep, 0.3.0.dev174 - the log stopped
 * mid-session while the Backend pane, which is told before the write, carried
 * on.
 *
 * So each write gets a deadline. Passing it does not cancel anything - there is
 * no way to cancel a request already sent - it only stops the *next* line
 * waiting behind it. An abandoned write may still land later and out of order,
 * which is a far smaller price than a log that stops.
 *
 * @param filesystem the object with appendFile, injected so this is testable
 * @param deadline milliseconds to wait before giving up on one write
 * @returns {(path: string, text: string) => Promise<boolean>} whether it landed
 */
export function createWriter(filesystem, deadline) {
  let queue = Promise.resolve();

  return function write(path, text) {
    queue = queue.then(() =>
      Promise.race([
        append(filesystem, path, text),
        new Promise((settle) => {
          setTimeout(() => settle(false), deadline);
        }),
      ]),
    );
    return queue;
  };
}
