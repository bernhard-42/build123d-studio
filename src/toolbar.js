import { window as neuWindow } from "@neutralinojs/lib";

import { newFile, openFile, saveFile } from "./editor/files.js";
import { focusAt, runCell, runFile, runSelectionOrLine, getCurrentFile } from "./editor/monaco.js";
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

/** Reflect the open file in the window title. Also used at startup. */
export async function updateTitle() {
  const file = getCurrentFile();
  await neuWindow.setTitle(file === null ? "build123d Studio" : `build123d Studio — ${file}`);
}

export function initToolbar() {
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
    "btn-interrupt": () => ipc.send("kernel.interrupt"),
    "btn-restart": () => ipc.send("kernel.restart"),
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
