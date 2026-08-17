import { filesystem, os } from "@neutralinojs/lib";

import {
  activeBufferKey,
  bufferCaret,
  bufferForPath,
  bufferKeys,
  bufferPath,
  captureActiveCaret,
  closeBuffer,
  formatBuffer,
  getCurrentFile,
  bufferContents,
  bufferExists,
  bufferStamp,
  bufferNeedsSaving,
  markMissingFiles,
  markSaved,
  onContentChange,
  reloadBufferText,
  setBufferStamp,
  openBuffer,
  setCurrentFile,
  showBuffer,
  showNoBuffer,
} from "./monaco.js";
import { DEFAULT_NEW_FILE_TEMPLATE, SAMPLE_SOURCE } from "./starters.js";
import { refreshTabs } from "./tabstrip.js";
import { chooseActive, readWorkspace } from "./workspace.js";
import { unsavedPrompt } from "./unsaved.js";
import { hideFolder, revealInTree, showFolder } from "./sidebar.js";
import { describeSize, isLarge, looksBinary, SNIFF_BYTES } from "./filetype.js";
import { formatOnSave } from "./formatting.js";
import { changedSince, hasTimestamp, stampOf } from "./ondisk.js";
import {
  BEAT,
  beat,
  clearJournal,
  createRecorder,
  forgetBuffer,
  isStale,
  journalRoot,
  readJournal,
  recordBuffer,
  setAside,
  worthRecording,
} from "./journal.js";
import { appDataDir } from "../bootstrap/envroot.js";
import { askThreeWay, askTwoWay, notifyFailure, notifyRefusal } from "../confirm.js";
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
export async function closeEveryTab() {
  if (!(await confirmDiscardAll())) {
    return false;
  }
  showNoBuffer();
  for (const key of bufferKeys()) {
    await bufferSettled(key);
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
  await showFolderAt(chosen);
  return true;
}

/**
 * Make a known folder the project, with no chooser and no discard prompt.
 *
 * Split out of openFolder for the command line, where the path is already
 * decided and there is nothing to discard - `studio` always launches a new
 * instance, so the window it opens has no tabs to ask about. Deliberately does
 * not prompt: a function that silently skips confirmation is fine only because
 * every caller reaching it has already established there is nothing to lose,
 * and openFolder above still asks before it gets here.
 */
export async function showFolderAt(chosen) {
  folder = chosen;
  await showFolder(chosen);
  syncKernelDirectory();
  await setSetting(LAST_FOLDER_KEY, chosen);
  await saveWorkspace();
  log.info("Opened folder", chosen);
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
  // Asked about above, so whatever it held has been saved or deliberately
  // discarded. A copy left behind would offer discarded text back at the next
  // start - and, worse, would outrank a newer copy of the same file, because
  // entries are read in key order and this buffer's key is the older one.
  await bufferSettled(key);
  closeBuffer(key);

  refreshTabs();
  await revealInTree(getCurrentFile());
  syncKernelDirectory();
  await saveWorkspace();
  log.info(`Closed a tab; ${bufferKeys().length} open`);
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

/** Close the tab on screen, which is what Close and Cmd-W do. */
export async function closeActiveTab() {
  const key = activeBufferKey();
  return key === null ? true : closeTab(key);
}

/**
 * Offer to save the buffers that differ from disk. False if the user cancelled.
 *
 * One prompt for however many there are, which is the change piece 4 exists
 * for: this used to ask once per file, and the fifth question looks exactly
 * like the first, which is how people learn to dismiss a dialog without reading
 * it. The wording is in unsaved.js and tested there.
 *
 * Shared by everything that is about to throw buffers away - quitting, closing
 * a tab, Close All, and both folder commands. One implementation means they
 * cannot drift into asking differently, or one of them forgetting to ask.
 *
 * @param {number[]} keys the buffers at risk, in tab order
 */
async function confirmDiscard(keys) {
  const dirty = keys.filter((key) => bufferNeedsSaving(key));
  if (dirty.length === 0) {
    return true;
  }

  const answer = await askThreeWay(
    unsavedPrompt(dirty.map((key) => bufferPath(key) ?? "Untitled")),
  );
  if (answer === "cancel") {
    return false;
  }
  if (answer === "discard") {
    return true;
  }

  for (const key of dirty) {
    // saveFile writes whichever buffer is on screen, and an unnamed one opens
    // the save dialog - so the buffer being saved has to be the one showing, or
    // the dialog would name one file and write another.
    if (activeBufferKey() !== key) {
      showBuffer(key);
      refreshTabs();
    }
    try {
      // Dismissing the save dialog is not consent to lose the work, so it
      // cancels the whole operation rather than skipping one file.
      if ((await saveFile()) === null) {
        return false;
      }
    } catch {
      // saveFile has already said so on screen; what is decided here is what
      // happens next, and the answer is nothing.
      //
      // This used to throw out of here into shutdown()'s catch, which is
      // written for a failed *prompt* and reads any throw as permission to
      // quit. So the one case where the user had explicitly asked to keep their
      // work - answer "Save", have the save fail - was also the case that
      // discarded it and closed the window. A failed save is the strongest
      // possible reason not to continue with something whose next step is to
      // throw the buffer away.
      return false;
    }
  }
  return true;
}

/** Offer to save the buffer on screen. */
export async function confirmDiscardChanges() {
  const key = activeBufferKey();
  return key === null ? true : confirmDiscard([key]);
}

/** Offer to save every buffer that differs from disk, in one prompt. */
export async function confirmDiscardAll() {
  return confirmDiscard(bufferKeys());
}

/**
 * Save every named buffer that has changed.
 *
 * Buffers that have never been saved are skipped rather than each opening a
 * save dialog: Save All is a command for getting the project onto disk, and one
 * that stops to ask where four scratch buffers should live is not that. They
 * keep their dot and are still offered when something would discard them.
 *
 * @returns {Promise<boolean>} false if a save failed
 */
export async function saveAll() {
  // Missing files are included: the buffer is the only copy left, and Save All
  // is exactly the command for getting the project back onto disk.
  const pending = bufferKeys()
    .filter((key) => bufferNeedsSaving(key) && bufferPath(key) !== null);
  if (pending.length === 0) {
    return true;
  }

  const returning = activeBufferKey();
  for (const key of pending) {
    if (activeBufferKey() !== key) {
      showBuffer(key);
      refreshTabs();
    }
    try {
      await saveFile();
    } catch {
      // Reported on screen by saveFile. Stopping here rather than carrying on
      // leaves the failure in front of the user instead of behind three more.
      return false;
    }
  }

  // Back to where they were. Save All is not a command about navigation, and
  // being left in the last file it happened to write is a surprise.
  if (returning !== null && activeBufferKey() !== returning) {
    showBuffer(returning);
    refreshTabs();
  }
  log.info(`Saved ${pending.length} file(s)`);
  return true;
}

/**
 * What a new buffer starts with.
 *
 * The default in starters.js until the user edits the field in Settings, and
 * whatever they put there afterwards - including nothing. An empty string is a
 * stored answer rather than an absent one, so it is honoured: someone who
 * clears the field wants blank files, and handing them the default back would
 * make the field impossible to switch off.
 *
 * Deliberately not the sample: that is a one-off introduction for someone who
 * has never seen the application, and it appears once. This is a preference and
 * applies to every New File from now on.
 */
export function newFileTemplate() {
  const template = getSetting(NEW_FILE_TEMPLATE_KEY, DEFAULT_NEW_FILE_TEMPLATE);
  return typeof template === "string" ? template : DEFAULT_NEW_FILE_TEMPLATE;
}

/**
 * Open a new tab on the template.
 *
 * @returns {Promise<boolean>} true; kept for the menu and toolbar callers, which
 *   treat a false from a File command as "the user cancelled"
 */
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

  // Not guarded by mayOpen, deliberately. Every one of these was opened once
  // and answered for then, and a startup that stops to ask about a file the
  // user has had open for a week - before the window is usable, several times
  // over - would be the guard doing harm. A binary file cannot be here at all,
  // because it could never have been opened to be saved in the workspace.
  for (const tab of saved === null ? [] : saved.tabs) {
    try {
      const content = await filesystem.readFile(tab.path);
      const key = openBuffer({ path: tab.path, text: content, caret: tab.caret });
      // Stamped here as well as in openPath, and this is the path that matters
      // most: a restored session is where nearly every open file comes from, so
      // a buffer without a stamp here would be one the changed-on-disk check
      // stays silent about for the whole session - and a file left open
      // overnight is exactly the one something else has written to.
      recordStamp(key, await stampAt(tab.path));
      opened.set(tab.path, key);
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
 * Check which open files are still on disk, and mark the ones that are not.
 *
 * Stat'd one by one rather than inferred from the tree's listings, because a
 * tab can name a file outside the project folder - the tree would never see it.
 * There is no watcher, deliberately: createWatcher stayed deferred until a real
 * build establishes it on all three platforms, so this runs when the tree is
 * refreshed. It is therefore not live, and it is never wrong the other way - a
 * struck-through tab really is gone.
 */
export async function checkOpenFilesExist() {
  const missing = [];
  for (const key of bufferKeys()) {
    const path = bufferPath(key);
    if (path === null) {
      continue;
    }
    try {
      await filesystem.getStats(path);
    } catch {
      missing.push(path);
    }
  }
  markMissingFiles(missing);
  if (missing.length > 0) {
    log.info(`No longer on disk: ${missing.join(", ")}`);
  }
  refreshTabs();
}

/**
 * Whether this file should go in the editor at all, asked before it is read.
 *
 * Two questions with two different answers. Something that is not text is
 * refused outright, because a PNG in a Monaco buffer is not a thing anybody
 * wanted and saving it would destroy the file. Something merely large is asked
 * about, because a big file is still a file somebody may mean to open - it is
 * only worth knowing first.
 *
 * Both are decided from a prefix and a stat rather than from the extension. A
 * build123d project is full of files whose names promise nothing: an export
 * with no suffix, a .dat somebody wrote, a .step that is text and a .3mf that
 * is a zip. The bytes know and the name does not.
 *
 * A file that cannot be stat'd or sniffed is allowed through, deliberately. The
 * read below is about to fail in the same way and report it properly, and a
 * guard that turns "I could not look" into "I refuse" would make an unreadable
 * file indistinguishable from a rejected one.
 */
async function mayOpen(path) {
  let size = null;
  let head = null;
  try {
    const stats = await filesystem.getStats(path);
    size = stats.size;
    // Not on an empty file: there is nothing to sniff, and a zero-length read
    // is the kind of edge a platform is entitled to have an opinion about.
    if (size > 0) {
      head = await filesystem.readBinaryFile(path, { pos: 0, size: Math.min(SNIFF_BYTES, size) });
    }
  } catch (error) {
    log.info(`Could not examine ${path} before opening it: ${error?.message ?? error}`);
    return true;
  }

  if (head !== null && looksBinary(new Uint8Array(head))) {
    log.info(`Refused to open ${path}: not a text file`);
    await notifyRefusal(
      "Not a text file",
      `${path}\n\nThe editor has nothing useful to show for it, and saving what it`
        + " showed would destroy the file.",
    );
    return false;
  }

  if (!isLarge(size)) {
    return true;
  }
  const answer = await askTwoWay({
    title: "This is a large file",
    detail: `${path}\n\n${describeSize(size)}. The whole of it goes to the language`
      + " server when it opens and after every edit, so the editor may be slow to keep up.",
    confirm: "Load",
    cancel: "Cancel",
  });
  if (answer !== "confirm") {
    log.info(`Did not open ${path}: ${describeSize(size)}, and the load was cancelled`);
    return false;
  }
  return true;
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
  // A file already in a tab skips the questions, and not only to save the
  // reading. It was answered for when it was opened, and being asked again
  // about a file that is on screen - or refused one that is - would be the
  // application arguing with itself.
  if (bufferForPath(path) === null && !(await mayOpen(path))) {
    return null;
  }

  let content;
  try {
    content = await filesystem.readFile(path);
  } catch (error) {
    log.warn(`Could not open ${path}:`, error);
    await notifyFailure("Could not open", `${path}\n\n${describe(error)}`);
    return null;
  }
  showInTab({ path, text: content });
  // What the file looked like when this buffer agreed with it. Read after the
  // content rather than before, so a write landing between the two is noticed
  // at the next save rather than recorded as though it were ours.
  recordStamp(bufferForPath(path), await stampAt(path));
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

/** What is on disk at a path right now, or null when there is nothing there. */
async function stampAt(path) {
  try {
    return stampOf(await filesystem.getStats(path));
  } catch {
    // Not there. Every caller here treats that as "nothing to compare".
    return null;
  }
}

// Said once per session rather than per save: a platform that reports no
// modification time makes the check below size-only, which is worth knowing
// when reading a log about a file that was overwritten anyway.
let saidAboutTimestamps = false;

function recordStamp(key, stamp) {
  if (stamp !== null && !hasTimestamp(stamp) && !saidAboutTimestamps) {
    saidAboutTimestamps = true;
    log.warn(
      "This platform reports no file modification time; the changed-on-disk"
      + " check can only compare sizes.",
    );
  }
  setBufferStamp(key, stamp);
}

// --- the recovery journal ---------------------------------------------------
//
// Nothing here runs on the keystroke path. bufferChanged() replaces a timer and
// returns; the copy is made when the typing stops. See journal.js for what that
// costs and why it is bounded.

const recorder = createRecorder();
// The version each buffer was last shadowed at, so an idle buffer is not
// rewritten and a save does not have to remember to cancel anything.
const recorded = new Map();
// And the path each copy was last labelled with, so the sixty bytes that say
// which file it is are written on a Save As and not on every burst of typing.
const labelled = new Map();
let journalDir = null;
let saidAboutLargeBuffers = false;

async function journalPath() {
  if (journalDir === null) {
    journalDir = journalRoot(await appDataDir(), log.instanceId);
  }
  return journalDir;
}

function journalDeps(root) {
  return { filesystem, log, root, instanceId: log.instanceId };
}

/**
 * A buffer was typed into. Books a copy, and does nothing else.
 *
 * Called from the editor's content-change event, so it must stay O(1): all it
 * does is replace a timer.
 */
function bufferChanged(key) {
  recorder.schedule(key, () => {
    writeRecoveryCopy(key).catch((error) => log.warn("Recovery copy:", error));
  });
}

onContentChange(bufferChanged);

async function writeRecoveryCopy(key) {
  const contents = bufferContents(key);
  if (contents === null) {
    return;
  }
  if (recorded.get(key) === contents.versionId) {
    // Nothing has changed since the last copy - an undo back to where it was,
    // or a booking a save has already overtaken.
    return;
  }
  if (!worthRecording(contents.text)) {
    if (!saidAboutLargeBuffers) {
      saidAboutLargeBuffers = true;
      log.warn(
        "A buffer is too large to keep a recovery copy of; unsaved changes to it"
        + " will not survive a crash.",
      );
    }
    return;
  }
  const root = await journalPath();
  const path = bufferPath(key);
  const withPath = labelled.get(key) !== path;
  await recordBuffer(journalDeps(root), key, {
    path, text: contents.text, stamp: bufferStamp(key), withPath,
  });
  recorded.set(key, contents.versionId);
  labelled.set(key, path);
}

/** Its copy is no longer the only one: it has been saved, or closed. */
export async function bufferSettled(key) {
  recorder.drop(key);
  if (!recorded.has(key)) {
    return;
  }
  recorded.delete(key);
  labelled.delete(key);
  const root = await journalPath();
  await forgetBuffer(journalDeps(root), root, key);
}

/**
 * Throw the whole journal away, on the way out of a graceful quit.
 *
 * Everything unsaved has just been asked about, so what is left was either
 * saved or deliberately discarded - and offering it back at the next start
 * would be arguing with an answer the user has already given.
 */
export async function discardRecovery() {
  // The bookings first. Shutdown then takes a second or more - the workspace,
  // the window, the sidecar - and a timer firing in that window would write a
  // copy of work the user has just chosen to discard, and offer it back at the
  // next start.
  recorder.dropAll();
  recorded.clear();
  labelled.clear();
  const root = await journalPath();
  await clearJournal(journalDeps(root), root);
}

/** Whether anything is still booked, for a test. */
export function pendingRecoveryWrites() {
  return recorder.pending();
}


// --- recovering what a crash left behind -----------------------------------

/** Say this window is running, now and every beat after. */
export async function startHeartbeat() {
  const root = await journalPath();
  const tick = () => {
    beat(journalDeps(root)).catch((error) => log.warn("Heartbeat:", error));
  };
  tick();
  setInterval(tick, BEAT);
}

/**
 * Offer back what a session that ended without being asked left behind.
 *
 * Everything from every dead session, in one prompt. The alternative - one
 * session per start - leaves somebody's work waiting for a restart that may
 * never come, and these are copies of work nobody chose to discard.
 *
 * Recovered buffers open **dirty and are never written**. Nothing touches disk
 * until the user saves, and the changed-on-disk check then asks if the file
 * moved in the meantime. A file that has since been deleted recovers as a
 * dirty buffer that saving recreates, which is what somebody who lost work in
 * a crash is asking for.
 */
export async function offerRecovery() {
  const dataDir = await appDataDir();
  const mine = journalRoot(dataDir, log.instanceId);
  let sessions;
  try {
    sessions = (await filesystem.readDirectory(`${dataDir}/recovery`))
      .filter((entry) => entry.type === "DIRECTORY")
      .map((entry) => `${dataDir}/recovery/${entry.entry}`)
      .filter((root) => root !== mine);
  } catch {
    // Nothing has ever crashed here.
    return 0;
  }

  const dead = [];
  for (const root of sessions) {
    const beatAt = await stampAt(`${root}/alive`);
    // A session still beating is a window somebody is typing in. Offering its
    // unsaved work back would be taking it from them.
    if (isStale(beatAt === null ? null : beatAt.modifiedAt, Date.now())) {
      dead.push(root);
    }
  }
  if (dead.length === 0) {
    return 0;
  }

  const entries = [];
  for (const root of dead.sort()) {
    entries.push(...(await readJournal({ filesystem, log }, root)));
  }
  if (entries.length === 0) {
    await Promise.all(dead.map((root) => clearJournal({ filesystem, log }, root)));
    return 0;
  }

  const names = entries.map((entry) => nameOf(entry.path)).join(", ");
  const answer = await askTwoWay({
    title: "Recover unsaved changes?",
    detail: `${entries.length} file(s) from ${dead.length} session(s) that ended`
      + ` unexpectedly.\n\n${names}`,
    confirm: "Recover",
    cancel: "Discard",
  });
  if (answer !== "confirm") {
    log.info(`Discarded ${entries.length} recovery copies at the user's request`);
    await Promise.all(dead.map((root) => clearJournal({ filesystem, log }, root)));
    return 0;
  }

  // Newest wins a path, and the loser is kept rather than deleted.
  //
  // Grouped before anything is opened, because "apply the newer copy to the
  // buffer" and "leave the older one alone" cannot both be decided one entry at
  // a time. Sessions arrive oldest first, so the last copy of a path is the one
  // somebody was working on most recently.
  const newest = new Map();
  const superseded = [];
  for (const entry of entries) {
    if (entry.path === null) {
      continue;
    }
    const previous = newest.get(entry.path);
    if (previous !== undefined) {
      superseded.push(previous);
    }
    newest.set(entry.path, entry);
  }
  const chosen = entries.filter(
    (entry) => entry.path === null || newest.get(entry.path) === entry,
  );

  const recoveredKeys = [];
  for (const entry of chosen) {
    const held = entry.path === null ? null : bufferForPath(entry.path);
    if (held === null) {
      recoveredKeys.push(openBuffer({ path: entry.path, text: entry.text, matchesDisk: false }));
    } else {
      // Already open, and this is the ordinary case rather than a rarity: the
      // session restore runs first and reopens exactly the files that were open
      // at the crash - from disk, so the tab holds the *old* text while the
      // copy holds the newer unsaved work. Skipping it here recovered nothing
      // at all for every named file, which is what this function is for.
      //
      // The text replaces the buffer's, which leaves it dirty because its saved
      // version is the one the disk read produced.
      reloadBufferText(held, entry.text);
      recoveredKeys.push(held);
    }
    // The stamp the buffer agreed with before the crash, so the first save
    // compares against that rather than against nothing - and asks if somebody
    // else has written the file in the meantime.
    recordStamp(recoveredKeys[recoveredKeys.length - 1], entry.stamp);
  }
  refreshTabs();

  // Shadowed into *this* session's journal before the old one is cleared, so
  // the text is never held only in memory. A recovered buffer is not typed into
  // by definition, and nothing else would have written a copy of it until it
  // was - so a second crash used to take work the user had explicitly recovered.
  for (const key of recoveredKeys) {
    await writeRecoveryCopy(key);
  }

  for (const entry of superseded) {
    const kept = await setAside({ filesystem, log }, dataDir, entry);
    log.warn(
      `${entry.path} was unsaved in more than one session; the older copy is`
      + (kept === null ? ` still at ${entry.file}` : ` at ${kept}`),
    );
  }

  log.info(`Recovered ${recoveredKeys.length} buffer(s) from ${dead.length} session(s)`);
  await Promise.all(dead.map((root) => clearJournal({ filesystem, log }, root)));
  await saveWorkspace();
  return recoveredKeys.length;
}

function nameOf(path) {
  if (path === null) {
    return "(untitled)";
  }
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}

/** Whether anything at all is at a path - a file, a folder, or a link. */
async function somethingIsAt(path) {
  try {
    await filesystem.getStats(path);
    return true;
  } catch {
    // Nothing there, which is what a Save As to a new name expects.
    return false;
  }
}

// Buffers with a save in flight, and the promise each caller should wait on.
//
// A second Cmd-S while the first is still formatting used to start a second
// save of the same buffer: two writes to one temporary, and whichever finished
// last put its content there - which, if the first was the slower, is the older
// text, left behind a tab that reads clean. Returning the promise rather than
// refusing keeps every caller's contract: null means the user cancelled, and a
// second asker gets the first's answer instead of a cancellation it never made.
const saving = new Map();

/**
 * Write a buffer to disk.
 *
 * **The buffer is captured at entry and carried through**, which is the whole
 * shape of this function. There are two awaits in it - a format that can take
 * as long as the sidecar takes, and the write itself - and the editor is live
 * across both: a click on another tab changes which buffer is "current" while
 * this is running. Everything below therefore names its buffer by key and
 * reads its text from that buffer's own model, rather than asking what is on
 * screen and getting an answer about a different file.
 *
 * What that cost when it did ask: the text of whichever buffer the user had
 * switched to was written into the path this one had captured, and then *that*
 * buffer was re-pathed to this file and marked clean. Two tabs claiming one
 * path, one file holding another file's contents, and nothing dirty left to
 * prompt about at quit.
 */
export async function saveFile({ saveAs = false } = {}) {
  const key = activeBufferKey();
  if (key === null) {
    return null;
  }
  const inFlight = saving.get(key);
  if (inFlight !== undefined) {
    return inFlight;
  }
  const attempt = saveBuffer(key, saveAs);
  saving.set(key, attempt);
  try {
    return await attempt;
  } finally {
    saving.delete(key);
  }
}

/**
 * Take what is on disk into the buffer, instead of writing over it.
 *
 * An edit rather than a fresh buffer, so the tab and the undo stack survive:
 * somebody who reloads by mistake has just lost their work to a button, and
 * being able to undo it is the difference between a choice and a trap.
 *
 * Returns null, which every caller reads as "not saved" - because it was not.
 * Run and Debug abort on it, and a quit stops rather than discarding the
 * buffer, which is right: reloading answered the conflict, not the request.
 */
async function reloadFrom(key, path) {
  let content;
  try {
    content = await filesystem.readFile(path);
  } catch (error) {
    log.error(`Could not reload ${path}:`, error);
    await notifyFailure("Could not reload", `${path}\n\n${describe(error)}`);
    return null;
  }
  const versionId = reloadBufferText(key, content);
  markSaved(key, versionId);
  recordStamp(key, await stampAt(path));
  refreshTabs();
  log.info(`Reloaded ${path} rather than overwriting it`);
  return null;
}

async function saveBuffer(key, saveAs) {
  let path = bufferPath(key);

  if (saveAs || path === null) {
    path = await os.showSaveDialog("Save", {
      defaultPath: path ?? (await startingFolder()),
      filters: FILTERS,
    });
    if (path === "" || path === undefined) {
      return null;
    }
    const chosen = path;
    path = withPythonExtension(path);

    // The dialog asked about the name the user typed, and .py is added after
    // it has closed. So typing "bracket" where a bracket.py already exists got
    // no overwrite prompt from anybody - the dialog had vetted a name that does
    // not exist, and the write went to one that does.
    //
    // Only when the extension was actually added, which is also what makes this
    // right on a platform whose own dialog appends it: there the name it vetted
    // already carried .py, so its own overwrite prompt has been seen and asking
    // again would be a second dialog about the same file.
    if (path !== chosen && await somethingIsAt(path)) {
      const answer = await askTwoWay({
        title: "Replace the existing file?",
        detail: `${path} already exists.\n\n.py was added to the name you typed, so the save would write to it.`,
        confirm: "Replace",
        cancel: "Cancel",
      });
      if (answer !== "confirm") {
        return null;
      }
    }

    // And a file another tab is holding cannot be taken from it. Two buffers on
    // one path have no correct behaviour left between them: both dirty against
    // the same bytes, and whichever saves last wins silently.
    const holder = bufferForPath(path);
    if (holder !== null && holder !== key) {
      await notifyRefusal(
        "Could not save there",
        `${path} is open in another tab.\n\nClose it first, or save somewhere else.`,
      );
      return null;
    }
  }

  // Formatted before it is written, never after: what lands on disk and what
  // is on screen have to be the same text, and formatting the file underneath
  // the buffer would leave the tab showing the old layout and claiming to be
  // clean. Awaited for the same reason - the write below reads the buffer.
  //
  // Failure here is not failure to save. black declining a buffer that does not
  // parse is the ordinary state of a file being typed into, and refusing to
  // write it would turn a formatter into an obstacle between somebody and their
  // own work.
  // isConnected first, because the alternative is a save that hangs. The
  // request would otherwise sit out its whole timeout before failing, and a
  // Cmd-S that takes half a minute because the sidecar died is a worse answer
  // than a file saved with the layout it already had.
  // Only while this buffer is still the one on screen, because formatBuffer is
  // the one thing on this path that is not keyed: it runs Monaco's format
  // action against the editor, which means whichever model the editor is
  // showing. A Save As dialog or the changed-on-disk prompt above can sit open
  // for as long as somebody takes to answer it, and a click on another tab in
  // that time used to format *that* buffer instead - leaving it dirty with an
  // edit nobody asked for while this one was written unformatted.
  //
  // Not formatting is the harmless half of that choice. The file is saved
  // either way, and the next save formats it.
  if (formatOnSave() && ipc.isConnected()) {
    if (activeBufferKey() === key) {
      try {
        await formatBuffer();
      } catch (error) {
        log.warn("Not formatted before saving:", error);
      }
    } else {
      log.info("Not formatted: another buffer is on screen by the time it saved");
    }
  }

  // The text and the version it is on, from the captured buffer and as one
  // instant. The version is what markSaved is told below: taking a fresh
  // reading after the write would mark as saved every keystroke typed while it
  // was in flight, so the tab would lose its dot and quitting would ask
  // nothing about work that never reached the disk.
  // Has anybody else written this file since we last agreed with it?
  //
  // Checked here, after the format and immediately before the write, because
  // this is the last moment at which the answer is still true. Nothing used to
  // compare anything: openPath deliberately never re-reads a file already in a
  // tab, and the only external change ever noticed was deletion, on a manual
  // refresh. So a file edited in another program - or in a second window of
  // this one - was replaced without a word.
  const before = bufferStamp(key);
  const now = await stampAt(path);
  if (changedSince(before, now)) {
    const answer = await askThreeWay({
      title: "It changed on disk",
      detail: `${path} was modified by something else since it was opened here.`,
      save: "Overwrite",
      discard: "Reload",
      cancel: "Cancel",
    });
    if (answer === "cancel") {
      return null;
    }
    if (answer === "discard") {
      return reloadFrom(key, path);
    }
    // Overwrite: their edits go, which is what was asked for.
    log.warn(`Overwriting ${path}, which had changed on disk`);
  }

  const contents = bufferContents(key);
  if (contents === null) {
    // Closed while it was being formatted. Nothing to write, and nothing to
    // report: closing a buffer already asked about its unsaved work.
    log.info("Not saved: the buffer was closed while it was being formatted");
    return null;
  }

  try {
    const written = await writeFileSafely(
      { filesystem, log, instanceId: log.instanceId }, path, contents.text,
    );
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
  if (!bufferExists(key)) {
    // Closed during the write. The bytes are on disk, which is what was asked
    // for; there is no longer a buffer to re-path or mark clean.
    log.info(`Saved ${path}, whose buffer was closed while it was being written`);
    return path;
  }
  if (!setCurrentFile(key, path)) {
    log.warn(`Saved ${path}, but another buffer already holds that path`);
  }
  markSaved(key, contents.versionId);
  // Written by us, so this is now the state we agree with. Read back rather
  // than assumed: the size on disk is the encoded length, and the time is the
  // filesystem's rather than ours.
  recordStamp(key, await stampAt(path));
  // Only if the buffer still holds what was written. Keystrokes that landed
  // during the write leave it dirty at a later version, and those are exactly
  // the ones with no other copy - dropping their booking, or deleting a copy
  // already made of them, would break the one second this journal promises.
  const settled = bufferContents(key);
  if (settled === null || settled.versionId === contents.versionId) {
    await bufferSettled(key);
  }
  refreshTabs();
  await rememberFolder(path);
  syncKernelDirectory();
  await saveWorkspace();
  log.info("Saved", path);
  return path;
}
