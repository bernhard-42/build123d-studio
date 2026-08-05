// The folder tree.
//
// Lazy by construction: a directory's contents are read the first time it is
// expanded and not before. That is not an optimisation, it is what makes Open
// Folder usable at all - a CAD project is full of STEP and STL exports, and
// reading the whole hierarchy up front would hang the window on exactly the
// projects worth opening. filesystem.readDirectory takes a `recursive` option
// and this deliberately never passes it.
//
// What is read is cached and only re-read on Refresh. Live updates through
// createWatcher are the obvious next step and are deliberately not here yet:
// the API is undocumented enough that its behaviour wants establishing with a
// real build on all three platforms before anything depends on it.
//
// Ordering, filtering and path joining are in tree.js, which has no DOM and is
// tested. This file is rows and clicks.

import { filesystem } from "@neutralinojs/lib";

import {
  baseName,
  freeName,
  isInside,
  joinPath,
  nameProblem,
  parentOf,
  separatorOf,
  targetFolder,
  visibleEntries,
} from "./tree.js";
import { notifyFailure } from "../confirm.js";
import { getSetting, setSetting } from "../store.js";
import { refreshLayout } from "../layout/splitter.js";
import * as log from "../log.js";

// Whether the tree is on show, which is separate from whether a folder is open.
// Hiding it is about screen space and survives a restart; closing the folder is
// about which project you are in. Cmd-B toggles the first and never the second,
// so bringing the tree back does not mean finding the folder again.
const HIDDEN_KEY = "sidebarHidden";

let root = null;
let openFile = null;
// Told after every refresh, so the editor can check whether the files its tabs
// name are still there. The tree does not know about buffers and should not.
let refreshed = () => {};
let hidden = false;
// Whether the tree pane was on screen after the last render, so that a change
// in that - and only a change - re-measures the grid. See render().
let visible = false;
// The file the editor is showing, so the tree can say which one it is.
let active = null;
// The row last clicked, which is a different thing: it can be a folder, and a
// folder is never "active" because opening one is not showing it. This is what
// New file and New folder create beside - see targetFolder.
let selected = null;
// A row being named. It exists in the tree and not on disk: nothing is created
// until the name is accepted, so changing your mind leaves no untitled.py
// behind to tidy up. { kind, folder, name } or null.
let pending = null;
// Which directories are showing their contents, and what those contents are.
// Both are keyed by full path, so an expanded folder stays expanded across a
// refresh even if its parent's listing changed underneath it.
const expanded = new Set();
const children = new Map();

export function initSidebar({ onOpenFile, onRefreshed = () => {} }) {
  openFile = onOpenFile;
  refreshed = onRefreshed;
  hidden = getSetting(HIDDEN_KEY) === true;
  document.getElementById("tree-refresh").addEventListener("click", () => {
    refreshSidebar().catch((error) => log.warn("Could not refresh the tree:", error));
  });
  document.getElementById("tree-new-file").addEventListener("click", () => {
    beginCreating("file").catch((error) => log.warn("Could not start a new file:", error));
  });
  document.getElementById("tree-new-folder").addEventListener("click", () => {
    beginCreating("folder").catch((error) => log.warn("Could not start a new folder:", error));
  });
  // Draw once with no folder, which is what greys the toolbar's toggle before
  // anything has been opened.
  render();
}

/** The folder on show, or null. */
export function sidebarRoot() {
  return root;
}

/** Whether the tree would be visible if a folder were open. */
export function sidebarHidden() {
  return hidden;
}

/**
 * Show or hide the tree without touching the folder.
 *
 * The toggle lives on the toolbar and on Cmd-B rather than inside the tree,
 * because a control inside the thing it hides cannot bring it back.
 */
export async function toggleSidebar() {
  hidden = !hidden;
  // render() re-measures the grid, because the tree appearing or going away
  // changes how much width the panes beside it have.
  render();
  await setSetting(HIDDEN_KEY, hidden);
  return hidden;
}

export async function showFolder(path) {
  root = path;
  expanded.clear();
  children.clear();
  expanded.add(path);
  await read(path);
  render();
}

export function hideFolder() {
  root = null;
  active = null;
  expanded.clear();
  children.clear();
  render();
}

/**
 * Point at the file the editor is showing, opening the way down to it.
 *
 * Two jobs that are really one: highlight the row, and make sure the row
 * exists. A file three directories down is not in the tree at all until its
 * ancestors are expanded, and "highlighted but not rendered" is no use to
 * anybody - which is what a restored session looked like, the right file open
 * and a collapsed tree beside it.
 *
 * Silent when the file is outside the folder, which is a perfectly ordinary
 * state: a tab from elsewhere is still a tab. The highlight simply goes.
 */
export async function revealInTree(path) {
  active = path;
  if (root === null || typeof path !== "string" || !isInside(root, path)) {
    render();
    return;
  }

  const separator = separatorOf(root);
  const relative = path.slice(root.endsWith(separator) ? root.length : root.length + 1);
  // Every directory between the root and the file, dropping the filename.
  let walked = root;
  for (const segment of relative.split(/[/\\]/).slice(0, -1)) {
    walked = joinPath(walked, segment);
    expanded.add(walked);
    if (!children.has(walked)) {
      await read(walked);
    }
  }
  render();
  document.querySelector(".tree-active")?.scrollIntoView({ block: "nearest" });
}

/**
 * Re-read every directory that is currently open.
 *
 * Only the expanded ones, because those are the only listings on screen - and
 * re-reading the collapsed ones would walk the whole project to update rows
 * nobody can see.
 */
export async function refreshSidebar() {
  if (root === null) {
    return;
  }
  // Shallowest first, so a folder is re-read before the children that claim to
  // be under it - which is what lets the prune below see a whole deleted
  // subtree rather than only its top.
  for (const path of [...expanded].sort((a, b) => a.length - b.length)) {
    await read(path);
  }
  forgetWhatIsGone();
  render();
  refreshed();
}

/**
 * Drop what the last read says is no longer there.
 *
 * Without this the tree remembers deleted folders for ever: `read` answers an
 * unreadable directory with an empty listing rather than an error, so a folder
 * removed from a terminal stays in `expanded` and stays selected. Nothing shows
 * it - the row is gone, because its parent no longer lists it - and then New
 * file quietly does nothing, because the row it wants to add is a child of a
 * folder the render never visits. That was the bug: both buttons dead after an
 * external delete and a refresh, with no error anywhere.
 */
function forgetWhatIsGone() {
  const lists = (parent, path) => {
    const listing = children.get(parent);
    // An unknown parent is not evidence of absence - only a parent we have just
    // read and which does not mention it.
    return listing === undefined
      || listing.some((entry) => joinPath(parent, entry.name) === path);
  };

  for (const path of [...expanded].sort((a, b) => a.length - b.length)) {
    const parent = parentOf(path);
    if (path === root || parent === null) {
      continue;
    }
    if (!expanded.has(parent) && parent !== root) {
      // Its parent is collapsed, so nothing has been read that could disprove
      // it. Left alone.
      continue;
    }
    if (!lists(parent, path)) {
      expanded.delete(path);
      children.delete(path);
    }
  }

  if (selected !== null && selected !== root) {
    const parent = parentOf(selected);
    if (parent !== null && !lists(parent, selected)) {
      selected = null;
    }
  }
}

async function read(path) {
  try {
    const entries = await filesystem.readDirectory(path);
    children.set(path, visibleEntries(entries.map((entry) => ({
      name: entry.entry,
      isDirectory: entry.type === "DIRECTORY",
    }))));
  } catch (error) {
    // Deleted since, or not readable. An empty listing is the honest display,
    // and one line in the log is the right amount of noise for a folder the
    // user may have moved themselves.
    log.info(`Cannot read ${path}: ${error?.message ?? error}`);
    children.set(path, []);
  }
}

/** Flatten the expanded parts of the tree into the rows actually on screen. */
function rowsUnder(path, depth, out) {
  // The row being named comes first in its folder, where the eye already is
  // after clicking the button - rather than in sort position, which for
  // "untitled" is usually the bottom of a long list.
  if (pending !== null && pending.folder === path) {
    out.push({ pending: true, depth });
  }
  for (const entry of children.get(path) ?? []) {
    const full = joinPath(path, entry.name);
    out.push({ ...entry, path: full, depth });
    if (entry.isDirectory && expanded.has(full)) {
      rowsUnder(full, depth + 1, out);
    }
  }
  return out;
}

function render() {
  const pane = document.getElementById("pane-tree");
  const body = document.getElementById("tree-body");
  const away = root === null || hidden;
  pane.hidden = away;
  // Nothing to show and nothing to hide when no folder is open, and a control
  // that does nothing is worse than one that says it cannot.
  document.getElementById("btn-sidebar").disabled = root === null;
  // The splitter goes with it: a handle for dragging the width of something
  // that is not there is a five-pixel strip that does nothing.
  document.getElementById("splitter-tree").hidden = away;

  // Re-measure whenever the tree comes or goes, whatever brought it.
  //
  // The panes are sized in pixels computed from their container's width, so a
  // tree that appears after that measurement leaves both vertical splitters too
  // far right - and nothing re-measures until something else is dragged, which
  // is why dragging the console/explorer boundary used to snap the editor and
  // viewer back into place. It lives here rather than in the callers because
  // toggleSidebar remembered to do it and opening a folder did not: every route
  // that changes this visibility goes through render.
  if (visible === away) {
    visible = !away;
    refreshLayout();
  }

  if (away) {
    body.replaceChildren();
    return;
  }
  document.getElementById("tree-root").textContent = baseName(root);
  document.getElementById("tree-root").title = root;
  describeCreateTargets();
  body.replaceChildren(...rowsUnder(root, 0, []).map(
    (row) => (row.pending === true ? renderPendingRow(row.depth) : renderRow(row)),
  ));
}

function renderRow(row) {
  const element = document.createElement("div");
  const classes = ["tree-row", row.isDirectory ? "tree-dir" : "tree-file"];
  if (row.path === active) {
    classes.push("tree-active");
  }
  if (row.path === selected) {
    classes.push("tree-selected");
  }
  element.className = classes.join(" ");
  element.style.paddingLeft = `${6 + row.depth * 14}px`;
  element.title = row.path;

  const twisty = document.createElement("span");
  twisty.className = "tree-twisty";
  // The bundled icon font rather than a triangle character. U+25B8 and U+25BE
  // are the obvious choice and were the first one, and WKWebView had no glyph
  // for either - they came out as a dot. The subset font ships with the
  // application, so it either renders or nothing does.
  //
  // A file's twisty is an empty box of the same width, so names line up down
  // the column instead of stepping in and out with the folders.
  if (row.isDirectory) {
    const chevron = document.createElement("span");
    chevron.className = expanded.has(row.path)
      ? "icon icon-chevron tree-open"
      : "icon icon-chevron";
    twisty.appendChild(chevron);
  }
  element.appendChild(twisty);

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = row.name;
  element.appendChild(label);

  element.addEventListener("click", () => {
    selected = row.path;
    // Named on the buttons as well as marked on the row, because the tree can
    // be scrolled away from whatever is selected - and "New file" with no
    // indication of where is a question with a hidden second half.
    describeCreateTargets();
    if (row.isDirectory) {
      toggle(row.path).catch((error) => log.warn("Could not expand the folder:", error));
      return;
    }
    openFile(row.path);
  });
  return element;
}

/** Whether this path is a directory right now, according to the filesystem. */
async function isFolder(path) {
  try {
    const stats = await filesystem.getStats(path);
    return stats.isDirectory === true;
  } catch {
    return false;
  }
}

/** Say on the buttons which folder they would create in. */
function describeCreateTargets() {
  if (root === null) {
    return;
  }
  const isDirectory = selected !== null && children.has(selected);
  const folder = targetFolder(root, selected, isDirectory);
  const where = folder === root ? baseName(root) : baseName(folder);
  const file = document.getElementById("tree-new-file");
  const directory = document.getElementById("tree-new-folder");
  if (file !== null) {
    file.title = `New file in ${where}`;
  }
  if (directory !== null) {
    directory.title = `New folder in ${where}`;
  }
}

/**
 * Put an editable row in the tree, in the folder the selection points at.
 *
 * Nothing is written yet. The row exists here and not on disk, which is what
 * makes changing your mind free - the alternative, creating untitled.py and
 * renaming it afterwards, leaves one behind every time somebody presses Escape.
 *
 * The folder is expanded first, or the row would be a child of something the
 * user cannot see.
 */
async function beginCreating(kind) {
  if (root === null) {
    return;
  }
  const isDirectory = selected !== null && children.has(selected);
  let folder = targetFolder(root, selected, isDirectory);
  // Asked of the filesystem rather than of what is remembered. The selection
  // can name something deleted from outside the application since it was
  // clicked, and creating into a folder that is not there fails in the worst
  // way available - the row never appears, because render walks the tree from
  // the root and never reaches it.
  if (folder !== root && !(await isFolder(folder))) {
    log.info(`${folder} is gone; creating in ${root} instead`);
    selected = null;
    folder = root;
  }
  if (!children.has(folder)) {
    await read(folder);
  }
  expanded.add(folder);
  const existing = (children.get(folder) ?? []).map((entry) => entry.name);
  pending = {
    kind,
    folder,
    // Already typed, so Enter alone makes a file - and numbered, so Enter twice
    // makes two rather than one failure.
    name: freeName("untitled", kind === "folder" ? "" : ".py", existing),
  };
  render();
  focusPendingRow();
}

/** Select the part worth retyping: the name, not the extension. */
function focusPendingRow() {
  const field = document.getElementById("tree-new-name");
  if (field === null) {
    return;
  }
  field.focus();
  const dot = field.value.lastIndexOf(".");
  field.setSelectionRange(0, dot > 0 ? dot : field.value.length);
}

function cancelCreating() {
  if (pending === null) {
    return;
  }
  pending = null;
  render();
}

/** Write it, and show what was made rather than leaving it to be found. */
async function commitCreating(name) {
  if (pending === null) {
    return;
  }
  const { kind, folder } = pending;
  const path = joinPath(folder, name);
  pending = null;

  try {
    if (kind === "folder") {
      await filesystem.createDirectory(path);
    } else {
      // Empty, and deliberately not the New File template: that template
      // explains the run chords to somebody meeting the application, and a file
      // made inside an existing project is not that moment.
      await filesystem.writeFile(path, "");
    }
  } catch (error) {
    log.warn(`Could not create ${path}:`, error);
    render();
    await notifyFailure(
      kind === "folder" ? "Could not create the folder" : "Could not create the file",
      `${path}\n\n${error?.message ?? error}`,
    );
    return;
  }

  log.info(`Created ${path}`);
  // Only the folder it went into is re-read: nothing else changed, and a
  // refresh of the whole tree would be a lot of directory reads to show one
  // new row.
  await read(folder);
  selected = path;
  if (kind === "folder") {
    expanded.add(path);
    await read(path);
    render();
    return;
  }
  render();
  openFile(path);
}

/** The row being named: an input where a label would be. */
function renderPendingRow(depth) {
  const element = document.createElement("div");
  element.className = `tree-row ${pending.kind === "folder" ? "tree-dir" : "tree-file"}`;
  element.style.paddingLeft = `${6 + depth * 14}px`;

  const twisty = document.createElement("span");
  twisty.className = "tree-twisty";
  element.appendChild(twisty);

  const field = document.createElement("input");
  field.className = "tree-input";
  field.id = "tree-new-name";
  field.type = "text";
  field.spellcheck = false;
  field.autocomplete = "off";
  field.value = pending.name;

  const problem = document.getElementById("tree-problem");
  const say = (text) => {
    if (problem !== null) {
      problem.textContent = text ?? "";
      problem.hidden = text === null || text === undefined;
    }
  };

  field.addEventListener("input", () => {
    pending.name = field.value;
    const existing = (children.get(pending.folder) ?? []).map((entry) => entry.name);
    say(field.value.trim() === "" ? null : nameProblem(field.value, existing));
  });

  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      say(null);
      cancelCreating();
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const existing = (children.get(pending.folder) ?? []).map((entry) => entry.name);
    const why = nameProblem(field.value, existing);
    if (why !== null) {
      // Said, and the row stays open. Refusing silently would look like Enter
      // not working.
      say(why);
      return;
    }
    say(null);
    commitCreating(field.value.trim())
      .catch((error) => log.warn("Could not create it:", error));
  });

  // Clicking away is a cancel, as it is in VS Code. Deferred a tick so that a
  // click on the row's own input does not cancel it before it is read.
  field.addEventListener("blur", () => setTimeout(() => {
    if (pending !== null) {
      say(null);
      cancelCreating();
    }
  }, 0));

  element.appendChild(field);
  return element;
}

async function toggle(path) {
  if (expanded.has(path)) {
    expanded.delete(path);
    render();
    return;
  }
  expanded.add(path);
  if (!children.has(path)) {
    await read(path);
  }
  render();
}
