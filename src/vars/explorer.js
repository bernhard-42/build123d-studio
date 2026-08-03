import { getSetting, setSetting } from "../store.js";
import { columnWidths, isUnder, pageInfo, pathKey, resized } from "./tree.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";

// The variable explorer.
//
// Rows are pushed by the sidecar whenever the kernel goes idle, so the pane is
// current after a Run or after typing in the console, without polling. Nothing
// here asks the kernel for anything until a row is expanded: listing is cheap
// on purpose, and geometry - volume, area, face counts - is real work in OCCT.
//
// Rows are addressed by path rather than by name, which is what lets the tree
// go as deep as the data does: ["a", 3, 0] is the first child of the fourth
// child of `a`. See tree.js.

const COLUMNS_KEY = "varColumns";

// Every row that is open, and what came back for it. Both keyed by the path's
// JSON, because a path is an array and arrays are compared by identity.
const expanded = new Set();
const details = new Map();
// Which page of children each open row is showing. Kept separately from the
// detail so that turning a page does not lose the row while the answer is in
// flight - the pane would otherwise collapse and redraw under the click.
const pages = new Map();

let rows = [];
let widths = columnWidths(null);

function paneElement() {
  return document.getElementById("pane-vars");
}

function formatSize(size) {
  if (size === null || size === undefined) {
    return "";
  }
  return String(size);
}

// This pane is built from nodes rather than from an HTML string, and that is
// deliberate. Everything in it - names, types, and above all repr() output -
// comes from objects in the user's kernel, so it is the least controlled text
// in the application; and the webview can reach os.* and filesystem.* through
// Neutralino, which makes one missed interpolation arbitrary command execution
// rather than a broken table. textContent cannot be got wrong the way an
// escaping helper can be forgotten.

function cell(className, text, { colSpan } = {}) {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  if (colSpan !== undefined) {
    td.colSpan = colSpan;
  }
  return td;
}

/** Ask for a row's contents, unless the same question is already outstanding. */
function request(path, offset) {
  try {
    ipc.send("vars.detail", { path, offset });
  } catch (error) {
    log.warn("Could not request variable detail:", error);
  }
}

/**
 * The rows under one open row: its repr, then its children or its attributes.
 *
 * Depth is passed down rather than derived from the path, because the top level
 * is a variable and everything below it is an element - the indent should step
 * once per level regardless of how the path is shaped.
 */
function subtreeFor(path, depth) {
  const key = pathKey(path);
  const detail = details.get(key);
  const out = [];

  if (detail === undefined) {
    out.push(detailRow(depth, cell("var-loading", "loading…", { colSpan: 3 })));
    return out;
  }
  if (detail.error) {
    out.push(detailRow(depth, cell("var-error", detail.error, { colSpan: 3 })));
    return out;
  }

  for (const [name, value] of Object.entries(detail.attributes ?? {})) {
    const tr = detailRow(depth, cell("var-detail-key", name));
    tr.append(cell("var-detail-value", Array.isArray(value) ? value.join(", ") : String(value), {
      colSpan: 2,
    }));
    out.push(tr);
  }

  for (const [index, child] of (detail.children ?? []).entries()) {
    const childPath = [...path, (detail.offset ?? 0) + index];
    out.push(...rowsFor(child, childPath, depth + 1));
  }

  const pager = pageInfo({
    offset: detail.offset,
    total: detail.total,
    page: detail.page,
    count: (detail.children ?? []).length,
  });
  if (pager !== null) {
    out.push(pagerRow(path, depth, pager));
  }

  if (out.length === 0) {
    out.push(detailRow(depth, cell("var-detail-value", "no further detail", { colSpan: 3 })));
  }
  return out;
}

function detailRow(depth, first) {
  const tr = document.createElement("tr");
  tr.className = "var-detail";
  first.style.paddingLeft = `${indentOf(depth)}px`;
  tr.append(first);
  return tr;
}

/** How far in a row at this depth sits. The chevron column is 12px of it. */
function indentOf(depth) {
  return 6 + depth * 12;
}

function pagerRow(path, depth, pager) {
  const tr = document.createElement("tr");
  tr.className = "var-pager";
  const td = document.createElement("td");
  td.colSpan = 3;
  td.style.paddingLeft = `${indentOf(depth)}px`;

  const back = document.createElement("button");
  back.className = "var-page-btn";
  back.textContent = "‹";
  back.title = "Previous page";
  back.disabled = !pager.hasPrev;
  back.addEventListener("click", (event) => {
    event.stopPropagation();
    turnTo(path, pager.prevOffset);
  });

  const forward = document.createElement("button");
  forward.className = "var-page-btn";
  forward.textContent = "›";
  forward.title = "Next page";
  forward.disabled = !pager.hasNext;
  forward.addEventListener("click", (event) => {
    event.stopPropagation();
    turnTo(path, pager.nextOffset);
  });

  const label = document.createElement("span");
  label.className = "var-page-label";
  label.textContent = pager.label;

  td.append(back, forward, label);
  tr.append(td);
  return tr;
}

function turnTo(path, offset) {
  pages.set(pathKey(path), offset);
  // The rows in hand describe the page being left, so they are dropped and the
  // row says "loading" until the new page arrives. Keeping them would show one
  // page under a pager that claims to be on another.
  details.delete(pathKey(path));
  render();
  request(path, offset);
}

/** One row and, if it is open, everything under it. */
function rowsFor(row, path, depth) {
  const key = pathKey(path);
  const isOpen = expanded.has(key);
  const out = [];

  const head = document.createElement("tr");
  head.className = "var-row";

  const name = document.createElement("td");
  name.className = depth === 0 ? "var-name" : "var-name var-child-name";
  name.style.paddingLeft = `${indentOf(depth)}px`;

  const twisty = document.createElement("span");
  twisty.className = "var-twisty";
  // Only where opening leads somewhere. A chevron on an int is a promise the
  // row cannot keep, and the kernel is the only thing that can say - cheaply,
  // without touching the object - which those are.
  twisty.textContent = row.expandable === false ? "" : isOpen ? "▾" : "▸";
  name.append(twisty, document.createTextNode(row.name));

  // The label beside the name, because that is where identity belongs: a list
  // of six faces is six rows called 0 to 5, and the label is the only thing
  // that says which is the top one. build123d puts it on every shape.
  if (typeof row.label === "string" && row.label !== "") {
    const label = document.createElement("span");
    label.className = "var-label";
    label.textContent = row.label;
    name.append(" ", label);
  }
  head.append(name);

  const type = cell("var-type", row.type ?? "");
  if (row.size !== null && row.size !== undefined && row.size !== "") {
    const size = document.createElement("span");
    size.className = "var-size";
    size.textContent = `[${formatSize(row.size)}]`;
    type.append(" ", size);
  }
  head.append(type, cell("var-repr", row.repr ?? ""));

  if (row.expandable !== false) {
    head.classList.add("var-openable");
    head.addEventListener("click", () => toggle(path));
  }
  out.push(head);

  if (isOpen) {
    out.push(...subtreeFor(path, depth + 1));
  }
  return out;
}

function render() {
  const pane = paneElement();
  pane.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "var-empty";
    empty.textContent = "No variables yet. Run some code.";
    pane.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "var-table";
  table.append(columnGroup(), header());

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    tbody.append(...rowsFor(row, [row.name], 0));
  }
  table.append(tbody);
  pane.append(table);
}

/**
 * The widths, as a colgroup.
 *
 * On the columns rather than on every cell: the table is table-layout: fixed,
 * so a col's width is what decides the layout, and setting it in one place
 * means a drag rewrites three numbers instead of three per row.
 */
function columnGroup() {
  const group = document.createElement("colgroup");
  for (const width of [`${widths.name}%`, `${widths.type}%`, "auto"]) {
    const col = document.createElement("col");
    col.style.width = width;
    group.append(col);
  }
  return group;
}

/**
 * The header, which exists mainly to have somewhere to grab.
 *
 * Resizable columns need a handle, and a handle needs a row that is not data -
 * putting one on every row would mean a thousand drag targets for one boundary,
 * and a click on a row is already how it opens.
 */
function header() {
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  tr.className = "var-header";

  for (const [index, title] of ["Name", "Type", "Value"].entries()) {
    const th = document.createElement("th");
    th.textContent = title;
    // The last boundary is the edge of the pane, which the splitter already
    // owns, so only the first two columns get a grip.
    if (index < 2) {
      const grip = document.createElement("span");
      grip.className = "var-grip";
      grip.addEventListener("pointerdown", (event) =>
        startResize(event, index === 0 ? "name" : "type"),
      );
      th.append(grip);
    }
    tr.append(th);
  }

  thead.append(tr);
  return thead;
}

function startResize(event, column) {
  event.preventDefault();
  event.stopPropagation();
  const table = event.target.closest("table");
  const bounds = table.getBoundingClientRect();

  const onMove = (move) => {
    // A fraction of the table rather than a pixel delta, so the arithmetic is
    // in the same units the widths are stored in and a pane that is resized
    // afterwards keeps the proportions rather than the pixels.
    widths = resized(column, widths, (move.clientX - bounds.left) / bounds.width);
    render();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    // Written once, at the end of the drag. Persisting on every move would
    // write settings.json a hundred times for one gesture.
    setSetting(COLUMNS_KEY, widths).catch((error) =>
      log.warn("Could not save the column widths:", error),
    );
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function toggle(path) {
  const key = pathKey(path);
  if (expanded.has(key)) {
    expanded.delete(key);
    // Everything underneath goes with it. Left behind, reopening the row would
    // show the subtree as it was some executions ago, and the memory would grow
    // by every branch ever opened.
    for (const other of [...expanded]) {
      if (isUnder(JSON.parse(other), path)) {
        expanded.delete(other);
        details.delete(other);
        pages.delete(other);
      }
    }
    render();
    return;
  }

  expanded.add(key);
  render();
  if (!details.has(key)) {
    request(path, pages.get(key) ?? 0);
  }
}

/** Ask again for everything open, because the namespace has changed. */
function refreshOpenRows() {
  for (const key of expanded) {
    const path = JSON.parse(key);
    details.delete(key);
    request(path, pages.get(key) ?? 0);
  }
}

export function initVariables() {
  widths = columnWidths(getSetting(COLUMNS_KEY));

  ipc.on("vars.data", (frame) => {
    rows = frame.variables ?? [];
    // A name that has gone, or been rebound, must not show stale detail - and
    // neither must anything that was open underneath it.
    const present = new Set(rows.map((row) => row.name));
    for (const key of [...expanded]) {
      if (!present.has(JSON.parse(key)[0])) {
        expanded.delete(key);
        details.delete(key);
        pages.delete(key);
      }
    }
    refreshOpenRows();
    render();
  });

  ipc.on("vars.detail", (frame) => {
    const detail = frame.detail;
    const path = detail.path ?? [];
    const key = pathKey(path);
    // A reply for a row that has since been closed is dropped rather than
    // stored: paging and closing both happen while a request is in flight, and
    // holding the answer would reopen the row on the next render.
    if (!expanded.has(key)) {
      return;
    }
    details.set(key, detail);
    render();
  });

  // The namespace these rows describe died with the backend. Showing them until
  // the replacement's first idle would be showing variables that no longer
  // exist, in a pane whose whole job is to say what does.
  //
  // A kernel restart is the same statement about the same rows, and it was not
  // handled here. It did not show, because until the refresh was gated on
  // execute_request the replacement console's kernel_info_request went idle,
  // any idle bought an inspection, and the pane was emptied by that. Gating the
  // refresh is right - a question the console asked cannot have changed the
  // namespace - but it took an accident with it that was doing real work.
  // Measured across the gating commit: two vars.data frames after a restart
  // before it, the last one empty; none after it, and the dead kernel's rows
  // still on screen.
  //
  // Emptied here rather than re-inspected, because a restarted kernel's
  // namespace *is* empty - that is what restart means - so there is nothing to
  // ask it. The next Run refreshes as usual.
  const forget = () => {
    rows = [];
    details.clear();
    expanded.clear();
    pages.clear();
    render();
  };
  ipc.on("sidecar.restarting", forget);
  ipc.on("kernel.restarting", forget);

  render();
}
