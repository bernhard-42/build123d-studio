// One line per distinct message, with a dot for every repeat.
//
// A retry loop, a viewer notifying the same value, a warning on every frame -
// each of those turns a log into a wall of one sentence, and the thing that
// matters is invariably above or below it. So a repeat appends a dot to the
// line already written: `waiting for the kernel ....` says the sentence once,
// and how many times it happened.
//
// "The same entry" is the message without its timestamp, so the same words at
// different moments collapse and two different messages never do. Per stream,
// because the files are separate: a repeat in the console log must not be
// swallowed because the application log said the same thing.
//
// Pure, and split from log.js for this repository's usual reason - that file
// reaches Neutralino's filesystem and cannot be imported by a test, and this is
// the half with a decision in it.

/** A stream's memory of what it last wrote. */
export function repeater() {
  return { key: null, open: false };
}

/**
 * Write an entry, or a dot when it repeats the last one.
 *
 * `append_` takes the exact text to append and nothing else, which is what
 * keeps this pure: the caller decides whether that is a file, a buffer or a
 * node in a pane. The newline goes *before* the next distinct line rather than
 * after each one, because a line that may still grow dots cannot be terminated.
 */
export function emit(stream, entry, append_) {
  if (stream.key === entry.key) {
    append_(".");
    return;
  }
  append_((stream.open ? "\n" : "") + entry.line);
  stream.key = entry.key;
  stream.open = true;
}
