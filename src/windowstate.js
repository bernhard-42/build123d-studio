// Remember the window's size and place across restarts *and* across installs.
//
// Neutralino already remembers geometry, in .tmp/window_state.config.json - and
// beside its own binary, on a hardcoded path. So it survives a restart and is
// lost every time a new version is unpacked, which reads as the application
// forgetting the layout on update. It is also why packages ship an empty .tmp
// at all: the save is an uncaught create_directories, so on a read-only
// directory closing the window aborts the process.
//
// Phase 1 already decided this question for everything else - settings, the
// log, the environment all live in the per-user directory precisely so that an
// update cannot take them, and neither Neutralino's .storage nor its own log is
// used because both write into the application's own folder. The window was the
// one exception, because the mechanism was Neutralino's rather than ours. It is
// ours now.
//
// The decisions - what is a usable size, and whether a remembered position is
// still on a screen that exists - are in geometry.js, which has no Neutralino in
// it and is tested.

import { computer, window as neuWindow } from "@neutralinojs/lib";

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

  let displays = [];
  try {
    displays = await computer.getDisplays();
  } catch (error) {
    // Not fatal, and deliberately not a reason to drop the position: an empty
    // list means "unknown", and usableGeometry keeps what it was given.
    log.info("Could not read the displays; restoring the window anyway:", error?.message ?? error);
  }

  const geometry = usableGeometry(stored, displays);
  if (geometry === null) {
    return;
  }

  try {
    await neuWindow.setSize({ width: geometry.width, height: geometry.height });
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
 * Write down where the window is now.
 *
 * Reads all three facts before storing any of them, so a half-answered query
 * cannot overwrite a good geometry with part of a new one - geometryToStore
 * returns null rather than something incomplete.
 */
export async function saveWindow() {
  try {
    const [size, position, maximized] = await Promise.all([
      neuWindow.getSize(),
      neuWindow.getPosition().catch(() => null),
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
