/**
 * Every open buffer, and which one the editor is showing.
 *
 * A buffer is a path, a Monaco model, the version id it had when it last matched
 * disk, and where the caret and viewport were when it was last visible. Until
 * now each of those was a single module-level value in monaco.js - `currentFile`,
 * the editor's one implicit model, `savedVersionId`, and nothing at all for the
 * view state, because with one buffer there is never anywhere to come back from.
 * The whole of "many files open" is that those four become a Map.
 *
 * No monaco import here, deliberately. A model is an opaque handle and the three
 * things this module needs to do with one - make it, throw it away, ask which
 * version it is on - arrive through initBuffers. That keeps the bookkeeping
 * testable under `node --test`, which cannot load the editor, and it is the same
 * split as keys/keybindings and clipboard/editing: the decisions live in the half
 * that has no window.
 */

// The injected model operations:
// { create(text), dispose(model), versionOf(model), textOf(model),
//   replaceText(model, text) }.
let models = null;

const buffers = new Map();
let activeKey = null;

// Buffer keys are integers and are never reused, so a stale key from a closed
// buffer can never be mistaken for a live one. The path is *not* the identity:
// Save As gives a buffer a different path, and an unsaved buffer has none at
// all, so a path-keyed map would have to re-key on save and invent names for
// the untitled - both of which are how a tab loses track of its own contents.
let nextKey = 1;

/**
 * Install the model operations and start with nothing open.
 *
 * Also the reset the tests use: state that lives for the life of the window is
 * exactly the state a second test case must not inherit from the first.
 */
export function initBuffers(modelOperations) {
  models = modelOperations;
  buffers.clear();
  activeKey = null;
  nextKey = 1;
}

/**
 * Take a file - or an unnamed buffer, when path is null - and make a buffer of it.
 *
 * Opened clean: the model has just been created from the text, so the version it
 * is on *is* the version that matches disk. A new file from the template counts
 * as clean too, for the same reason the sample does - quitting should not offer
 * to save something the user never wrote.
 *
 * Does not activate it. Which buffer the editor shows is a separate decision and
 * belongs to the caller that is about to attach the model.
 */
export function open({ path = null, text = "", caret = null, matchesDisk = true }) {
  const key = nextKey;
  nextKey += 1;
  const model = models.create(text);
  buffers.set(key, {
    key,
    path,
    model,
    // A recovered buffer holds text that was never written, so it opens dirty:
    // null can never equal a version id, and the tab's dot, the quit prompt and
    // the recovery journal all follow from that one value being wrong on
    // purpose.
    savedVersionId: matchesDisk ? models.versionOf(model) : null,
    viewState: null,
    caret,
    // Whether the file this buffer names has gone from disk. Not a property of
    // the model - the text is fine, it is the file underneath it that is not.
    missing: false,
  });
  return key;
}

/**
 * Forget a buffer and dispose its model.
 *
 * The disposal is the point. Nothing in this application has ever disposed
 * anything, because with one model that outlived everything there was never a
 * reason to - and a leak here is invisible until someone has opened forty files
 * and Monaco is still holding all of them.
 *
 * The caller must have attached something else to the editor first: disposing a
 * model that is still the editor's leaves it showing a dead one. Returns the
 * buffer, so the caller can say in the log what it just closed.
 */
export function close(key) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return null;
  }
  buffers.delete(key);
  models.dispose(buffer.model);
  if (activeKey === key) {
    activeKey = null;
  }
  return buffer;
}

/** The buffer keys, in the order the buffers were opened. */
export function keys() {
  return [...buffers.keys()];
}

export function get(key) {
  return buffers.get(key) ?? null;
}

/**
 * The buffer already showing a path, or null.
 *
 * So that opening a file that is open focuses its tab instead of adding a
 * second one for the same document - two tabs over two models of one file is
 * two sets of edits, and whichever is saved last wins silently.
 *
 * Compared exactly. A path that reaches here has been through Neutralino's
 * getJoinedPath, which is its only realpath, so the two spellings of one file
 * that would matter have already been resolved to the same string.
 */
export function findByPath(path) {
  if (typeof path !== "string" || path === "") {
    return null;
  }
  for (const buffer of buffers.values()) {
    if (buffer.path === path) {
      return buffer.key;
    }
  }
  return null;
}

export function activate(key) {
  if (!buffers.has(key)) {
    throw new Error(`No such buffer: ${key}`);
  }
  activeKey = key;
}

/** Show none of them, which is what closing the last tab leaves behind. */
export function deactivate() {
  activeKey = null;
}

export function activeKeyOf() {
  return activeKey;
}

/** The buffer the editor is showing, or null when it is showing none. */
export function active() {
  if (activeKey === null) {
    return null;
  }
  return buffers.get(activeKey) ?? null;
}

/** After a Save As: the buffer is the same buffer, under a new name. */
export function setPath(key, path) {
  const buffer = buffers.get(key);
  if (buffer === null || buffer === undefined) {
    return false;
  }
  // No two buffers may name one file. Two tabs claiming the same path is a
  // state with no correct behaviour left in it: both are dirty against the same
  // bytes, whichever saves last wins silently, and closing either one offers to
  // discard work the other still holds. It became reachable when a save re-pathed
  // whichever buffer happened to be on screen rather than the one it wrote.
  for (const [other, held] of buffers) {
    if (other !== key && held.path === path) {
      return false;
    }
  }
  buffer.path = path;
  return true;
}

/**
 * Record a buffer as matching disk, at the version that was written.
 *
 * The version is an argument and not a reading taken here, and that is the
 * whole of it. Stamping whatever version the model is on *now* marks as saved
 * every keystroke typed while the write was in flight: the tab loses its dot,
 * quitting asks nothing, and the typing is gone. The caller read the text and
 * the version together, and passes back the one it actually wrote.
 */
export function markSaved(key, versionId) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return;
  }
  buffer.savedVersionId = versionId;
  // Saving a file that had been deleted writes it back, so it is not missing
  // any more - which is also the way out of the struck-through state.
  buffer.missing = false;
}

/**
 * A buffer's text and the version it is on, read together.
 *
 * One call because they have to be one instant. Reading the text and then
 * asking for the version is a window in which an edit lands between them, and
 * the buffer is then marked clean at a version whose text was never written.
 */
export function contentsOf(key) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return null;
  }
  return { text: models.textOf(buffer.model), versionId: models.versionOf(buffer.model) };
}

/** Whether a buffer is still open, for a caller holding a key across an await. */
export function exists(key) {
  return buffers.get(key) !== undefined;
}

/**
 * What the file looked like when this buffer last agreed with it.
 *
 * Set on load and after every successful save, and read immediately before the
 * next one. Its whole purpose is to notice that somebody else wrote the file in
 * between - see ondisk.js.
 */
export function setDiskStamp(key, stamp) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return;
  }
  buffer.diskStamp = stamp;
}

/** The stamp recorded for a buffer, or null if it never had one. */
export function diskStamp(key) {
  const buffer = buffers.get(key);
  return buffer === undefined ? null : (buffer.diskStamp ?? null);
}

/**
 * Replace a buffer's text with what is on disk, and say which version that is.
 *
 * An edit rather than a new model, so the tab, the caret's history and the undo
 * stack all survive - reloading is not the same as closing and opening, and
 * somebody who reloads by mistake must be able to undo it.
 */
export function replaceText(key, text) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return null;
  }
  models.replaceText(buffer.model, text);
  return models.versionOf(buffer.model);
}

/**
 * Whether a buffer has edits that are not on disk.
 *
 * Monaco's alternative version id rather than the text: it moves with every edit
 * but comes *back* to an earlier value when those edits are undone, so typing a
 * line and undoing it leaves the buffer clean, which is what the user believes.
 * Comparing strings would also be correct and means keeping a copy of every open
 * file in memory to compare against.
 */
export function isDirty(key) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return false;
  }
  return models.versionOf(buffer.model) !== buffer.savedVersionId;
}

/**
 * Record whether the file underneath a buffer still exists.
 *
 * Separate from dirty, and both are "unsaved work" to the prompt: a buffer with
 * no file left is the only copy of that text, so quitting without asking would
 * discard it exactly the way Phase 2 was about.
 */
export function setMissing(key, missing) {
  const buffer = buffers.get(key);
  if (buffer !== undefined) {
    buffer.missing = missing === true;
  }
}

export function isMissing(key) {
  return buffers.get(key)?.missing === true;
}

/**
 * Whether this buffer holds work that is not safely on disk.
 *
 * Either it has edits that have not been written, or the file it was written to
 * is gone. An unnamed buffer is neither: it has never had a file, and Save As
 * is what gives it one - which is why a new file is not "missing".
 */
export function needsSaving(key) {
  return isDirty(key) || isMissing(key);
}

/** Where the caret and viewport were when this buffer was last shown. */
export function setViewState(key, state) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return;
  }
  buffer.viewState = state;
}

export function viewState(key) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return null;
  }
  return buffer.viewState;
}

/**
 * Where the caret and viewport were, in a form that survives a restart.
 *
 * Kept beside the view state rather than instead of it, because the two answer
 * different questions. Monaco's view state restores far more - folded regions,
 * the exact scroll - but it is Monaco's own shape, undocumented and free to
 * change between versions, so writing it into settings.json would be storing a
 * dependency's internals and reading them back a release later. A line, a column
 * and a scroll offset are ours, and restoreLastFile has clamped them against a
 * file that changed on disk since Phase 1.
 */
export function setCaret(key, caret) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return;
  }
  buffer.caret = caret;
}

export function caret(key) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return null;
  }
  return buffer.caret;
}
