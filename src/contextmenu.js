// A right-click menu for the panes that have none of their own.
//
// The editor does not use this: Monaco brings its own menu, which knows about
// running cells and about the clipboard, and two different-looking menus in one
// window would be worse than one pane having none. This is for the console and
// the variable explorer, and it is deliberately drawn to look like Monaco's -
// the same border, the same hover, the same disabled grey - because a user does
// not care which library owns which pane.
//
// It is HTML rather than the platform's own menu for the reason the webview's
// menu had to be suppressed in the first place: a native menu comes with a
// Reload item that discards the editor buffer, and nothing in Neutralino's API
// offers a native menu with items of our choosing at a point. See reload.js.
//
// The decisions - which items a pane offers, and whether each is enabled - are
// in clipboard.js, which imports nothing and is tested. This file positions a
// box and dismisses it.

import { contextMenuItems } from "./clipboard.js";

let openMenu = null;

/** Take down the menu that is showing, if any. */
export function closeContextMenu() {
  if (openMenu === null) {
    return;
  }
  openMenu.remove();
  openMenu = null;
}

// The colours Monaco resolves for its own menu, translated into ours.
//
// Naming Monaco's variables in the stylesheet was not enough: they are defined
// more than once, and what `:root` resolves to is not what the editor's menu
// actually renders with - which is how one window ended up with two menus of
// visibly different darkness. Reading the computed value off a Monaco element
// settles which definition wins, and reading it as the menu opens means a theme
// switch needs no notification.
//
// This table is the only place in the application that says "vscode", and it is
// the right place: it is the boundary where a third-party library's names are
// read, and every one of them is translated here into a build123d-studio name.
// Nothing downstream - the stylesheet included - knows where these came from.
const MENU_COLOURS = [
  ["--menu-background", "--vscode-menu-background"],
  ["--menu-foreground", "--vscode-menu-foreground"],
  ["--menu-border", "--vscode-menu-border"],
  ["--menu-hover-background", "--vscode-list-activeSelectionBackground"],
  ["--menu-hover-foreground", "--vscode-list-activeSelectionForeground"],
  ["--menu-disabled-foreground", "--vscode-disabledForeground"],
];

function matchEditorMenuColours(menu) {
  const source = document.querySelector(".monaco-editor");
  if (source === null) {
    // No editor yet. The stylesheet's fallbacks are the pane's own colours,
    // which is the right answer rather than a missing one.
    return;
  }
  const resolved = getComputedStyle(source);
  for (const [ours, theirs] of MENU_COLOURS) {
    const value = resolved.getPropertyValue(theirs).trim();
    if (value !== "") {
      menu.style.setProperty(ours, value);
    }
  }
}

/**
 * Keep the menu on screen when the click was near an edge.
 *
 * Measured after it is in the document, because until it has been laid out its
 * size is not known - a menu whose items are two words long is not the width
 * anything could have guessed.
 */
function positionWithin(menu, x, y) {
  const { width, height } = menu.getBoundingClientRect();
  const left = x + width > window.innerWidth ? Math.max(0, x - width) : x;
  const top = y + height > window.innerHeight ? Math.max(0, y - height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/**
 * Show a menu at a point.
 *
 * @param {{x: number, y: number,
 *          items: Array<{id: string, label: string, enabled: boolean}>,
 *          onPick: (id: string) => void}} options
 */
export function showContextMenu({ x, y, items, onPick }) {
  closeContextMenu();
  if (items.length === 0) {
    return;
  }

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.disabled = item.enabled !== true;
    button.setAttribute("role", "menuitem");

    const label = document.createElement("span");
    label.textContent = item.label;
    button.appendChild(label);
    if (typeof item.shortcut === "string" && item.shortcut !== "") {
      const shortcut = document.createElement("span");
      shortcut.className = "context-menu-shortcut";
      shortcut.textContent = item.shortcut;
      button.appendChild(shortcut);
    }
    // mousedown rather than click, so the menu is gone before the action runs.
    // A paste that reaches the pty while a button still has focus leaves the
    // caret in the menu rather than in the terminal.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      closeContextMenu();
      onPick(item.id);
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);
  matchEditorMenuColours(menu);
  positionWithin(menu, x, y);
  openMenu = menu;
}

// Every way out of the menu other than picking something. Registered once, on
// the document, rather than per menu: a listener added when the menu opens has
// to be removed when it closes, and the one path that is easy to miss is the
// menu being replaced by another right-click somewhere else.
document.addEventListener("mousedown", (event) => {
  if (openMenu !== null && !openMenu.contains(event.target)) {
    closeContextMenu();
  }
});
// Capture, and on the window, for the same reason the reload guard is - see
// reload.js. Escape belongs to the console: prompt_toolkit reads it, and xterm.js
// stops the key at its own textarea on the way past, so a listener on the
// document never saw it and the menu would not close over the pane it is most
// used in. Nothing is prevented or consumed here; the key still reaches the pty.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeContextMenu();
  }
}, { capture: true });
window.addEventListener("blur", closeContextMenu);
window.addEventListener("resize", closeContextMenu);

/**
 * Give a pane a right-click menu.
 *
 * @param {Element} element the pane
 * @param {string} pane which item table it gets - see clipboard.js
 * @param {string} platform NL_OS, for the way the shortcuts are written
 * @param {() => string} selectedText what a Copy would copy, read at click time
 * @param {(id: string, text: string) => void} onPick
 */
export function attachContextMenu({ element, pane, platform, selectedText, onPick }) {
  element.addEventListener("contextmenu", (event) => {
    // The webview's own menu is cancelled globally in reload.js, on the way up
    // from here. This one is ours and is shown instead.
    const text = selectedText();
    showContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: contextMenuItems({ pane, hasSelection: text !== "", platform }),
      onPick: (id) => onPick(id, text),
    });
  });
}
