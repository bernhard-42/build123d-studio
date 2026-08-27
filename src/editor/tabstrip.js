// The row of tabs above the editor.
//
// Rebuilt from the buffers rather than mutated, for the reason the menu is:
// a strip is a pure function of which buffers are open, which one is showing
// and which of them are dirty, and every bug in a mutated one is a transition
// somebody forgot. There are never many tabs, so rebuilding costs nothing worth
// measuring.
//
// The labels come from tabs.js, which has no DOM in it and is where the only
// real algorithm here lives - working out that two files called bracket.py need
// telling apart, and by how much.
//
// Overflow scrolls, which was decided rather than defaulted: a dropdown of what
// does not fit is a second place to look for a file that is already on screen
// somewhere, and the strip is horizontal anyway.

import {
  activeBufferKey,
  bufferKeys,
  bufferPath,
  isBufferDirty,
  isBufferMissing,
  onDirtyChange,
} from "./monaco.js";
import { labelsFor } from "./tabs.js";

let strip = null;
let select = null;
let close = null;

/**
 * @param {{onSelect: (key: number) => void, onClose: (key: number) => void}} handlers
 */
export function initTabStrip(handlers) {
  strip = document.getElementById("tab-strip");
  select = handlers.onSelect;
  close = handlers.onClose;

  // A tab has to show the dot the moment the buffer stops matching disk, and
  // typing does not go through any of the actions that redraw the strip.
  onDirtyChange(refreshTabs);
  refreshTabs();
}

/** Redraw the strip. Called by anything that opens, closes or switches a buffer. */
export function refreshTabs() {
  if (strip === null) {
    return;
  }
  const keys = bufferKeys();
  const active = activeBufferKey();
  const tabs = labelsFor(keys.map((key) => ({ key, path: bufferPath(key) })));

  strip.replaceChildren(...tabs.map((tab) => render(tab, tab.key === active)));
  // Hidden rather than empty when there are no tabs: an empty bar above an
  // empty editor is furniture for something that is not there.
  strip.hidden = tabs.length === 0;

  const current = strip.querySelector(".tab-active");
  if (current !== null) {
    // A tab switched from the menu or a shortcut may be scrolled out of sight.
    current.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function render(tab, isActive) {
  const element = document.createElement("div");
  // Struck through when the file has gone from disk, which is the strongest
  // version of the thing the dirty dot says: what is on screen is not what is
  // on disk, because there is no longer anything on disk. The buffer stays -
  // closing a tab because a file vanished would discard edits nobody asked to
  // lose - and saving it writes the file back and takes the mark off.
  const missing = isBufferMissing(tab.key);
  const classes = ["tab"];
  if (isActive) {
    classes.push("tab-active");
  }
  if (missing) {
    classes.push("tab-missing");
  }
  element.className = classes.join(" ");
  element.title = missing ? `${tab.title}\n\nNo longer on disk. Save to write it back.` : tab.title;
  element.setAttribute("role", "tab");
  element.setAttribute("aria-selected", isActive ? "true" : "false");

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = tab.label;
  element.appendChild(label);

  if (tab.hint !== "") {
    const hint = document.createElement("span");
    hint.className = "tab-hint";
    hint.textContent = tab.hint;
    element.appendChild(hint);
  }

  // One control that is either the unsaved dot or the close cross, not two
  // side by side: they occupy the same place in every editor that has both,
  // and a tab whose width changes when it becomes dirty makes the whole strip
  // shuffle under the pointer.
  const button = document.createElement("button");
  button.type = "button";
  button.className = isBufferDirty(tab.key) ? "tab-close tab-dirty" : "tab-close";
  button.title = "Close";
  button.setAttribute("aria-label", `Close ${tab.label}`);
  button.addEventListener("mousedown", (event) => {
    // mousedown, and stopped here: the strip's own handler below would
    // otherwise select the tab on the way past, so closing a background tab
    // would first switch to it and leave the editor somewhere unasked for.
    event.stopPropagation();
    event.preventDefault();
    close(tab.key);
  });
  element.appendChild(button);

  element.addEventListener("mousedown", (event) => {
    // Middle click closes, as it does in every browser and editor.
    if (event.button === 1) {
      event.preventDefault();
      close(tab.key);
      return;
    }
    if (event.button === 0) {
      // Prevented, and the editor focused by the handler instead. Focus is the
      // *default action* of mousedown and it runs after this returns, so on a
      // plain div it lands on nothing and takes the keyboard away from whatever
      // had it - which is why focusing the editor from here alone did not stick.
      // Nothing is lost by prevention: the strip is not selectable text, the
      // tabs are not draggable, and they hold no focusable element but the
      // close button, which stops this event before it arrives.
      event.preventDefault();
      select(tab.key);
    }
  });
  return element;
}
