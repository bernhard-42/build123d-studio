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

// The injected model operations: { create(text), dispose(model), versionOf(model) }.
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
export function open({ path = null, text = "" }) {
  const key = nextKey;
  nextKey += 1;
  const model = models.create(text);
  buffers.set(key, {
    key,
    path,
    model,
    savedVersionId: models.versionOf(model),
    viewState: null,
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

export function activate(key) {
  if (!buffers.has(key)) {
    throw new Error(`No such buffer: ${key}`);
  }
  activeKey = key;
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
    return;
  }
  buffer.path = path;
}

/** Record a buffer as matching disk - after a load or a successful save. */
export function markSaved(key) {
  const buffer = buffers.get(key);
  if (buffer === undefined) {
    return;
  }
  buffer.savedVersionId = models.versionOf(buffer.model);
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
