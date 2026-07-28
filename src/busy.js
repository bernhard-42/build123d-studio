// A modal that blocks the IDE while the kernel is unavailable.
//
// Restarting takes a few seconds during which there is no kernel at all: Run
// would fail, the console is being replaced, and the variable explorer has
// nothing to inspect. Rather than let each of those fail in its own way, the
// whole window is blocked and says so.
//
// Keyboard as well as pointer input has to be blocked. An overlay stops clicks,
// but Monaco and xterm listen for keys on their own elements and would happily
// keep taking them, so the modal captures keydown at the document level while
// it is up.

let element = null;
let message = null;
let depth = 0;

function swallowKeys(event) {
  // Capture phase, before Monaco or xterm see it.
  event.preventDefault();
  event.stopPropagation();
}

/** Show the modal. Nestable: two overlapping waits need two hides. */
export function showBusy(text) {
  if (element === null) {
    element = document.getElementById("busy");
    message = document.getElementById("busy-message");
  }
  message.textContent = text;
  depth += 1;
  if (depth === 1) {
    element.hidden = false;
    document.addEventListener("keydown", swallowKeys, true);
  }
}

export function hideBusy() {
  if (element === null || depth === 0) {
    return;
  }
  depth -= 1;
  if (depth === 0) {
    element.hidden = true;
    document.removeEventListener("keydown", swallowKeys, true);
  }
}

/** Drop the modal regardless of nesting - for a failure that ends every wait. */
export function resetBusy() {
  if (element === null || depth === 0) {
    return;
  }
  depth = 0;
  element.hidden = true;
  document.removeEventListener("keydown", swallowKeys, true);
}
