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

import { baseName, isInside, joinPath, separatorOf, visibleEntries } from "./tree.js";
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
let hidden = false;
// The file the editor is showing, so the tree can say which one it is.
let active = null;
// Which directories are showing their contents, and what those contents are.
// Both are keyed by full path, so an expanded folder stays expanded across a
// refresh even if its parent's listing changed underneath it.
const expanded = new Set();
const children = new Map();

export function initSidebar({ onOpenFile }) {
  openFile = onOpenFile;
  hidden = getSetting(HIDDEN_KEY) === true;
  document.getElementById("tree-refresh").addEventListener("click", () => {
    refreshSidebar().catch((error) => log.warn("Could not refresh the tree:", error));
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
  render();
  // The panes are laid out in pixels from their container's width, so the grid
  // has to be re-measured now that it is wider or narrower.
  refreshLayout();
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
  for (const path of [...expanded]) {
    await read(path);
  }
  render();
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
  if (away) {
    body.replaceChildren();
    return;
  }
  document.getElementById("tree-root").textContent = baseName(root);
  document.getElementById("tree-root").title = root;
  body.replaceChildren(...rowsUnder(root, 0, []).map(renderRow));
}

function renderRow(row) {
  const element = document.createElement("div");
  const classes = ["tree-row", row.isDirectory ? "tree-dir" : "tree-file"];
  if (row.path === active) {
    classes.push("tree-active");
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
    if (row.isDirectory) {
      toggle(row.path).catch((error) => log.warn("Could not expand the folder:", error));
      return;
    }
    openFile(row.path);
  });
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
