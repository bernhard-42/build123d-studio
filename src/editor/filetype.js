// Whether a file is worth putting in the editor, decided from its first bytes
// and its size.
//
// Pure, and separated for the usual reason: what counts as binary and what
// counts as large are the parts that can be wrong, while reading the bytes and
// putting a dialog on screen is the part that needs a window. files.js does the
// reading; everything below is a decision about the answer.

/**
 * How much of the file the verdict is taken from.
 *
 * The same 8 kB git reads. A prefix rather than the whole file because the
 * whole file is precisely what must not be read before deciding whether to read
 * it - a 400 MB STL would be pulled into memory to find out that it should not
 * be - and because anything that is not text is not text at the front.
 */
export const SNIFF_BYTES = 8000;

/**
 * Past this, opening asks first.
 *
 * Ten megabytes, and the number is about the language server rather than about
 * Monaco. Measured in the frontend harness: a 32 MB file appears in a tab in
 * 152 ms and scrolls to the end in 33 ms, because Monaco tokenises the viewport
 * and not the document - so "the editor will hang" would have been the wrong
 * reason to warn. What is not free is that the whole buffer is sent for
 * analysis on open and after every edit: 32 MB across the socket took 891 ms,
 * and what basedpyright then does with a file that size is not measured here.
 *
 * No Python anyone edits comes near it and every STEP or STL export of a real
 * assembly goes past it, which is the line this is meant to draw.
 */
export const LARGE_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The Monaco language for a file, which is Python or nothing.
 *
 * Only Python is registered in this editor, so everything else is plaintext -
 * and that is the point rather than a fallback. A model told it is Python is
 * highlighted as Python, offered to ruff on save, and sent to the language
 * server, which then reports a STEP file as 6779 syntax errors because it is
 * not one. A user opening an export to look at it should see it, not a wall of
 * complaints that OpenCascade's exchange format is invalid Python.
 *
 * A buffer with no path is Python: it has just been made by New file, which
 * inserts a Python snippet into it.
 */
export function languageFor(path) {
  if (path === null || path === undefined || path === "") {
    return "python";
  }
  if (/\.pyi?$/i.test(path)) {
    return "python";
  }
  // The helper files beside a project: highlighted, and JSON also checked by
  // Monaco's own service - neither ever reaches the Python tooling, which is
  // gated on the language id, as the plaintext case always was.
  if (/\.json$/i.test(path)) {
    return "json";
  }
  if (/\.ya?ml$/i.test(path)) {
    return "yaml";
  }
  if (/\.toml$/i.test(path)) {
    return "toml";
  }
  return "plaintext";
}

/**
 * Whether these bytes came from something that is not text.
 *
 * One NUL byte is the whole test, which is git's, and it is chosen for being
 * the rule that does not have opinions: it says nothing about encodings,
 * languages or extensions, so a file with an unexpected name or none at all is
 * treated the same as any other. UTF-16 is caught by it and that is correct
 * here - Monaco is handed a UTF-8 string, so a UTF-16 file put in a buffer is
 * as unreadable as a PNG.
 *
 * An empty file has no NUL and is text, which is the right answer: an empty
 * file is a file you have just made and are about to type into.
 */
export function looksBinary(bytes) {
  for (const byte of bytes) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

/** Whether a file is big enough to be worth asking about. */
export function isLarge(size) {
  return typeof size === "number" && size > LARGE_FILE_BYTES;
}

/**
 * A size a person can read, for the question that quotes it.
 *
 * Binary megabytes, because that is what the threshold is written in, and one
 * decimal because "12 MB" and "12.4 MB" answer the same question and the second
 * one is not more precise about anything that matters.
 */
export function describeSize(size) {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return "an unknown size";
  }
  if (size < 1024) {
    return `${size} bytes`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} kB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// The pictures the editor shows rather than edits. SVG is not here: it is
// text, and sometimes the point of opening one is to edit it.
const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * The MIME type for a picture the editor can show, or null for anything else.
 *
 * By extension, and only these. A picture opens in a tab of its own with no
 * editor behind it - nothing to type into, nothing to save - which is a
 * different kind of tab from the text ones, so the list is deliberately the
 * formats a browser draws and nothing that might be text.
 */
export function imageType(path) {
  if (typeof path !== "string") {
    return null;
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}
