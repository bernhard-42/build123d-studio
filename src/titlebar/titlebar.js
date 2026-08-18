// The menu bar, on the platforms that have no system one.
//
// macOS is untouched and must stay so: its menu belongs to the system, and the
// roles - Cut, Copy, Paste - only work as native items. Everything here is
// behind `NL_OS !== "Darwin"` and the bar's element stays hidden there.
//
// Windows and Linux keep their window frame, so its buttons, its dragging, its
// title, its rounding and its shadow are all the system's. What they have no
// system place for is the menu, and that is what this strip carries - with the
// keyboard route people have there: Alt shows the underlines, Alt-F opens File,
// the arrows walk it, an item's own letter runs it.
//
// The menu is the *same structure* the native menu is built from - menu.js
// decides the shape once - so an item added there appears here without being
// written twice. The dropdowns are drawn with the context menu's classes, so a
// menu opened from this bar and one opened by right-clicking a pane look alike;
// the behaviour is not shared, because a menu bar answers to the arrows and to
// Alt and a context menu does not.

import { afterKey, assignMnemonics, menuForLetter, splitTitle } from "./mnemonics.js";

// What the bar is showing and where the keyboard is in it. -1 is "no menu open"
// and "nothing highlighted"; see afterKey, which owns every transition.
let state = { open: -1, highlighted: -1, showUnderlines: false };
let menus = [];
let mnemonics = [];
let onPick = () => {};

// The mousedown the bar has already acted on.
//
// Drawing the bar replaces its buttons, so by the time an event that started on
// one of them reaches the document it is a *detached* node - and "was this click
// inside the bar?", asked of the target, answers no. The menu would then be shut
// by the same press that opened it. Comparing the event itself is what survives
// the element going away underneath it.
let handled = null;

/** Whether this platform needs a menu bar of ours. macOS never does. */
export function usesOwnTitleBar(platform) {
  return platform !== "Darwin";
}

/** The items of a menu that can be highlighted - separators cannot. */
function selectable(menu) {
  return (menu.menuItems ?? []).filter((entry) => entry.text !== "-");
}

/** The letters this menu's items claim, in their order. */
function itemMnemonics(menu) {
  return assignMnemonics(selectable(menu).map((entry) => entry.text ?? ""));
}

function bar() {
  return document.getElementById("titlebar");
}

/** Draw the bar for the menu structure it was last given. */
function render() {
  const element = bar();
  if (element === null) {
    return;
  }
  const titles = element.querySelector("#titlebar-menus");
  titles.replaceChildren(...menus.map((menu, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `titlebar-menu${index === state.open ? " open" : ""}`;
    button.dataset.menu = String(index);
    const { before, letter, after } = splitTitle(menu.text, mnemonics[index]);
    button.append(before);
    if (letter !== "") {
      const marked = document.createElement("span");
      marked.className = state.showUnderlines ? "titlebar-mnemonic" : "";
      marked.textContent = letter;
      button.append(marked);
    }
    button.append(after);
    return button;
  }));
  renderDropdown();
}

/** The open menu's items, under its button. */
function renderDropdown() {
  const element = bar();
  const holder = element.querySelector("#titlebar-dropdown");
  holder.replaceChildren();
  if (state.open < 0) {
    holder.hidden = true;
    return;
  }
  const menu = menus[state.open];
  const button = element.querySelector(`.titlebar-menu[data-menu="${state.open}"]`);
  holder.hidden = false;
  holder.style.left = `${button === null ? 0 : button.offsetLeft}px`;

  // Drawn with the context menu's own classes so the two look alike; see the
  // module comment.
  const list = document.createElement("div");
  list.className = "context-menu";
  list.setAttribute("role", "menu");
  const letters = itemMnemonics(menu);
  let index = -1;
  for (const entry of menu.menuItems ?? []) {
    if (entry.text === "-") {
      const line = document.createElement("div");
      line.className = "context-menu-separator";
      list.appendChild(line);
      continue;
    }
    index += 1;
    const item = document.createElement("button");
    item.type = "button";
    item.className = `context-menu-item${index === state.highlighted ? " highlighted" : ""}`;
    item.disabled = entry.isDisabled === true;
    item.dataset.id = entry.id ?? "";
    item.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    const { before, letter, after } = splitTitle(entry.text ?? "", letters[index]);
    label.append(before);
    if (letter !== "") {
      const marked = document.createElement("span");
      marked.className = state.showUnderlines ? "titlebar-mnemonic" : "";
      marked.textContent = letter;
      label.append(marked);
    }
    label.append(after);
    item.appendChild(label);
    if (typeof entry.shortcut === "string" && entry.shortcut !== "") {
      const shortcut = document.createElement("span");
      shortcut.className = "context-menu-shortcut";
      shortcut.textContent = entry.shortcut;
      item.appendChild(shortcut);
    }
    list.appendChild(item);
  }
  holder.appendChild(list);
}

function setState(next) {
  state = next;
  render();
}

/** Close whatever is open, and stop showing the underlines. */
export function closeMenus() {
  if (state.open < 0 && !state.showUnderlines) {
    return;
  }
  setState({ open: -1, highlighted: -1, showUnderlines: false });
}

function shape() {
  return {
    menus: menus.length,
    counts: menus.map((menu) => selectable(menu).length),
    mnemonics,
    // Only the open menu's: a letter acts on what is in front of the user, and
    // nothing else has items to act on.
    items: state.open < 0 ? [] : itemMnemonics(menus[state.open]),
  };
}

function chooseHighlighted() {
  const menu = menus[state.open];
  const entry = selectable(menu)[state.highlighted];
  closeMenus();
  if (entry !== undefined && entry.isDisabled !== true && entry.id !== undefined) {
    onPick(entry.id);
  }
}

/**
 * The keyboard, for the whole window.
 *
 * Returns whether the key was consumed, so the caller can leave everything else
 * to the editor: a bar that swallowed keys it had no use for would be a bar that
 * broke typing.
 */
export function handleKey(event) {
  if (menus.length === 0) {
    return false;
  }

  // Alt on its own shows the underlines and moves into the bar, which is what
  // Windows has always done. Handled on keyup so that Alt-F is one gesture
  // rather than "show the underlines" followed by "open File".
  if (event.type === "keyup" && event.key === "Alt" && !event.ctrlKey && !event.shiftKey) {
    if (state.open < 0 && !state.showUnderlines) {
      setState({ open: -1, highlighted: -1, showUnderlines: true });
    } else if (state.open < 0) {
      setState({ open: -1, highlighted: -1, showUnderlines: false });
    }
    return true;
  }
  if (event.type !== "keydown") {
    return false;
  }

  // Alt-letter opens a menu from anywhere, which is the gesture people have.
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
    const wanted = menuForLetter(mnemonics, event.key);
    if (wanted >= 0) {
      setState({ open: wanted, highlighted: -1, showUnderlines: true });
      return true;
    }
    return false;
  }

  if (state.open >= 0 && (event.key === "Enter" || event.key === " ")) {
    if (state.highlighted >= 0) {
      chooseHighlighted();
      return true;
    }
    return false;
  }

  const next = afterKey(state, event.key, shape());
  if (next === null) {
    return false;
  }
  // A letter that named an item runs it, which is what `choose` carries. The
  // item is read before the state changes, because closing the menu is part of
  // running it.
  const chosen = next.choose >= 0 ? selectable(menus[state.open])[next.choose] : undefined;
  setState({ open: next.open, highlighted: next.highlighted, showUnderlines: next.showUnderlines });
  if (chosen !== undefined && chosen.isDisabled !== true && chosen.id !== undefined) {
    onPick(chosen.id);
  }
  return true;
}

/**
 * Give the bar a menu structure to show.
 *
 * The same object the native menu is built from, so the two cannot drift: an
 * item added in menu.js appears in both without being written twice.
 */
export function setMenus(structure) {
  menus = structure ?? [];
  mnemonics = assignMnemonics(menus.map((menu) => menu.text ?? ""));
  render();
}

/**
 * Put the bar on screen and wire it up. Does nothing on macOS.
 *
 * @param {{platform: string, onPick: (id: string) => void}} options
 */
export async function initTitleBar({ platform, onPick: pick }) {
  if (!usesOwnTitleBar(platform)) {
    return;
  }
  onPick = pick;
  const element = bar();
  element.hidden = false;
  document.body.classList.add("has-titlebar");

  element.querySelector("#titlebar-menus").addEventListener("mousedown", (event) => {
    const button = event.target.closest(".titlebar-menu");
    if (button === null) {
      return;
    }
    event.preventDefault();
    const index = Number(button.dataset.menu);
    // A second press on the open menu shuts it, which is what every menu bar
    // does and what stops the bar feeling stuck.
    handled = event;
    // Opened with the mouse, so no underlines: they are the keyboard's
    // invitation, and showing them to somebody who is already pointing at the
    // menu is noise.
    setState(index === state.open
      ? { open: -1, highlighted: -1, showUnderlines: false }
      : { open: index, highlighted: -1, showUnderlines: false });
  });

  // Hovering across the bar with one open follows, as it does everywhere else.
  element.querySelector("#titlebar-menus").addEventListener("mouseover", (event) => {
    const button = event.target.closest(".titlebar-menu");
    if (button === null || state.open < 0) {
      return;
    }
    const index = Number(button.dataset.menu);
    if (index !== state.open) {
      setState({ ...state, open: index, highlighted: -1 });
    }
  });

  element.querySelector("#titlebar-dropdown").addEventListener("mousedown", (event) => {
    handled = event;
    const item = event.target.closest(".context-menu-item");
    if (item === null || item.disabled) {
      return;
    }
    event.preventDefault();
    const id = item.dataset.id;
    closeMenus();
    if (id !== "") {
      onPick(id);
    }
  });

  // Anywhere else in the window closes what is open.
  document.addEventListener("mousedown", (event) => {
    if (state.open >= 0 && event !== handled) {
      closeMenus();
    }
  });
  window.addEventListener("blur", closeMenus);

  render();
}

/** For the harness: what the bar is showing, without reading the DOM. */
export function titleBarState() {
  return { ...state, titles: menus.map((menu) => menu.text), mnemonics: [...mnemonics] };
}
