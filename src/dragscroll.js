// Drag a row of buttons sideways with the mouse.
//
// The toolbar scrolls when the window is too narrow for it and draws no
// scrollbar - see .toolbar in styles.css for why. What that leaves is the
// wheel, and a horizontal wheel gesture is Shift-wheel on a mouse, which is not
// something anybody guesses. Dragging is what people try first, and a browser
// does not do it: press-and-drag scrolls a container on touch and does nothing
// at all with a mouse.
//
// So it is done here, and the whole difficulty is that the thing being dragged
// is covered in buttons. A press that turns into a drag must not also press the
// button it started on, and a press that stays still must behave exactly as it
// always did.

/** How far the pointer must travel before a press becomes a drag, in pixels. */
export const DRAG_THRESHOLD = 4;

/**
 * Let a scrollable element be dragged sideways.
 *
 * @param element the scroll container
 * @returns {() => void} stops listening
 */
export function enableDragScroll(element) {
  let startX = 0;
  let startScroll = 0;
  let pointer = null;
  let dragging = false;

  const onPointerDown = (event) => {
    // Left button only. The middle button is paste on X11 and autoscroll on
    // Windows, and the right one belongs to the context menu.
    if (event.button !== 0 || element.scrollWidth <= element.clientWidth) {
      return;
    }
    pointer = event.pointerId;
    startX = event.clientX;
    startScroll = element.scrollLeft;
    dragging = false;
  };

  const onPointerMove = (event) => {
    if (pointer === null || event.pointerId !== pointer) {
      return;
    }
    const moved = event.clientX - startX;
    if (!dragging) {
      if (Math.abs(moved) < DRAG_THRESHOLD) {
        return;
      }
      dragging = true;
      // Taken only once the press has become a drag, so an ordinary click is
      // never captured away from the button under it.
      element.setPointerCapture(pointer);
      element.classList.add("dragging");
    }
    element.scrollLeft = startScroll - moved;
    // Otherwise the pointer selects the labels and icons on the way past.
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (pointer === null || event.pointerId !== pointer) {
      return;
    }
    if (dragging) {
      element.releasePointerCapture(pointer);
      element.classList.remove("dragging");
      // The click that follows this pointerup belongs to the drag, not to the
      // button the finger happened to stop on. Swallowed in the capture phase
      // so the button's own listener never sees it.
      element.addEventListener("click", swallow, { capture: true, once: true });
    }
    pointer = null;
    dragging = false;
  };

  const swallow = (event) => {
    event.stopPropagation();
    event.preventDefault();
  };

  const onPointerCancel = () => {
    if (pointer !== null && dragging) {
      element.classList.remove("dragging");
    }
    pointer = null;
    dragging = false;
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerCancel);

  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onPointerCancel);
  };
}
