import { filesystem, os } from "@neutralinojs/lib";

import {
  getCurrentFile,
  getValue,
  getViewState,
  isDirty,
  markSaved,
  setCurrentFile,
  setValue,
} from "./monaco.js";
import { askThreeWay } from "../confirm.js";
import { getSetting, setSetting } from "../store.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";

const FILTERS = [
  { name: "Python", extensions: ["py"] },
  { name: "All files", extensions: ["*"] },
];

/**
 * The directory holding a file, or null when there is no meaningful one.
 *
 * Handles both separators: the same settings file can be carried between
 * platforms, and a Windows path must not be mistaken for a bare filename.
 */
function directoryOf(path) {
  if (typeof path !== "string" || path === "") {
    return null;
  }
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) {
    return null;
  }
  // A file at the filesystem root: the separator is the directory.
  return cut === 0 ? path.slice(0, 1) : path.slice(0, cut);
}

/**
 * Run the kernel where the open file lives.
 *
 * So that export_step(part, "bracket.step") writes next to bracket.py, the way
 * it would if the script had been run from a terminal. An unsaved buffer has no
 * directory to speak of, and the sidecar falls back to home.
 *
 * Sent on every change of file rather than only at kernel start, because the
 * kernel outlives the file: opening a second part must not leave exports going
 * to the first one's folder.
 */
export function syncKernelDirectory() {
  if (!ipc.isConnected()) {
    return;
  }
  ipc.send("kernel.cwd", { path: directoryOf(getCurrentFile()) });
}

const LAST_FILE_KEY = "lastFile";
const LAST_POSITION_KEY = "lastPosition";
const LAST_SCROLL_KEY = "lastScrollTop";

/**
 * Remember where the caret and viewport are, for the next start.
 *
 * Written at quit rather than as the caret moves: the alternative is a debounced
 * write on every cursor pause, which is a lot of disk traffic for a
 * convenience. The cost is that a crash loses the position - the file itself is
 * never at risk, only the place in it.
 */
export async function rememberPosition() {
  if (getCurrentFile() === null) {
    // Nothing was reopened, so there is no file the position would belong to.
    return;
  }
  const view = getViewState();
  await setSetting(LAST_POSITION_KEY, { line: view.line, column: view.column });
  await setSetting(LAST_SCROLL_KEY, view.scrollTop);
}

/** The remembered caret and viewport, or null. */
export function lastViewState() {
  const position = getSetting(LAST_POSITION_KEY);
  if (typeof position !== "object" || position === null) {
    return null;
  }
  return {
    line: position.line,
    column: position.column,
    scrollTop: getSetting(LAST_SCROLL_KEY),
  };
}

/**
 * Offer to save when the buffer is dirty. Returns false if the user cancelled.
 *
 * Shared by everything that is about to throw the buffer away - quitting, and
 * starting a new file. One implementation means the two cannot drift into
 * asking differently, or one of them forgetting to ask at all.
 */
export async function confirmDiscardChanges() {
  if (!isDirty()) {
    return true;
  }
  const file = getCurrentFile();
  const answer = await askThreeWay({
    title: "Unsaved changes",
    detail:
      file === null
        ? "The editor has changes that have never been saved to a file."
        : `${file} has unsaved changes.`,
    save: "Save",
    discard: "Discard",
    cancel: "Cancel",
  });

  if (answer === "cancel") {
    return false;
  }
  if (answer === "discard") {
    return true;
  }
  // Saving an unnamed buffer opens the save dialog, which the user can also
  // dismiss - and dismissing it is not consent to lose the work, so that
  // cancels the whole operation too.
  return (await saveFile()) !== null;
}

/**
 * Start an empty buffer, after offering to save the current one.
 *
 * Empty rather than the sample the app first launches with: "New" that arrives
 * pre-filled is a surprise, and the sample is a first-run introduction rather
 * than a template.
 *
 * @returns {Promise<boolean>} false if the user cancelled
 */
export async function newFile() {
  if (!(await confirmDiscardChanges())) {
    return false;
  }
  setValue("", null);
  await setSetting(LAST_FILE_KEY, null);
  await setSetting(LAST_POSITION_KEY, null);
  await setSetting(LAST_SCROLL_KEY, null);
  syncKernelDirectory();
  log.info("New file");
  return true;
}

/**
 * Reopen whatever was last open, if it is still there.
 *
 * Only a path is remembered, never the buffer's contents: reopening the file
 * means seeing what is on disk, including edits made elsewhere since. Anything
 * else would quietly resurrect a stale copy over the real one.
 */
export async function restoreLastFile() {
  const path = getSetting(LAST_FILE_KEY);
  if (typeof path !== "string" || path === "") {
    return null;
  }
  try {
    const content = await filesystem.readFile(path);
    setValue(content, path);
    log.info("Reopened", path);
    return path;
  } catch (error) {
    // Renamed, deleted, or on a volume that is not mounted. Forgetting it means
    // one quiet fallback to the sample rather than the same failure every start.
    log.info(`Last file is no longer readable, starting fresh: ${path}`);
    await setSetting(LAST_FILE_KEY, null);
    await setSetting(LAST_POSITION_KEY, null);
    await setSetting(LAST_SCROLL_KEY, null);
    return null;
  }
}

export async function openFile() {
  // Opening replaces the buffer exactly as New does, so it has to ask first.
  // Asked before the file chooser rather than after, so the user is not made to
  // pick a file and only then told the choice is about to cost them work.
  if (!(await confirmDiscardChanges())) {
    return null;
  }
  const entries = await os.showOpenDialog("Open a Python file", {
    defaultPath: await os.getPath("documents"),
    filters: FILTERS,
    multiSelections: false,
  });
  if (entries.length !== 1) {
    return null;
  }
  const path = entries[0];
  const content = await filesystem.readFile(path);
  setValue(content, path);
  await setSetting(LAST_FILE_KEY, path);
  // The remembered position belonged to the file being replaced. Quitting
  // normally would overwrite it anyway, but not if the app dies first - and
  // reopening a new file at the old one's line 380 is a puzzle, not a feature.
  await setSetting(LAST_POSITION_KEY, null);
  await setSetting(LAST_SCROLL_KEY, null);
  syncKernelDirectory();
  log.info("Opened", path);
  return path;
}

/**
 * Add .py unless the name already carries an extension.
 *
 * The save dialog does not append one - it hands back exactly what was typed,
 * so "bracket" is saved as a file with no extension that Monaco will not
 * highlight and nothing else will recognise as Python.
 *
 * Only a *missing* extension is filled in, never a different one: "bracket.txt"
 * and "v0.2" are left alone, on the grounds that someone who typed a suffix
 * meant it. The test is a dot in the final path segment - checking the whole
 * path would see the dot in "~/CAD v0.2/bracket" and wrongly leave it bare.
 */
function withPythonExtension(path) {
  const name = path.split(/[/\\]/).pop();
  if (name.includes(".")) {
    return path;
  }
  return `${path}.py`;
}

export async function saveFile({ saveAs = false } = {}) {
  let path = getCurrentFile();

  if (saveAs || path === null) {
    path = await os.showSaveDialog("Save", {
      defaultPath: path ?? (await os.getPath("documents")),
      filters: FILTERS,
    });
    if (path === "" || path === undefined) {
      return null;
    }
    path = withPythonExtension(path);
  }

  await filesystem.writeFile(path, getValue());
  setCurrentFile(path);
  markSaved();
  await setSetting(LAST_FILE_KEY, path);
  syncKernelDirectory();
  log.info("Saved", path);
  return path;
}
