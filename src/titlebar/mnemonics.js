// Which letter opens which menu, and what a keystroke does to the bar.
//
// Windows and Linux put the menu inside the window, and the keyboard reaches it
// the way it has since Windows 3: Alt shows the underlines, Alt-F opens File,
// the arrows walk it, Escape leaves. macOS has none of this - its menu is the
// system's - so nothing here runs there.
//
// Pure, and apart from the DOM, because every decision is about characters and
// indices: which letter a title claims, what a key does to a state, and where
// the highlight goes. What is left for titlebar.js is drawing it.

/**
 * The letter each label claims, and where in the label it is.
 *
 * Windows picks the first letter of a *word* before it picks any letter at all:
 * `New` takes N, `Open File…` takes O, and `Open Folder…` - whose O is gone -
 * takes the F of Folder rather than the p of Open. Falling straight through to
 * "next free character" would give `O(p)en Folder`, which is what nobody's
 * fingers expect. So each label is asked for its word initials first, in order,
 * and only then for its remaining letters.
 *
 * First-come-first-served over the labels in order, which is what makes the
 * assignment stable: an item added later cannot take a letter from one that was
 * already there and silently retrain everybody.
 *
 * A label with nothing free left has no mnemonic. That is better than inventing
 * one nobody can guess, and the mouse still works.
 *
 * @param {string[]} labels the labels, in the order they are shown
 * @returns {{letter: string|null, at: number}[]} one per label, `at` is the
 *   index into the label, or -1 where there is none
 */
export function assignMnemonics(labels) {
  const taken = new Set();
  return labels.map((label) => {
    for (const at of candidateOrder(label)) {
      const letter = label[at].toLowerCase();
      if (!taken.has(letter)) {
        taken.add(letter);
        return { letter, at };
      }
    }
    return { letter: null, at: -1 };
  });
}

/**
 * Where to look in a label for a mnemonic, best first.
 *
 * Word initials in order, then every other usable character in order. A
 * character is usable if it is a letter or a digit; an ellipsis, an ampersand
 * or a space never claims anything.
 */
function candidateOrder(label) {
  const usable = (at) => /[a-z0-9]/i.test(label[at]);
  const initials = [];
  const rest = [];
  for (let at = 0; at < label.length; at += 1) {
    if (!usable(at)) {
      continue;
    }
    const startsWord = at === 0 || !/[a-z0-9]/i.test(label[at - 1]);
    (startsWord ? initials : rest).push(at);
  }
  return [...initials, ...rest];
}

/**
 * Which label a letter claims, or -1.
 *
 * Compared case-insensitively, because Alt-F and Alt-Shift-F are the same
 * request as far as anybody pressing them is concerned.
 */
export function menuForLetter(mnemonics, letter) {
  const wanted = String(letter ?? "").toLowerCase();
  return mnemonics.findIndex((mnemonic) => mnemonic.letter === wanted);
}

/**
 * A title split around its mnemonic, for drawing the underline.
 *
 * Returned as three pieces rather than as marked-up text: the caller puts them
 * in elements, so nothing here has to know about HTML or about escaping.
 */
export function splitTitle(title, mnemonic) {
  if (mnemonic === null || mnemonic === undefined || mnemonic.at < 0) {
    return { before: title, letter: "", after: "" };
  }
  return {
    before: title.slice(0, mnemonic.at),
    letter: title[mnemonic.at],
    after: title.slice(mnemonic.at + 1),
  };
}

/**
 * What a key does to the bar.
 *
 * The state is `{ open, highlighted, showUnderlines }`: which menu is open (-1
 * for none), which of its items is highlighted (-1 for none), and whether the
 * mnemonic underlines are showing. Answers null where the key means nothing
 * here, which the caller reads as "leave it alone and do not consume it" - an
 * arrow key with no menu open belongs to the editor.
 *
 * The answer carries `choose` as well as a state, because a letter can *do*
 * something rather than only move: in an open menu, an item's own letter runs
 * it. -1 means nothing was chosen.
 *
 * Three ways a letter is read, in this order:
 *
 * - with a menu open, an item of that menu that claims it - and it runs
 * - with a menu open, a *menu* that claims it - and the bar moves there, so
 *   Alt-F then E is File then Edit
 * - with nothing open but the underlines showing, a menu that claims it - which
 *   is Alt, then F, as two keystrokes rather than one chord
 *
 * `counts` is how many *selectable* items each menu has; separators are not
 * among them, so Down never lands on a line. `items` is the mnemonics of the
 * open menu's selectable items, in the same order.
 *
 * @returns {{open: number, highlighted: number, showUnderlines: boolean,
 *            choose: number}|null}
 */
export function afterKey(state, key, { menus, counts, mnemonics, items = [] }) {
  const { open, highlighted, showUnderlines } = state;
  const closed = { open: -1, highlighted: -1, showUnderlines: false, choose: -1 };
  const stay = (next) => ({ choose: -1, ...next });

  if (key === "Escape") {
    return open < 0 && !showUnderlines ? null : closed;
  }

  const letter = typeof key === "string" && key.length === 1 ? key : null;

  if (open < 0) {
    // Alt has been pressed and released: the bar is listening, and a letter now
    // opens its menu. Without this, Alt-then-F would show the underlines and
    // then do nothing with the letter they invite.

    if (letter !== null && showUnderlines) {
      const wanted = menuForLetter(mnemonics, letter);
      return wanted < 0 ? null : stay({ open: wanted, highlighted: -1, showUnderlines: true });
    }
    return null;
  }

  if (key === "ArrowRight") {
    return stay({ open: (open + 1) % menus, highlighted: -1, showUnderlines: true });
  }
  if (key === "ArrowLeft") {
    return stay({ open: (open + menus - 1) % menus, highlighted: -1, showUnderlines: true });
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    const count = counts[open] ?? 0;
    if (count === 0) {
      return null;
    }
    const step = key === "ArrowDown" ? 1 : -1;
    // From nothing highlighted, Down takes the first and Up the last, which is
    // what every menu on both platforms does.
    const from = highlighted < 0 ? (step === 1 ? -1 : 0) : highlighted;
    return stay({ ...state, highlighted: (from + step + count) % count });
  }

  if (letter !== null) {
    const item = menuForLetter(items, letter);
    if (item >= 0) {
      return { ...closed, choose: item };
    }
    const wanted = menuForLetter(mnemonics, letter);
    if (wanted >= 0) {
      return stay({ open: wanted, highlighted: -1, showUnderlines: true });
    }
  }
  return null;
}
