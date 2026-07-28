import { getSetting, setSetting } from "../store.js";

// Three draggable boundaries: one horizontal split shared by both columns, and
// a vertical split per row so the editor/viewer ratio can differ from the
// console/variables one.
//
// Sizes are stored as fractions rather than pixels so a restored layout still
// makes sense after the window is resized or moved to another display.

const STORAGE_KEY = "layout";
const MIN_FRACTION = 0.1;
const SPLITTER_PX = 5;

const listeners = new Set();

const DEFAULTS = { rows: 0.62, columnsTop: 0.45, columnsBottom: 0.45 };

let fractions = { ...DEFAULTS };
let dragging = null;

function clamp(value) {
  return Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, value));
}

function apply() {
  const app = document.getElementById("app");
  const height = app.clientHeight - SPLITTER_PX;
  app.style.setProperty("--row-top", `${height * fractions.rows}px`);
  app.style.setProperty("--row-bottom", `${height * (1 - fractions.rows)}px`);

  for (const [row, key] of [
    ["row-top", "columnsTop"],
    ["row-bottom", "columnsBottom"],
  ]) {
    const element = document.getElementById(row);
    const width = element.clientWidth - SPLITTER_PX;
    const prefix = row === "row-top" ? "--col-top" : "--col-bottom";
    element.style.setProperty(`${prefix}-left`, `${width * fractions[key]}px`);
    element.style.setProperty(`${prefix}-right`, `${width * (1 - fractions[key])}px`);
  }
}

function notifyResize() {
  for (const listener of listeners) {
    listener();
  }
}

async function persist() {
  await setSetting(STORAGE_KEY, { ...fractions });
}

function restore() {
  const stored = getSetting(STORAGE_KEY);
  if (typeof stored !== "object" || stored === null) {
    // No stored layout yet - defaults stand.
    return;
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof stored[key] === "number") {
      fractions[key] = clamp(stored[key]);
    }
  }
}

function startDragging(target) {
  return (event) => {
    dragging = target;
    event.target.classList.add("dragging");
    document.getElementById("app").classList.add("dragging");
    event.preventDefault();
  };
}

function onPointerMove(event) {
  if (dragging === null) {
    return;
  }

  if (dragging === "rows") {
    const rect = document.getElementById("app").getBoundingClientRect();
    fractions.rows = clamp((event.clientY - rect.top) / rect.height);
  } else {
    const row = document.getElementById(dragging === "columnsTop" ? "row-top" : "row-bottom");
    const rect = row.getBoundingClientRect();
    fractions[dragging] = clamp((event.clientX - rect.left) / rect.width);
  }
  apply();
}

function onPointerUp() {
  if (dragging === null) {
    return;
  }
  dragging = null;
  document.getElementById("app").classList.remove("dragging");
  for (const element of document.querySelectorAll(".splitter")) {
    element.classList.remove("dragging");
  }
  // Monaco relayouts itself; the viewer and the terminal need to be told.
  notifyResize();
  persist();
}

/**
 * Register a callback to run whenever pane sizes change - on drag end and on
 * window resize. Monaco does not need this (automaticLayout), the CAD viewer
 * and xterm do.
 */
export function onPaneResize(listener) {
  listeners.add(listener);
}

export async function initSplitters() {
  restore();
  apply();

  const bindings = [
    ["splitter-h", "rows"],
    ["splitter-v-top", "columnsTop"],
    ["splitter-v-bottom", "columnsBottom"],
  ];
  for (const [id, target] of bindings) {
    document.getElementById(id).addEventListener("mousedown", startDragging(target));
  }

  document.addEventListener("mousemove", onPointerMove);
  document.addEventListener("mouseup", onPointerUp);

  // Dragging the row boundary changes both rows' widths in pixels even though
  // their fractions are unchanged, so re-apply and let the panes re-fit.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    apply();
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(notifyResize, 100);
  });
}
