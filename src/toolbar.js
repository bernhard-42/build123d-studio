import { window as neuWindow } from "@neutralinojs/lib";

import { newFile, openFile, saveFile } from "./editor/files.js";
import {
  focusAt,
  getCurrentFile,
  isDirty,
  onDirtyChange,
  runCell,
  runFile,
  runSelectionOrLine,
} from "./editor/monaco.js";
import * as ipc from "./ipc.js";
import { nextPreference, onThemeChange, setThemePreference, themePreference } from "./theme.js";
import { showInfo } from "./info.js";
import { showSettings } from "./settings.js";
import * as log from "./log.js";

// Toolbar wiring and the kernel state indicator.

function setKernelState(state) {
  const container = document.getElementById("kernel-status");
  const label = document.getElementById("kernel-label");
  container.classList.remove("idle", "busy", "dead");
  container.classList.add(state);
  label.textContent = state;
}

async function withErrorReporting(what, action) {
  try {
    await action();
  } catch (error) {
    log.error(`${what} failed:`, error);
  }
}

/**
 * Reflect the open file, and whether it is saved, in the window title.
 *
 * The bullet is the only place the application says a buffer differs from
 * disk. Without it a failed save left nothing on screen once the error dialog
 * was dismissed - the same window, the same everything, as a save that had
 * worked. That is the defect R2 is about, and it survived the first round of it
 * because the fix stopped at reporting the failure and never asked what the
 * window looked like afterwards.
 *
 * A bullet rather than an asterisk or the word "modified": it is what an editor
 * user reads without being told, it needs no translation, and it does not look
 * like part of a filename the way a trailing * can.
 */
export async function updateTitle() {
  const file = getCurrentFile();
  const marker = isDirty() ? " •" : "";
  const name = file === null ? "build123d Studio" : `build123d Studio — ${file}`;
  await neuWindow.setTitle(`${name}${marker}`);
}

export function initToolbar() {
  // The title has to follow the buffer, not only the explicit actions below: a
  // keystroke makes it dirty and a successful save makes it clean again, and
  // neither goes through a button. Fired on the transition rather than on every
  // change - see onDirtyChange - and its failure is logged rather than left as
  // an unhandled rejection, because a title is not worth breaking typing over.
  onDirtyChange(() => {
    updateTitle().catch((error) => log.warn("Could not update the window title:", error));
  });

  const actions = {
    "btn-new": () => withErrorReporting("New", async () => {
      if (await newFile()) {
        await updateTitle();
        // An empty buffer with no caret in it is not obviously ready to type in.
        focusAt(null);
      }
    }),
    "btn-open": () => withErrorReporting("Open", async () => {
      if ((await openFile()) !== null) {
        await updateTitle();
        // The open dialog took focus; give it back rather than leave the
        // freshly loaded file with no caret in it.
        focusAt(null);
      }
    }),
    "btn-save": () => withErrorReporting("Save", async () => {
      await saveFile();
      await updateTitle();
    }),
    "btn-run-file": runFile,
    "btn-run-cell": () => runCell(),
    "btn-run-sel": () => runSelectionOrLine(),
    // Wrapped like the rest: with the sidecar gone these throw out of a click
    // handler, where only the global rejection logger would ever see it.
    "btn-interrupt": () =>
      withErrorReporting("Interrupt", async () => ipc.send("kernel.interrupt")),
    "btn-restart": () => withErrorReporting("Restart", async () => ipc.send("kernel.restart")),
    "btn-theme": () => setThemePreference(nextPreference()),
    "btn-info": showInfo,
    "btn-settings": showSettings,
  };

  for (const [id, action] of Object.entries(actions)) {
    document.getElementById(id).addEventListener("click", action);
  }

  // The icon shows what you would get, and the tooltip names the preference -
  // "system" is otherwise indistinguishable from whichever theme it resolved to.
  onThemeChange((theme) => {
    const icon = document.getElementById("icon-theme");
    icon.className = `icon icon-theme-${theme === "light" ? "light" : "dark"}`;
    document.getElementById("btn-theme").title = `Theme: ${themePreference()}`;
  });

  ipc.on("kernel.status", (frame) => {
    setKernelState(frame.state === "busy" ? "busy" : "idle");
  });
  ipc.on("sidecar.disconnected", () => setKernelState("dead"));
  // The kernel dying without the sidecar is the case that used to leave this
  // reading "busy" for the rest of the session, because nothing was watching
  // the process and a dead ZMQ peer says nothing.
  ipc.on("kernel.died", () => setKernelState("dead"));
  ipc.on("sidecar.exit", () => setKernelState("dead"));
  ipc.on("kernel.restarting", () => setKernelState("busy"));
  ipc.on("kernel.restarted", () => setKernelState("idle"));
  // The replacement reports its own state once its kernel is up; until then
  // this is neither dead nor idle.
  ipc.on("sidecar.restarting", () => setKernelState("busy"));
  ipc.on("kernel.restart_failed", () => setKernelState("dead"));

  // Ctrl/Cmd+N, +O and +S have to work from anywhere, not only when Monaco
  // has focus - the console pane takes most of the typing in practice.
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    // Exactly Cmd/Ctrl, nothing else held. Testing event.key alone meant
    // Cmd+Shift+N and Cmd+Alt+S triggered New and Save - shortcuts the user
    // was reaching for in another application, or on the way to something else
    // entirely.
    if (event.shiftKey || event.altKey) {
      return;
    }
    if (event.key === "n") {
      event.preventDefault();
      actions["btn-new"]();
    } else if (event.key === "o") {
      event.preventDefault();
      actions["btn-open"]();
    } else if (event.key === "s") {
      event.preventDefault();
      actions["btn-save"]();
    }
  });
}
