import * as ipc from "../ipc.js";
import * as log from "../log.js";

// The variable explorer.
//
// Rows are pushed by the sidecar whenever the kernel goes idle, so the pane is
// current after a Run or after typing in the console, without polling. Nothing
// here asks the kernel for anything until a row is expanded: listing is cheap
// on purpose, and geometry - volume, area, face counts - is real work in OCCT.

const expanded = new Set();
const details = new Map();

let rows = [];

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

function detailRowsFor(name) {
  const detail = details.get(name);
  const row = (...cells) => {
    const tr = document.createElement("tr");
    tr.className = "var-detail";
    for (const c of cells) {
      tr.append(c);
    }
    return tr;
  };

  if (detail === undefined) {
    return [row(cell("var-loading", "loading…", { colSpan: 3 }))];
  }
  if (detail.error) {
    return [row(cell("var-error", detail.error, { colSpan: 3 }))];
  }

  const entries = [];
  for (const [key, value] of Object.entries(detail.attributes ?? {})) {
    entries.push([key, Array.isArray(value) ? value.join(", ") : String(value)]);
  }
  for (const child of detail.children ?? []) {
    entries.push([child.name, `${child.repr}`]);
  }
  if (entries.length === 0) {
    entries.push(["", "no further detail"]);
  }

  return entries.map(([key, value]) =>
    row(cell("var-detail-key", key), cell("var-detail-value", value, { colSpan: 2 })),
  );
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
  const tbody = document.createElement("tbody");

  for (const row of rows) {
    const isOpen = expanded.has(row.name);

    const head = document.createElement("tr");
    head.className = "var-row";
    head.dataset.name = row.name;
    head.append(cell("var-name", `${isOpen ? "▾" : "▸"} ${row.name}`));

    const type = cell("var-type", row.type);
    if (row.size !== null && row.size !== undefined && row.size !== "") {
      const size = document.createElement("span");
      size.className = "var-size";
      size.textContent = `[${formatSize(row.size)}]`;
      type.append(" ", size);
    }
    head.append(type, cell("var-repr", row.repr));
    head.addEventListener("click", () => toggle(row.name));
    tbody.append(head);

    if (isOpen) {
      tbody.append(...detailRowsFor(row.name));
    }
  }

  table.append(tbody);
  pane.append(table);
}

function toggle(name) {
  if (expanded.has(name)) {
    expanded.delete(name);
    render();
    return;
  }

  expanded.add(name);
  render();

  if (!details.has(name)) {
    try {
      ipc.send("vars.detail", { name });
    } catch (error) {
      log.warn("Could not request variable detail:", error);
    }
  }
}

export function initVariables() {
  ipc.on("vars.data", (frame) => {
    rows = frame.variables ?? [];
    // A name that has gone, or been rebound, must not show stale detail.
    const present = new Set(rows.map((row) => row.name));
    for (const name of [...details.keys()]) {
      if (!present.has(name)) {
        details.delete(name);
        expanded.delete(name);
      }
    }
    for (const name of expanded) {
      details.delete(name);
      try {
        ipc.send("vars.detail", { name });
      } catch {
        // Sidecar gone; the next refresh will catch up.
      }
    }
    render();
  });

  ipc.on("vars.detail", (frame) => {
    details.set(frame.detail.name, frame.detail);
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
    render();
  };
  ipc.on("sidecar.restarting", forget);
  ipc.on("kernel.restarting", forget);

  render();
}
