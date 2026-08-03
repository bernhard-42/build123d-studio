import { filesystem, os } from "@neutralinojs/lib";

import {
  SAMPLE_SOURCE,
  bufferKeys,
  closeBuffer,
  getCurrentFile,
  getValue,
  getViewState,
  isDirty,
  markSaved,
  openBuffer,
  setCurrentFile,
} from "./monaco.js";
import { askThreeWay, notifyFailure } from "../confirm.js";
import { writeFileSafely } from "./safewrite.js";
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

/**
 * Show text as a buffer of its own, and close whatever was open before it.
 *
 * One buffer at a time is all the UI can express today: there is no tab strip
 * yet, so a second one would be open with no way to reach it - and unreachable
 * is exactly how a buffer with unsaved changes in it gets lost. Every caller
 * here has already offered to save through confirmDiscardChanges.
 *
 * The order matters and is the reason this is one function rather than two calls
 * at five sites. The new buffer is shown *first* and the old ones closed after,
 * because closing disposes a Monaco model and disposing the one the editor is
 * pointed at leaves it showing a dead document.
 */
function showOnly({ path = null, text = "" }) {
  const key = openBuffer({ path, text });
  for (const other of bufferKeys()) {
    if (other !== key) {
      closeBuffer(other);
    }
  }
  return key;
}

const LAST_FILE_KEY = "lastFile";
const LAST_POSITION_KEY = "lastPosition";
const LAST_SCROLL_KEY = "lastScrollTop";
const LAST_FOLDER_KEY = "lastFolder";
const SAMPLE_SHOWN_KEY = "sampleShown";
export const NEW_FILE_TEMPLATE_KEY = "newFileTemplate";

/**
 * Where Open and Save should start.
 *
 * The directory of the open file first, then the last one a file was opened
 * from or saved to, and only then Documents. Falling back to Documents every
 * time meant navigating back to the same project folder on every Open, which
 * is not where anyone keeps their CAD scripts after the first day.
 *
 * The remembered folder is checked before it is offered: it can have been
 * deleted, renamed, or be on a volume that is no longer mounted, and handing a
 * dialog a path that is not there is how it ends up somewhere arbitrary.
 */
async function startingFolder() {
  const candidates = [directoryOf(getCurrentFile()), getSetting(LAST_FOLDER_KEY)];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") {
      continue;
    }
    try {
      const stats = await filesystem.getStats(candidate);
      if (stats.isDirectory) {
        return candidate;
      }
    } catch {
      // Gone, or not reachable. Try the next one.
    }
  }
  return os.getPath("documents");
}

/** Remember the folder a file was just opened from or saved to. */
async function rememberFolder(path) {
  const folder = directoryOf(path);
  if (folder !== null) {
    await setSetting(LAST_FOLDER_KEY, folder);
  }
}

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
  if (view === null) {
    return;
  }
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
  try {
    return (await saveFile()) !== null;
  } catch {
    // saveFile has already said so on screen; what is decided here is what
    // happens next, and the answer is nothing.
    //
    // This used to throw out of here into shutdown()'s catch, which is written
    // for a failed *prompt* and reads any throw as permission to quit. So the
    // one case where the user had explicitly asked to keep their work - answer
    // "Save", have the save fail - was also the case that discarded it and
    // closed the window. A failed save is the strongest possible reason not to
    // continue with something whose next step is to throw the buffer away.
    return false;
  }
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
/**
 * What a new buffer starts with.
 *
 * Empty unless the user has put something in Settings. Almost every build123d
 * file opens with the same two imports, and typing them again is the sort of
 * small tax that is paid several times a day - so it is worth a field, and
 * worth being *their* two imports rather than ones chosen here.
 *
 * Deliberately not the sample: that is a one-off introduction for someone who
 * has never seen the application, and it appears once. This is a preference and
 * applies to every New File from now on.
 */
export function newFileTemplate() {
  const template = getSetting(NEW_FILE_TEMPLATE_KEY, "");
  return typeof template === "string" ? template : "";
}

export async function newFile() {
  if (!(await confirmDiscardChanges())) {
    return false;
  }
  showOnly({ text: newFileTemplate() });
  await setSetting(LAST_FILE_KEY, null);
  await setSetting(LAST_POSITION_KEY, null);
  await setSetting(LAST_SCROLL_KEY, null);
  syncKernelDirectory();
  log.info("New file");
  return true;
}

/**
 * What to show when there is no file to reopen.
 *
 * The sample is a jump start for someone who has never seen the application, so
 * it appears once and then never again. It used to appear whenever the last
 * file could not be reopened - rename the folder it lived in, and the next
 * start replaced your work with example code, which reads as the application
 * having lost the file and invented something. An empty buffer says the same
 * thing without pretending.
 *
 * An installation that predates this flag sees the sample one last time, the
 * first time a start finds nothing to reopen, and never again. Deriving the
 * flag from other evidence of a previous session would be more machinery than
 * a one-off is worth.
 */
async function startWithSampleOrEmpty() {
  if (getSetting(SAMPLE_SHOWN_KEY) === true) {
    showOnly({ text: "" });
    return;
  }
  showOnly({ text: SAMPLE_SOURCE });
  await setSetting(SAMPLE_SHOWN_KEY, true);
  log.info("First start: showing the sample");
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
  if (typeof path === "string" && path !== "") {
    try {
      const content = await filesystem.readFile(path);
      showOnly({ path, text: content });
      log.info("Reopened", path);
      return path;
    } catch {
      // Renamed, deleted, or on a volume that is not mounted. Forgetting it
      // means one quiet fallback rather than the same failure every start.
      log.info(`Last file is no longer readable, starting fresh: ${path}`);
      await setSetting(LAST_FILE_KEY, null);
      await setSetting(LAST_POSITION_KEY, null);
      await setSetting(LAST_SCROLL_KEY, null);
    }
  }
  await startWithSampleOrEmpty();
  return null;
}

export async function openFile() {
  // Opening replaces the buffer exactly as New does, so it has to ask first.
  // Asked before the file chooser rather than after, so the user is not made to
  // pick a file and only then told the choice is about to cost them work.
  if (!(await confirmDiscardChanges())) {
    return null;
  }
  const entries = await os.showOpenDialog("Open a Python file", {
    defaultPath: await startingFolder(),
    filters: FILTERS,
    multiSelections: false,
  });
  if (entries.length !== 1) {
    return null;
  }
  const path = entries[0];
  const content = await filesystem.readFile(path);
  showOnly({ path, text: content });
  await setSetting(LAST_FILE_KEY, path);
  await rememberFolder(path);
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

/**
 * Write a file without ever truncating the existing one.
 *
 * writeFile opens the target and truncates it before the new contents are
 * there, so a crash, a full disk or the process being killed mid-write leaves a
 * half-written .py - the one file this application must never damage. Writing
 * beside it and moving into place means the target is either the old file or
 * the new one.
 *
 * The temporary lives in the same directory deliberately: a move within one
 * filesystem is a rename, while /tmp would be a copy across devices and no
 * better than writing directly.
 *
 * The fallback is not decoration. std::filesystem::rename onto an existing file
 * is well defined on POSIX and not on Windows, and there is no Windows machine
 * here to find that out on. If the move fails the content is already safely on
 * disk, so the direct write is at worst what this code did before - and if that
 * fails too, the temporary is left alone and named in the error, because at
 * that point it is the only copy of the user's work.
 */
/**
 * A sentence about a failure, whatever shape the failure arrived in.
 *
 * Neutralino rejects with a plain object carrying `code` and `message` rather
 * than an Error, so `String(error)` on one of those is "[object Object]" - which
 * is exactly what a user would have been shown.
 */
function describe(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && typeof error.message === "string") {
    return error.code === undefined ? error.message : `${error.message} (${error.code})`;
  }
  return String(error);
}

export async function saveFile({ saveAs = false } = {}) {
  let path = getCurrentFile();

  if (saveAs || path === null) {
    path = await os.showSaveDialog("Save", {
      defaultPath: path ?? (await startingFolder()),
      filters: FILTERS,
    });
    if (path === "" || path === undefined) {
      return null;
    }
    path = withPythonExtension(path);
  }

  try {
    const written = await writeFileSafely({ filesystem, log }, path, getValue());
    if (written !== path) {
      log.info(`Saved ${path}, which resolves to ${written}`);
    }
  } catch (error) {
    // Said on screen here, once, so that every entry point gets it: the toolbar
    // button, Cmd-S, and the prompt that offers to save before quitting. Before
    // this a failed save went to the log and nowhere else, so the editor looked
    // exactly as it does after a successful one - no dialog, and the title's
    // modified marker cleared by the markSaved() below, which is now correctly
    // never reached.
    log.error("Save failed:", error);
    await notifyFailure("Could not save", `${path} was not saved.\n\n${describe(error)}`);
    throw error;
  }
  setCurrentFile(path);
  markSaved();
  await setSetting(LAST_FILE_KEY, path);
  await rememberFolder(path);
  syncKernelDirectory();
  log.info("Saved", path);
  return path;
}
