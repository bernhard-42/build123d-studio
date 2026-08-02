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
