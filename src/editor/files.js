import { filesystem, os } from "@neutralinojs/lib";

import {
  SAMPLE_SOURCE,
  activeBufferKey,
  bufferCaret,
  bufferForPath,
  bufferKeys,
  bufferPath,
  captureActiveCaret,
  closeBuffer,
  getCurrentFile,
  getValue,
  isBufferDirty,
  isDirty,
  markSaved,
  openBuffer,
  setCurrentFile,
  showBuffer,
  showNoBuffer,
} from "./monaco.js";
import { refreshTabs } from "./tabstrip.js";
import { chooseActive, readWorkspace } from "./workspace.js";
import { hideFolder, revealInTree, showFolder } from "./sidebar.js";
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

// The one open folder, or null. A folder is the project, and a project is the
// whole session - see requs.md. Held here because this module already owns the
// tabs and the kernel's working directory, which are the two things a folder
// changes.
let folder = null;

/** The open folder, for anything that needs to know there is a project. */
export function currentFolder() {
  return folder;
}

/**
 * Run the kernel where the project is, or where the file is when there is no
 * project.
 *
 * With a folder open the working directory is its root and stays there, however
 * deep the file being edited sits and whether or not it is inside the folder at
 * all. A hierarchy is one project and a project has one place its relative
 * paths resolve against; a cwd that followed the active tab would make
 * export_step(part, "out.step") land somewhere different for every file in the
 * same project.
 *
 * With no folder it is the active file's directory, which is what Phase 1 chose
 * so that export_step(part, "bracket.step") writes next to bracket.py the way
 * it would if the script had been run from a terminal. An unsaved buffer has no
 * directory to speak of, and the sidecar falls back to home.
 *
 * Sent on every change rather than only at kernel start, because the kernel
 * outlives both: opening a second project must not leave exports going to the
 * first one's folder.
 */
export function syncKernelDirectory() {
  if (!ipc.isConnected()) {
    return;
  }
  ipc.send("kernel.cwd", { path: folder ?? directoryOf(getCurrentFile()) });
}

/**
 * Close every tab, asking about the dirty ones. False if the user cancelled.
 *
 * The shared half of both folder commands: opening a folder is a context reset
 * and closing one is a context close, and each is "all of them" rather than
 * "the ones that happen to live under the old root". Which tabs survive would
 * otherwise depend on where each file sits, and that is a rule someone has to
 * hold in their head to predict what a menu item does.
 */
async function closeEveryTab() {
  if (!(await confirmDiscardAll())) {
    return false;
  }
  showNoBuffer();
  for (const key of bufferKeys()) {
    closeBuffer(key);
  }
  refreshTabs();
  return true;
}

/**
 * Open a folder as the project, replacing whatever was open before it.
 *
 * @returns {Promise<boolean>} false if cancelled, at the chooser or at a prompt
 */
export async function openFolder() {
  const chosen = await os.showFolderDialog("Open a project folder", {
    defaultPath: folder ?? (await startingFolder()),
  });
  if (typeof chosen !== "string" || chosen === "") {
    return false;
  }
  // Asked after the chooser rather than before it, unlike the old Open File.
  // Picking a folder is the point at which this becomes destructive, and being
  // asked about unsaved work before knowing whether the user will even choose
  // one is a prompt for nothing.
  if (!(await closeEveryTab())) {
    return false;
  }
  folder = chosen;
  await showFolder(chosen);
  syncKernelDirectory();
  await setSetting(LAST_FOLDER_KEY, chosen);
  await saveWorkspace();
  log.info("Opened folder", chosen);
  return true;
}

/** Close the project: the tree, the tabs and the working directory with it. */
export async function closeFolder() {
  if (folder === null) {
    return true;
  }
  if (!(await closeEveryTab())) {
    return false;
  }
  log.info("Closed folder", folder);
  folder = null;
  hideFolder();
  syncKernelDirectory();
  await saveWorkspace();
  return true;
}

/**
 * Open text as a tab and show it, or focus the tab it is already in.
 *
 * This replaces the previous version, which closed every other buffer because
 * there was no way to reach a second one. There is now.
 *
 * A path that is already open is focused rather than opened again, and never
 * re-read from disk. Two tabs over two models of one file are two independent
 * sets of edits, and whichever is saved last would silently win.
 */
function showInTab({ path = null, text = "" }) {
  const open = path === null ? null : bufferForPath(path);
  const key = open === null ? openBuffer({ path, text }) : open;
  if (open !== null) {
    showBuffer(open);
  }
  refreshTabs();
  // Not awaited: nothing downstream depends on the tree having caught up, and
  // making every open wait on a directory read would put the filesystem in
  // front of the editor showing the file.
  revealInTree(path).catch((error) => log.warn("Could not reveal in the tree:", error));
  return key;
}

/**
 * Show a tab, as clicking it does.
 *
 * The workspace is written on every switch rather than only at quit, so that
 * which tab was active survives a crash as well as a clean exit. It is one
 * settings write, which is what selecting a tab already cost.
 */
export async function selectTab(key) {
  showBuffer(key);
  refreshTabs();
  await revealInTree(getCurrentFile());
  syncKernelDirectory();
  await saveWorkspace();
}

/**
 * Close a tab, offering to save it first.
 *
 * Shown before it is asked about, even when it was not the tab on screen. The
 * prompt names a file and answering "Save" saves the buffer the editor is
 * showing, so asking about a background tab while another is displayed would
 * describe one file and write another.
 *
 * The replacement is attached before the closed model is disposed, which is
 * buffers.close's stated requirement: disposing the model the editor is pointed
 * at leaves it showing a dead document. Closing the last tab leaves no tab at
 * all, which is what group 2 decided.
 *
 * @returns {Promise<boolean>} false if the user cancelled
 */
export async function closeTab(key) {
  if (activeBufferKey() !== key) {
    showBuffer(key);
    refreshTabs();
  }
  if (!(await confirmDiscardChanges())) {
    return false;
  }

  const keys = bufferKeys();
  const index = keys.indexOf(key);
  const remaining = keys.filter((other) => other !== key);
  if (remaining.length === 0) {
    showNoBuffer();
  } else {
    // The tab that took its place, or the last one when the closed tab was.
    showBuffer(remaining[Math.min(index, remaining.length - 1)]);
  }
  closeBuffer(key);

  refreshTabs();
  await revealInTree(getCurrentFile());
  syncKernelDirectory();
  await saveWorkspace();
  log.info(`Closed a tab; ${bufferKeys().length} open`);
  return true;
}

/**
 * Offer to save every tab that differs from disk. Returns false if cancelled.
 *
 * Once per dirty file, which is not where this ends up: group 2's piece 4 makes
 * it a single prompt listing all of them, because being asked five times in a
 * row is how people learn to dismiss the dialog without reading it. It is here
 * now rather than then because the moment a second tab can exist, quitting has
 * to account for it - and the alternative, asking only about the tab on screen,
 * loses the other four without a word.
 */
export async function confirmDiscardAll() {
  for (const key of bufferKeys()) {
    if (!isBufferDirty(key)) {
      continue;
    }
    if (activeBufferKey() !== key) {
      showBuffer(key);
      refreshTabs();
    }
    if (!(await confirmDiscardChanges())) {
      return false;
    }
  }
  return true;
}

const WORKSPACE_KEY = "workspace";
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
 * The session, written so the next start can put it back.
 *
 * Every open tab, in strip order, with where its caret was left, and which one
 * was showing. Replaces lastFile/lastPosition/lastScrollTop, which described a
 * single file because there could only be one.
 *
 * The caret of the tab on screen is captured here: every other tab recorded its
 * position when it was switched away from, and the one being looked at has not
 * been switched away from yet.
 *
 * Unsaved buffers are left out. Only a path is ever remembered, never a
 * buffer's contents - reopening a file means seeing what is on disk, including
 * edits made elsewhere since - so a buffer with no path has nothing to reopen
 * from, and inventing a scratch file to hold it would be a second place work
 * could go missing.
 *
 * The active tab is stored as its path rather than its index, because a file
 * that has been deleted since is simply not reopened and every index after it
 * would shift.
 */
export async function saveWorkspace() {
  captureActiveCaret();
  const active = activeBufferKey();
  const tabs = [];
  for (const key of bufferKeys()) {
    const path = bufferPath(key);
    if (path !== null) {
      tabs.push({ path, caret: bufferCaret(key) });
    }
  }
  await setSetting(WORKSPACE_KEY, {
    folder,
    tabs,
    active: active === null ? null : bufferPath(active),
  });
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
  // No longer asks about the current buffer, because it no longer replaces it.
  // New opens a tab beside what is already there, so there is nothing to
  // discard and nothing to confirm.
  showInTab({ text: newFileTemplate() });
  syncKernelDirectory();
  await saveWorkspace();
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
    showInTab({ text: "" });
    return;
  }
  showInTab({ text: SAMPLE_SOURCE });
  await setSetting(SAMPLE_SHOWN_KEY, true);
  log.info("First start: showing the sample");
}

/**
 * Reopen the tabs from the previous session, and show the one that was active.
 *
 * Only paths are remembered, never contents, so this is what is on disk now -
 * including anything edited elsewhere in between. A file that has since been
 * renamed, deleted or left on an unmounted volume is quietly not reopened
 * rather than reported: it is one line in the log, and a dialog on every start
 * about a file somebody deliberately moved would be worse than the gap.
 *
 * @returns {Promise<string|null>} the path shown, or null when nothing reopened
 */
export async function restoreWorkspace() {
  const saved = readWorkspace({
    workspace: getSetting(WORKSPACE_KEY),
    lastFile: getSetting(LAST_FILE_KEY),
    lastPosition: getSetting(LAST_POSITION_KEY),
    lastScrollTop: getSetting(LAST_SCROLL_KEY),
  });
  const opened = new Map();

  // The folder first, so the tree is populated before the tabs appear and the
  // kernel is told about the project rather than about a file inside it.
  if (saved !== null && saved.folder !== null) {
    try {
      const stats = await filesystem.getStats(saved.folder);
      if (stats.isDirectory) {
        folder = saved.folder;
        await showFolder(saved.folder);
      }
    } catch {
      log.info(`Not reopening a folder that is no longer there: ${saved.folder}`);
    }
  }

  for (const tab of saved === null ? [] : saved.tabs) {
    try {
      const content = await filesystem.readFile(tab.path);
      opened.set(tab.path, openBuffer({ path: tab.path, text: content, caret: tab.caret }));
    } catch {
      log.info(`Not reopening a file that is no longer readable: ${tab.path}`);
    }
  }

  if (opened.size === 0) {
    await startWithSampleOrEmpty();
    return null;
  }

  const active = opened.get(chooseActive([...opened.keys()], saved.active));
  showBuffer(active);
  refreshTabs();
  // Opens the way down to it: a restored session used to come back with the
  // right file showing and a collapsed tree beside it.
  await revealInTree(bufferPath(active));
  log.info(`Reopened ${opened.size} tab(s)`);

  // Written back at once, which is what retires the pre-tabs keys after a
  // migration - the next start finds a workspace and never looks at them again.
  await saveWorkspace();
  return bufferPath(active);
}

export async function openFile() {
  // It used to ask about the open buffer before showing the chooser, because
  // opening replaced it. Opening adds a tab now, so there is nothing at risk.
  const entries = await os.showOpenDialog("Open a Python file", {
    defaultPath: await startingFolder(),
    filters: FILTERS,
    multiSelections: false,
  });
  if (entries.length !== 1) {
    return null;
  }
  return openPath(entries[0]);
}

/**
 * Open one known path, which is what the tree's rows do.
 *
 * The failure is reported rather than logged, because the tree can be showing a
 * listing that is a few seconds out of date - the file was there when the
 * directory was read and is not there now - and a row that does nothing when
 * clicked is a worse answer than a sentence saying why.
 */
export async function openPath(path) {
  let content;
  try {
    content = await filesystem.readFile(path);
  } catch (error) {
    log.warn(`Could not open ${path}:`, error);
    await notifyFailure("Could not open", `${path}\n\n${describe(error)}`);
    return null;
  }
  showInTab({ path, text: content });
  await rememberFolder(path);
  syncKernelDirectory();
  await saveWorkspace();
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
  refreshTabs();
  await rememberFolder(path);
  syncKernelDirectory();
  await saveWorkspace();
  log.info("Saved", path);
  return path;
}
