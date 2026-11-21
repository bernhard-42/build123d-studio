// Remember the window's size and place across restarts *and* across installs.
//
// The geometry lives in settings.json, in the per-user directory, with
// everything else this application remembers. Neutralino's own memory of it -
// useSavedState, a .tmp/window_state.config.json in its data directory - is
// switched off in neutralino.config.json: it duplicates this one, and on Intel
// Macs its save at quit crashes the process (see frameFromPage).
//
// What counts as a usable stored geometry is decided in geometry.js, which has
// no Neutralino in it and is tested.

import { window as neuWindow } from "@neutralinojs/lib";

import { geometryToStore, usableGeometry } from "./geometry.js";
import { getSetting, setSetting } from "./store.js";
import * as log from "./log.js";

const STORAGE_KEY = "window";

// Long enough that dragging a corner writes once rather than sixty times, short
// enough that a crash mid-session still leaves the geometry roughly right.
const SAVE_DELAY = 400;

let saveTimer = null;

/**
 * Put the window back where it was, before it is shown.
 *
 * Before, deliberately: setting the size of a visible window makes it appear at
 * the default and jump, which looks like a bug even though the end state is
 * right. The window is created hidden - modes.window.hidden - and main.js shows
 * it once the shell is ready, so there is a window to size and nobody watching.
 */
export async function restoreWindow() {
  const stored = getSetting(STORAGE_KEY, null);
  if (stored === null) {
    return;
  }

  const geometry = usableGeometry(stored);
  if (geometry === null) {
    return;
  }

  try {
    // Not on Intel Macs: the client library's setSize asks getSize for the
    // current options first and merges them in, and that query is the one that
    // crashes there (see frameFromPage). The window keeps the config's size
    // and still comes back at its place, maximized if it was.
    if (frameFromPage() === false) {
      await neuWindow.setSize({ width: geometry.width, height: geometry.height });
    }
    if (geometry.x !== undefined && geometry.y !== undefined) {
      await neuWindow.move(geometry.x, geometry.y);
    }
    if (stored.maximized === true) {
      await neuWindow.maximize();
    }
  } catch (error) {
    log.warn("Could not restore the window geometry:", error);
  }
}

/**
 * Whether the window's frame has to be read from the page instead of Neutralino.
 *
 * True on Intel Macs, where Neutralino cannot report it - and so cannot set the
 * size either, since the client library's setSize begins with a getSize. Its
 * getSize and getPosition receive the window's frame, a CGRect, through plain
 * objc_msgSend. On x86_64 a struct that large comes back only through
 * objc_msgSend_stret, so objc_msgSend takes the address of the result buffer
 * for the window and the process dies with a segmentation fault - no promise
 * rejects, nothing can catch it. Measured with Neutralino 6.9.0's mac_x64
 * binary under Rosetta; 6.10.0 has the same code. Apple Silicon builds are
 * unaffected, since arm64 has no _stret variant.
 *
 * NL_ARCH is the binary's architecture, not the machine's: the Intel build
 * reports "x64" under Rosetta too, which is the case that matters here.
 */
function frameFromPage() {
  return typeof NL_OS === "string" && NL_OS === "Darwin"
    && typeof NL_ARCH === "string" && NL_ARCH === "x64";
}

/**
 * The window's outer size and its top-left corner, in screen coordinates.
 *
 * On Intel Macs the page answers: WebKit derives outerWidth, outerHeight,
 * screenX and screenY from the frame of the window hosting the web view, the
 * frame Neutralino reads elsewhere.
 */
async function readFrame() {
  if (frameFromPage()) {
    return {
      size: { width: globalThis.outerWidth, height: globalThis.outerHeight },
      position: { x: globalThis.screenX, y: globalThis.screenY },
    };
  }
  const [size, position] = await Promise.all([
    neuWindow.getSize(),
    neuWindow.getPosition().catch(() => null),
  ]);
  return { size, position };
}

/**
 * Write down where the window is now.
 *
 * Reads all three facts before storing any of them, so a half-answered query
 * cannot overwrite a good geometry with part of a new one - geometryToStore
 * returns null rather than something incomplete.
 */
export async function saveWindow() {
  try {
    const [{ size, position }, maximized] = await Promise.all([
      readFrame(),
      neuWindow.isMaximized().catch(() => false),
    ]);
    const stored = geometryToStore({ size, position, maximized });
    if (stored === null) {
      return;
    }
    await setSetting(STORAGE_KEY, stored);
  } catch (error) {
    log.warn("Could not remember the window geometry:", error);
  }
}

/**
 * Save shortly after the window stops changing.
 *
 * The browser's own resize event is the only signal available - Neutralino
 * publishes nothing for a move - so a drag that only moves the window is caught
 * at quit rather than here. That is why shutdown saves too.
 */
export function watchWindow() {
  globalThis.addEventListener("resize", () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveWindow();
    }, SAVE_DELAY);
  });
}
