/**
 * Dismissing a dialog by clicking the backdrop, without eating a text selection.
 *
 * The obvious implementation is one click handler asking whether the event's
 * target is the overlay, and it is wrong in a way that only shows up with the
 * mouse held down. A DOM click fires on the nearest common ancestor of where the
 * button went down and where it came up - so selecting text in a field by
 * dragging, and releasing past the edge of the panel, reports the *overlay* as
 * the click target. The dialog closed mid-selection and took the edit with it.
 *
 * The press and the release therefore have to be judged separately, which the
 * click event cannot do on its own: its target is already the ancestor of both.
 * mousedown and mouseup each report where they actually happened.
 *
 * No import here and nothing runs at load, so the predicate is testable under
 * `node --test` even though the wiring beside it needs a document.
 */

/**
 * Whether a completed click should dismiss the dialog.
 *
 * Both ends on the backdrop, so every drag that starts or finishes on the panel
 * is left alone - including the one that made this necessary, and its mirror
 * image, pressing on the backdrop and releasing inside the panel.
 */
export function dismisses({ pressedOnBackdrop, releasedOnBackdrop }) {
  return pressedOnBackdrop === true && releasedOnBackdrop === true;
}

/**
 * Close `overlay` when its backdrop - and only its backdrop - is clicked.
 *
 * Both flags are reset on the way down rather than only assigned, because a
 * release outside the overlay never reaches its mouseup listener at all, and a
 * stale true from the previous interaction would then decide the next one.
 */
export function closeOnBackdropClick(overlay, close) {
  let pressedOnBackdrop = false;
  let releasedOnBackdrop = false;

  overlay.addEventListener("mousedown", (event) => {
    pressedOnBackdrop = event.target === overlay;
    releasedOnBackdrop = false;
  });
  overlay.addEventListener("mouseup", (event) => {
    releasedOnBackdrop = event.target === overlay;
  });
  overlay.addEventListener("click", () => {
    if (dismisses({ pressedOnBackdrop, releasedOnBackdrop })) {
      close();
    }
  });
}
