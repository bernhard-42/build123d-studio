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

function detailRows(name) {
  const detail = details.get(name);
  if (detail === undefined) {
    return `<tr class="var-detail"><td colspan="3" class="var-loading">loading…</td></tr>`;
  }
  if (detail.error) {
    return `<tr class="var-detail"><td colspan="3" class="var-error">${escapeHtml(detail.error)}</td></tr>`;
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

  return entries
    .map(
      ([key, value]) =>
        `<tr class="var-detail"><td class="var-detail-key">${escapeHtml(key)}</td>` +
        `<td colspan="2" class="var-detail-value">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render() {
  const pane = paneElement();

  if (rows.length === 0) {
    pane.innerHTML = `<div class="var-empty">No variables yet. Run some code.</div>`;
    return;
  }

  const body = rows
    .map((row) => {
      const isOpen = expanded.has(row.name);
      const marker = isOpen ? "▾" : "▸";
      const head =
        `<tr class="var-row" data-name="${escapeHtml(row.name)}">` +
        `<td class="var-name">${marker} ${escapeHtml(row.name)}</td>` +
        `<td class="var-type">${escapeHtml(row.type)}` +
        `${row.size ? ` <span class="var-size">[${escapeHtml(formatSize(row.size))}]</span>` : ""}</td>` +
        `<td class="var-repr">${escapeHtml(row.repr)}</td></tr>`;
      return isOpen ? head + detailRows(row.name) : head;
    })
    .join("");

  pane.innerHTML = `<table class="var-table"><tbody>${body}</tbody></table>`;

  for (const element of pane.querySelectorAll(".var-row")) {
    element.addEventListener("click", () => toggle(element.dataset.name));
  }
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

  render();
}
