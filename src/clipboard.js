// Cut, Copy and Paste: the decisions, without the doing.
//
// Nothing is imported here, deliberately. Reaching Neutralino would stop the
// file loading under `node --test`, and the routing and the range arithmetic
// are exactly what is worth testing. editing.js does the rest. Same split as
// keys.js/keybindings.js and menu.js/menubar.js - and the third time this
// codebase has wanted it, so it is the shape rather than a one-off.
//
// On Windows and GNU/Linux the Edit menu's items are ours to answer, and doing
// so means knowing which of three quite different things holds the caret: a
// Monaco model, an xterm.js terminal whose transcript is output and cannot be
// edited, or an ordinary input in a dialog. Deciding which is here; acting on
// it is editing.js. macOS needs neither, because its native roles find the
// focused thing themselves.

/**
 * Replace a range of a string, which is all a text field's edit amounts to.
 *
 * Pure, and separated because the arithmetic is the part that is easy to get
 * subtly wrong - an off-by-one here eats a character on every paste.
 */
export function replaceRange(value, start, end, text) {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return value.slice(0, from) + text + value.slice(to);
}

/**
 * Which surface the clipboard command is for.
 *
 * Pure so the routing can be asserted without a DOM. Order matters: the console
 * and the editor both own a textarea, so they are asked first and the generic
 * field case is what is left over.
 */
export function chooseTarget({ consoleFocused, editorFocused, fieldFocused }) {
  if (consoleFocused) {
    return "console";
  }
  if (editorFocused) {
    return "editor";
  }
  if (fieldFocused) {
    return "field";
  }
  return "none";
}

/**
 * What a pane's right-click menu offers.
 *
 * The editor is absent because Monaco brings its own menu, which knows about
 * more than the clipboard. These two panes have no menu of their own: the
 * console is a terminal whose transcript is output, and the variable explorer is
 * read-only HTML - so Copy is the whole of it, plus a Paste for the console
 * because a terminal is the one of the two that takes typing.
 *
 * Disabled rather than absent when there is nothing selected, which is what
 * every other application does: an item that vanishes teaches nobody that it
 * exists, and the menu jumping between one row and two is worse than a grey one.
 */
export function contextMenuItems({ pane, hasSelection, platform }) {
  const copy = { id: "copy", label: "Copy", shortcut: shortcutFor("C", platform),
    enabled: hasSelection === true };

  if (pane === "console") {
    return [
      copy,
      // Always enabled. Whether the clipboard has anything in it cannot be
      // known without reading it, and reading it to grey out a menu item would
      // be this application inspecting the clipboard every time a pane is
      // right-clicked - which is not something it should be doing.
      { id: "paste", label: "Paste", shortcut: shortcutFor("V", platform), enabled: true },
    ];
  }
  if (pane === "variables") {
    return [copy];
  }
  return [];
}

/**
 * A clipboard chord, written the way its platform writes it.
 *
 * The symbol on macOS and the word elsewhere, which is what each platform's own
 * menus do. Group 5 owns shortcut display properly - conflict detection, chord
 * capture, the whole editing dialog - and will have a general version of this;
 * two letters and a modifier did not seem worth waiting for it.
 */
function shortcutFor(letter, platform) {
  return platform === "Darwin" ? `⌘${letter}` : `Ctrl+${letter}`;
}

/** True for an element a caret can sit in. */
export function isTextField(element) {
  if (element === null || element === undefined) {
    return false;
  }
  const tag = element.tagName;
  if (tag === "TEXTAREA") {
    return true;
  }
  if (tag === "INPUT") {
    // Buttons and checkboxes have a value and no caret; only these carry text.
    return ["text", "search", "url", "email", "password", "tel", "number"]
      .includes(element.type);
  }
  return element.isContentEditable === true;
}
