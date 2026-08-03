// Keeping a mouse selection inside the pane it started in.
//
// A document selection knows nothing about panes. Drag from the variable
// explorer down into the console and the browser happily selects both, because
// they are two boxes in one document and that is what a selection does. It looks
// wrong, and it is worse than it looks: a Copy then takes text from a pane the
// user never dragged across.
//
// CSS has a word for this - `user-select: contain` - and it is not implemented
// in the engine this application runs on, so the clamping is done here.
//
// Every pane is passed in, the editor and the viewer included. Leaving them out
// was the first attempt's other mistake: a pane only needs confining as an
// *origin* if it has a document selection of its own, which the editor does not
// - but it very much needs protecting as a *destination*, and a drag begun in
// the console happily ran on into Monaco and highlighted its code and its
// minimap. What is made unselectable is everything except where the drag began,
// so a pane that never starts a drag is still covered by every drag that does.

/**
 * A range covering everything inside an element, for comparing against.
 */
function contentsOf(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range;
}

/**
 * The part of the current selection that lies inside an element, as text.
 *
 * Clamped rather than rejected. Checking only where the selection *started*
 * would report the whole of a cross-pane drag - including the half in the other
 * pane - which is exactly the text that must not be copied.
 *
 * Always read through the Selection and never through Range.toString(), which
 * is the difference between three rows and one. A range's text is specified as
 * the concatenation of the text nodes it covers, so every line break between
 * one row and the next - which is layout, not text - is simply absent:
 * "# faces6# edges12# vertices8". A Selection is serialised the way the platform
 * serialises a copy, which is what Cmd-C produces and therefore what the menu's
 * Copy has to produce too.
 */
export function textWithin(element) {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }

  const bounds = contentsOf(element);
  const range = selection.getRangeAt(0);

  // No overlap at all: the selection is somewhere else entirely.
  if (range.compareBoundaryPoints(Range.END_TO_START, bounds) >= 0
    || range.compareBoundaryPoints(Range.START_TO_END, bounds) <= 0) {
    return "";
  }

  const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0;
  const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0;
  if (!startsBefore && !endsAfter) {
    // Wholly inside the pane, which is every ordinary selection now that a drag
    // cannot leave one.
    return selection.toString();
  }

  // Reaches out of the pane. The clamped part is put on the selection just long
  // enough to be read the same way, then the user's own selection is put back -
  // once, at the moment Copy is picked, rather than repeatedly during a drag,
  // which is what made the first version of confineSelection unusable.
  const original = range.cloneRange();
  const clamped = range.cloneRange();
  if (startsBefore) {
    clamped.setStart(bounds.startContainer, bounds.startOffset);
  }
  if (endsAfter) {
    clamped.setEnd(bounds.endContainer, bounds.endOffset);
  }

  selection.removeAllRanges();
  selection.addRange(clamped);
  const text = selection.toString();
  selection.removeAllRanges();
  selection.addRange(original);
  return text;
}

// The class styles.css uses to make a pane unselectable. A class rather than an
// inline style, because the rule has to apply to the pane's descendants as well
// as the pane - an inline user-select is only inherited, and Monaco declares one
// of its own on the very element a drag arrives over.
const LOCKED = "selection-locked";

/**
 * Stop a drag that began in one of these elements running into another.
 *
 * While the button is down, every pane *except* the one the drag started in is
 * made unselectable, so the engine itself declines to extend the selection into
 * them. Released on mouseup, so nothing is left in that state.
 *
 * The first attempt did this the obvious way - watch selectionchange, clamp the
 * range back to the pane - and it was a mistake worth recording. Re-applying a
 * selection from inside a selectionchange handler raises selectionchange again,
 * while the engine is still extending the selection on every mousemove, so the
 * two took turns overwriting each other: the highlight flickered, jumped panes,
 * and went on flickering after the pointer had left. Nothing about that is
 * tunable. Declaring what is selectable and letting the engine do the work has
 * no loop in it because there is no second opinion.
 *
 * @param {Element[]} elements
 */
export function confineSelection(elements) {
  const release = () => {
    for (const element of elements) {
      element.classList.remove(LOCKED);
    }
  };

  document.addEventListener("mousedown", (event) => {
    const origin = elements.find((element) => element.contains(event.target)) ?? null;
    if (origin === null) {
      release();
      return;
    }
    for (const element of elements) {
      element.classList.toggle(LOCKED, element !== origin);
    }
  });

  document.addEventListener("mouseup", release);
  // A button released outside the window never reaches mouseup here, and a pane
  // that stayed unselectable would be a far worse bug than the one being fixed.
  window.addEventListener("blur", release);
}
