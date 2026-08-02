// The Edit menu's commands, where the platform does not provide them.
//
// macOS does provide them: the menu items there carry the documented native
// roles, which go through the responder chain and land on whatever has focus
// without this file existing. Windows and GNU/Linux get neither roles nor menu
// accelerators, so the items are ours to answer - and answering means knowing
// which of three quite different things holds the caret. clipboard.js decides
// which; this does it.
//
// Text moves through Neutralino's clipboard API rather than the browser's.
// navigator.clipboard needs a permission prompt or a user gesture in some
// engines and returns nothing in others, and a menu click is exactly the case
// that tends not to count as a gesture. Nothing here uses document.execCommand
// either: it is deprecated, and its paste has been refused by every engine for
// years for the obvious reason.

import { clipboard } from "@neutralinojs/lib";

import { chooseTarget, isTextField, replaceRange } from "./clipboard.js";
import * as log from "./log.js";

let panes = { editor: null, console: null };

/**
 * @param {object} implementations
 * @param {{hasFocus: () => boolean, selectedText: () => string,
 *          replaceSelection: (text: string) => void}} implementations.editor
 * @param {{hasFocus: () => boolean, selectedText: () => string,
 *          send: (text: string) => void}} implementations.console
 */
export function initClipboard(implementations) {
  panes = implementations;
}

function currentTarget() {
  const active = document.activeElement;
  return chooseTarget({
    consoleFocused: panes.console?.hasFocus() === true,
    editorFocused: panes.editor?.hasFocus() === true,
    fieldFocused: isTextField(active),
  });
}

export async function copy() {
  await cutOrCopy(false);
}

export async function cut() {
  await cutOrCopy(true);
}

async function cutOrCopy(removing) {
  const target = currentTarget();
  try {
    if (target === "console") {
      // A terminal's transcript is output. Cut is copy, because there is
      // nothing there to remove, and refusing outright would only look broken.
      const text = panes.console.selectedText();
      if (text !== "") {
        await clipboard.writeText(text);
      }
      return;
    }
    if (target === "editor") {
      const text = panes.editor.selectedText();
      if (text === "") {
        return;
      }
      await clipboard.writeText(text);
      if (removing) {
        panes.editor.replaceSelection("");
      }
      return;
    }
    if (target === "field") {
      const field = document.activeElement;
      const { selectionStart: start, selectionEnd: end, value } = field;
      const text = value.slice(start, end);
      if (text === "") {
        return;
      }
      await clipboard.writeText(text);
      if (removing) {
        field.value = replaceRange(value, start, end, "");
        field.setSelectionRange(start, start);
        // Dialogs listen for input, and a value set from script does not raise
        // one by itself.
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  } catch (error) {
    log.error(`Could not ${removing ? "cut" : "copy"}:`, error);
  }
}

export async function paste() {
  const target = currentTarget();
  if (target === "none") {
    return;
  }
  try {
    const text = await clipboard.readText();
    if (typeof text !== "string" || text === "") {
      return;
    }
    if (target === "console") {
      // Straight to the pty, exactly as if it had been typed - which is what a
      // terminal paste is. The console's own line editor does the rest.
      panes.console.send(text);
      return;
    }
    if (target === "editor") {
      panes.editor.replaceSelection(text);
      return;
    }
    const field = document.activeElement;
    const { selectionStart: start, selectionEnd: end, value } = field;
    field.value = replaceRange(value, start, end, text);
    const caret = start + text.length;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (error) {
    log.error("Could not paste:", error);
  }
}
