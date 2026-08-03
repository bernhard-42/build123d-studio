import { app, events, init, window as neuWindow } from "@neutralinojs/lib";
import "./styles.css";
import "./icons.css";

import { ensureEnvironment } from "./bootstrap/setup.js";
import { appDir } from "./bootstrap/envroot.js";
import { acknowledge, fail, hideSplash, showSplash, splashVisible } from "./bootstrap/splash.js";
import { initSplitters } from "./layout/splitter.js";
import {
  hasFocus as consoleHasFocus,
  initConsole,
  selectedText as consoleSelectedText,
  sendText,
} from "./console/terminal.js";
import {
  bufferKeys,
  focus as focusEditor,
  hasTextFocus,
  initEditor,
  replaceSelection,
  runCell,
  runFile,
  runSelectionOrLine,
  selectedText,
} from "./editor/monaco.js";
import { copy, copyText, cut, initClipboard, paste, pasteInto } from "./editing.js";
import { attachContextMenu } from "./contextmenu.js";
import { confineSelection, textWithin } from "./selection.js";
import { MENU } from "./menu.js";
import { initMenu, refreshMenu, watchSession } from "./menubar.js";
import {
  closeActiveTab,
  closeEveryTab,
  closeFolder,
  closeTab,
  currentFolder,
  confirmDiscardAll,
  newFile,
  openFile,
  openFolder,
  openPath,
  restoreWorkspace,
  saveAll,
  saveFile,
  saveWorkspace,
  selectTab,
  syncKernelDirectory,
} from "./editor/files.js";
import { initTabStrip } from "./editor/tabstrip.js";
import { initSidebar, toggleSidebar } from "./editor/sidebar.js";
import { initViewer, showLogo } from "./viewer/viewer.js";
import { initVariables } from "./vars/explorer.js";
import { awaitKernelRestart, showSettings } from "./settings.js";
import { showInfo } from "./info.js";
import { initToolbar, updateTitle } from "./toolbar.js";
import * as ipc from "./ipc.js";
import { initTheme } from "./theme.js";
import { initStore } from "./store.js";
import { hideBusy, resetBusy, showBusy } from "./busy.js";
import * as log from "./log.js";
import { guardAgainstReload, suppressNativeContextMenu } from "./reload.js";

init();
log.installGlobalHandlers();

// Startup order matters: the Python environment has to exist before the sidecar
// can be spawned, and on first run it does not. So the window comes up showing
// the splash, setup runs, the sidecar starts, and only then is the app revealed.

let shuttingDown = false;
let asking = false;

/**
 * Offer to save before quitting. Returns false if the user cancelled.
 *
 * Cancelling genuinely aborts the quit, including from the window's close
 * button: modes.window.exitProcessOnClose is false, so Neutralino leaves the
 * window standing and reports windowClose as an event rather than acting on it.
 * Verified rather than assumed - with the handler doing nothing, the window and
 * the process both survive the click.
 */
async function shutdown() {
  if (shuttingDown || asking) {
    return;
  }
  asking = true;
  try {
    if (!(await confirmDiscardAll())) {
      log.info("Quit cancelled: unsaved changes");
      return;
    }
  } catch (error) {
    // Never trap the user in an app that will not close because the prompt
    // itself failed.
    log.error("Unsaved-changes prompt failed, quitting anyway:", error);
  } finally {
    asking = false;
  }

  shuttingDown = true;
  try {
    await saveWorkspace();
  } catch (error) {
    log.warn("Could not remember the open tabs:", error);
  }
  try {
    await ipc.stopSidecar();
  } catch (error) {
    log.warn("Sidecar shutdown:", error);
  } finally {
    await app.exit();
  }
}

events.on("windowClose", () => {
  shutdown();
});

// Cmd-Q / Ctrl-Q.
//
// There is no native menu bar yet, so macOS never wires the standard Quit
// shortcut to anything and the app simply ignores it. Handling the key in the
// webview is the only place it can be caught. Ctrl-Q is included for Linux and
// Windows, where it is the common equivalent. This goes when the menu lands and
// carries a real Quit item.
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "q") {
    event.preventDefault();
    shutdown();
  }
});

// Reload keys, which this application has no use for and a great deal to lose
// to: a reload throws away the editor buffer and everything unsaved in it. See
// reload.js - the guard cancels the browser's reaction without consuming the
// key, so Ctrl-R still reaches the console's readline and F5 still reaches Run
// File.
guardAgainstReload();

// And the context menu that carries a Reload item of its own. Same reason, a
// different route in - see reload.js.
suppressNativeContextMenu();

/**
 * Run a tab action and let the window title follow it.
 *
 * The title carries the open file and whether it is saved, so selecting or
 * closing a tab changes it - and neither goes through the toolbar buttons that
 * already update it. Nothing awaits a click, so the failure has to be caught
 * here or it becomes an unhandled rejection nobody sees.
 */
function withTitle(action) {
  Promise.resolve()
    .then(action)
    .then(() => updateTitle())
    .then(() => refreshMenu())
    .catch((error) => log.error("Tab action failed:", error));
}

/**
 * Run a folder command and rebuild the menu after it.
 *
 * Opening or closing a project is the only thing that changes which items are
 * enabled, so it is also the only thing that has to rebuild the menu - there is
 * no documented way to change one item, so the whole menu is rebuilt.
 */
async function withMenu(action) {
  try {
    await action();
  } finally {
    await refreshMenu();
    await updateTitle();
  }
}

/**
 * Offer a way back when the Python backend dies during a session.
 *
 * Wired only after the first successful start, so a failure during startup
 * keeps reporting itself on the splash - which is the right place for it,
 * because there is no working app behind it to go back to.
 *
 * Manual, with no automatic retry. Whatever killed the sidecar will very likely
 * kill its replacement, and a self-restarting backend would turn one crash into
 * a loop of them with the log filling up behind it.
 */
function installBackendRecovery(console_) {
  const banner = document.getElementById("backend-banner");
  const text = document.getElementById("backend-banner-text");
  const button = document.getElementById("backend-banner-restart");
  let restarting = false;
  // What the button does, which now depends on what died. Held here rather than
  // branched on inside the handler so that adding a third kind of death means
  // describing it rather than editing a conditional.
  let recovery = null;

  const show = (message, action) => {
    text.textContent = message;
    if (action !== undefined) {
      recovery = action;
      button.textContent = action.label;
    }
    button.disabled = false;
    banner.hidden = false;
  };

  /** The sidecar process itself is gone: everything Python-side went with it. */
  const restartBackend = {
    label: "Restart backend",
    busy: "Restarting the Python backend…",
    run: async () => {
      await ipc.restartSidecar();
      // The replacement knows nothing about this session: where the open file
      // lives, or how big the console pane is. Both are sent at startup and
      // have to be sent again.
      syncKernelDirectory();
      console_.syncSize();
      log.info("Python backend restarted");
    },
  };

  /**
   * The kernel process is gone but the sidecar is not.
   *
   * A different repair from the one above, which is why this banner had to
   * learn a second action rather than reuse the first: restarting the whole
   * backend here would throw away a console and a model socket that are
   * perfectly healthy, to fix something one restart request can fix. The
   * working directory survives, because the sidecar's Kernel object outlives
   * the process it manages.
   */
  const restartKernel = {
    label: "Restart kernel",
    busy: "Restarting the kernel…",
    run: async () => {
      await awaitKernelRestart();
      log.info("Kernel restarted after it died");
    },
  };

  ipc.on("sidecar.exit", (frame) =>
    show(`The Python backend stopped (exit code ${frame.code}).`, restartBackend),
  );
  ipc.on("sidecar.disconnected", () => show("The Python backend disconnected.", restartBackend));

  // Deliberately distinct wording. "The backend stopped" over a working console
  // and a working viewer would be a lie, and the user's next question - what
  // did I lose - has a different answer: the namespace, not the session.
  ipc.on("kernel.died", () =>
    show("The Python kernel stopped. Variables and imports are gone.", restartKernel),
  );

  button.addEventListener("click", async () => {
    if (restarting || recovery === null) {
      return;
    }
    restarting = true;
    button.disabled = true;
    showBusy(recovery.busy);
    try {
      await recovery.run();
      banner.hidden = true;
    } catch (error) {
      log.error(`${recovery.label} failed:`, error);
      show(`Could not recover: ${error?.message ?? error}`);
    } finally {
      restarting = false;
      hideBusy();
    }
  });
}

async function main() {
  // Both write into the app-data directory rather than the application's own,
  // so they only need os.getPath - no environment, nothing to bootstrap. Doing
  // them first means the rest of startup is logged and can read settings.
  await log.initLog();
  await initStore();

  log.info("Starting up", { NL_OS, NL_ARCH: typeof NL_ARCH === "string" ? NL_ARCH : "?" });
  await neuWindow.setTitle("build123d Studio");
  await neuWindow.show();

  let environment;
  try {
    environment = await ensureEnvironment();
    log.info("Environment ready", environment);
  } catch (err) {
    log.error("Environment bootstrap failed", err);
    fail("Could not prepare the Python environment.", err?.message ?? err);
    return;
  }

  // The layout has to exist before the terminal is created - xterm measures its
  // container to work out rows and columns. The panes are laid out behind the
  // splash, which is why the shell is only hidden, not absent.
  // Before any pane is created: Monaco, xterm and the viewer all read the
  // resolved theme when they are constructed.
  await initTheme();
  await initSplitters();

  initEditor();
  initTabStrip({
    onSelect: (key) => withTitle(() => selectTab(key)),
    onClose: (key) => withTitle(() => closeTab(key)),
  });
  // Clicking a file in the tree opens it exactly as Open File does, tab and
  // all - the tree is a way of finding files, not a second kind of buffer.
  initSidebar({ onOpenFile: (path) => withTitle(() => openPath(path)) });
  initViewer();
  initVariables();
  initToolbar();
  const console_ = initConsole();

  // After the editor, because every command it offers acts on one. The Edit
  // items are not listed here: on macOS they are the platform's own roles, which
  // reach whatever has focus without this file knowing which pane that is.
  // Which pane a Cut, Copy or Paste is for. Only reached where the platform has
  // no clipboard roles of its own - macOS resolves it through the responder
  // chain instead, and never calls any of this.
  initClipboard({
    editor: { hasFocus: hasTextFocus, selectedText, replaceSelection },
    console: {
      hasFocus: consoleHasFocus,
      selectedText: consoleSelectedText,
      send: sendText,
    },
  });

  // Right-click menus for the two panes that have none of their own. The editor
  // has Monaco's, which offers the Run actions as well as the clipboard; the
  // viewer has three-cad-viewer's own controls and nothing to copy.
  const consolePane = document.getElementById("pane-console");
  const varsPane = document.getElementById("pane-vars");

  // A drag that starts in one pane must not run into another - see selection.js.
  // All four, not just the two with menus: the editor and the viewer never start
  // a document selection of their own, but they are perfectly capable of being
  // dragged *into*, which highlighted Monaco's code and its minimap.
  confineSelection([
    document.getElementById("pane-editor"),
    document.getElementById("pane-viewer"),
    consolePane,
    varsPane,
  ]);

  attachContextMenu({
    element: consolePane,
    pane: "console",
    platform: NL_OS,
    selectedText: consoleSelectedText,
    onPick: (id, text) => {
      if (id === "copy") {
        copyText(text);
        return;
      }
      // Straight to the pty, exactly as if it had been typed - which is what a
      // terminal paste is. The console's own line editor does the rest.
      pasteInto(sendText);
    },
  });

  attachContextMenu({
    element: varsPane,
    pane: "variables",
    platform: NL_OS,
    // An ordinary document selection, unlike the console's: the explorer is
    // HTML, and what the user dragged across is what Copy means - clamped to
    // this pane, so a drag that reached another one copies only this part.
    selectedText: () => textWithin(varsPane),
    onPick: (id, text) => {
      if (id === "copy") {
        copyText(text);
      }
    },
  });

  // What is greyed out depends on the session rather than on what has been
  // built: Close needs a tab, Close Folder needs a project. Both are asked at
  // rebuild time, and everything that changes either rebuilds the menu.
  watchSession({
    folder: () => currentFolder() !== null,
    tabs: () => bufferKeys().length > 0,
  });

  await initMenu({
    [MENU.ABOUT]: showInfo,
    [MENU.SETTINGS]: showSettings,
    [MENU.QUIT]: shutdown,
    [MENU.CUT]: cut,
    [MENU.COPY]: copy,
    [MENU.PASTE]: paste,
    [MENU.NEW]: newFile,
    [MENU.OPEN]: openFile,
    [MENU.OPEN_FOLDER]: () => withMenu(openFolder),
    [MENU.CLOSE_FOLDER]: () => withMenu(closeFolder),
    [MENU.TOGGLE_SIDEBAR]: toggleSidebar,
    [MENU.SAVE]: () => saveFile(),
    [MENU.SAVE_AS]: () => saveFile({ saveAs: true }),
    [MENU.SAVE_ALL]: () => withMenu(saveAll),
    [MENU.CLOSE]: () => withMenu(closeActiveTab),
    [MENU.CLOSE_ALL]: () => withMenu(closeEveryTab),
    "run.cell": () => runCell(),
    "run.cell.stay": () => runCell({ advance: false }),
    "run.selectionOrLine": () => runSelectionOrLine(),
    "run.file": runFile,
  });

  // Before the splash lifts, so the window is revealed already showing the
  // files rather than the sample being replaced a moment later. Files that have
  // gone are left closed - see restoreWorkspace.
  await restoreWorkspace();
  // A restored folder enables Close Folder and Toggle Sidebar, and the menu was
  // built before the workspace was read.
  await refreshMenu();
  await updateTitle();

  ipc.on("error", (frame) => log.error("sidecar error:", frame.context, frame.message));

  // Restart feedback is wired here rather than in the toolbar, because the
  // settings dialog restarts the kernel too - after changing a package source
  // or upgrading - and both routes deserve the same modal.
  ipc.on("kernel.restarting", () => {
    if (!splashVisible()) {
      showBusy("Restarting the kernel…");
    }
  });
  ipc.on("kernel.restarted", () => hideBusy());
  ipc.on("kernel.restart_failed", async (frame) => {
    resetBusy();
    log.error("Kernel restart failed:", frame.message);
    fail("The kernel could not be restarted.", frame.message);
    showSplash();
    // And then let the user out of it. Without the acknowledgement this raised
    // a full-screen overlay with no button over an editor that was still
    // perfectly usable, and nothing else ever took it down - the buffer was
    // there, unsaved, behind a splash that could not be dismissed. A dead
    // kernel is worth reporting loudly and is not worth losing the window over;
    // the banner offers a restart once this is gone.
    await acknowledge();
    hideSplash();
  });

  // A restart started from the toolbar has no caller awaiting its outcome, so
  // if the sidecar dies while the modal is up nothing else would ever take it
  // down - leaving a window that blocks its own keyboard input. The settings
  // dialog's flows handle this themselves through awaitKernelRestart.
  for (const type of ["sidecar.exit", "sidecar.disconnected"]) {
    ipc.on(type, () => resetBusy());
  }

  // Exceptions raised by user code. The console prints its own traceback, so
  // this is only worth logging - but it has to be consumed, or every error in
  // a script produces an "unhandled sidecar frame" warning.
  ipc.on("kernel.error", (frame) => log.info(`kernel: ${frame.ename}: ${frame.evalue}`));

  // Reveal the app now, with the logo already in the viewer.
  //
  // Waiting for the sidecar here would hold the splash for several seconds:
  // the sidecar spends ~2.2 s importing OCP for the measurement backend, and
  // the kernel another ~2 s warming build123d. None of that is needed to look
  // at, scroll or edit code, so it happens behind a populated window instead of
  // a splash screen. The kernel indicator in the toolbar shows when the Run
  // actions will actually do something.
  showLogo();
  hideSplash();
  console_.syncSize();

  // The editor takes focus, at line 1 - the app opens ready to write code.
  //
  // It used to be the console, only because the console was the last thing to
  // finish starting and grabbed focus on the way past. That is startup order
  // deciding the UI, not a decision: the sidecar becomes ready seconds after
  // the window appears, so anything typed in between went to the editor and
  // then the caret jumped away mid-sentence.
  // Focus only: restoreWorkspace has already put each tab's caret back where it
  // was left, and focusAt with no state would send this one to line 1.
  focusEditor();

  try {
    const ready = await ipc.startSidecar({
      python: environment.python,
      envRoot: environment.envRoot,
      appDir: await appDir(),
    });
    log.info("Sidecar ready", ready);
    // The file was restored before the sidecar existed, so tell it now where
    // the kernel should run.
    syncKernelDirectory();
    console_.syncSize();
    installBackendRecovery(console_);
  } catch (err) {
    log.error("Sidecar failed to start", err);
    // The comment here used to say this reported in place "rather than by
    // resurrecting the splash over a working editor", and then did exactly
    // that - with no OK button, so the editor stayed unreachable behind it.
    //
    // The splash is still right: without a sidecar there is no kernel, no
    // console and no viewer, and saying so over the whole window is honest.
    // What was wrong is that it never came back. The editor works, whatever
    // was restored into it is there to be saved, and the backend banner offers
    // a retry once this is dismissed.
    fail("Could not start the Python sidecar.", err?.message ?? err);
    showSplash();
    await acknowledge();
    hideSplash();
    installBackendRecovery(console_);
  }
}

main();
