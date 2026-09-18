// A drawn scrollbar for a row that scrolls sideways: the toolbar and the tab
// strip.
//
// Drawn rather than native, which is what VS Code does for the same rows and
// why theirs looks the same everywhere. A thin native bar is honoured by
// WebKit on macOS and by nothing else: the GTK build and WebView2 draw their
// own bar across the bottom of the row and cover half of every button
// (measured; see the toolbar's note in styles.css). So the native one is
// hidden on both rows and a 3px thumb is positioned here from scrollLeft,
// scrollWidth and clientWidth - numbers every engine agrees on.
//
// Shown only while the row overflows, and it is a control as well as a hint:
// it drags. The wheel and the trackpad still scroll the row itself.

/**
 * Give `scroller` a thumb, drawn in `host`.
 *
 * `host` is a positioned ancestor - the thumb is absolute in it, laid along
 * the scroller's bottom edge - and it is not the scroller itself, whose
 * content moves under the thumb.
 *
 * @param {HTMLElement} scroller the element with overflow-x
 * @param {HTMLElement} host where the thumb is drawn
 * @returns {() => void} redraw, for a caller that changed the row
 */
export function attachScrollThumb(scroller, host) {
  const thumb = document.createElement("div");
  thumb.className = "scroll-thumb";
  thumb.hidden = true;
  host.appendChild(thumb);

  function geometry() {
    const overflow = scroller.scrollWidth - scroller.clientWidth;
    const track = scroller.clientWidth;
    // Never narrower than a fingertip, whatever the ratio says.
    const width = Math.max(24, Math.min(track, track * (track / scroller.scrollWidth)));
    return { overflow, track, width, travel: track - width };
  }

  function update() {
    const { overflow, width, travel } = geometry();
    if (overflow <= 0) {
      thumb.hidden = true;
      return;
    }
    thumb.hidden = false;
    thumb.style.left = `${scroller.offsetLeft + (scroller.scrollLeft / overflow) * travel}px`;
    thumb.style.width = `${width}px`;
  }

  scroller.addEventListener("scroll", update);
  // Both: the row changes width with the window, and its content with what
  // is in it - tabs opened, buttons shown.
  new ResizeObserver(update).observe(scroller);
  new MutationObserver(update).observe(scroller, { childList: true, subtree: true, attributes: true });

  // Dragging the thumb scrolls the row, proportionally.
  thumb.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = scroller.scrollLeft;
    const { overflow, travel } = geometry();
    thumb.setPointerCapture(event.pointerId);
    thumb.classList.add("dragging");
    const move = (moving) => {
      if (travel > 0) {
        scroller.scrollLeft = startLeft + ((moving.clientX - startX) / travel) * overflow;
      }
    };
    const stop = () => {
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", stop);
      thumb.removeEventListener("pointercancel", stop);
      thumb.classList.remove("dragging");
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", stop);
    thumb.addEventListener("pointercancel", stop);
  });

  update();
  return update;
}
