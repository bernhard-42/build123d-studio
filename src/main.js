import { app, events, filesystem, init, window as neuWindow } from "@neutralinojs/lib";
import "./styles.css";
import "./icons.css";

import { ensureEnvironment } from "./bootstrap/setup.js";
import { appDir, recordAppLocation } from "./bootstrap/envroot.js";
import { openTarget } from "./args.js";
import { stopRunning } from "./proc.js";
import {
  acknowledge,
  appendLog,
  fail,
  hideSplash,
  showSplash,
  splashVisible,
} from "./bootstrap/splash.js";
import { initSplitters, toggleBottomRow } from "./layout/splitter.js";
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
  runAll,
  runAllAbove,
  runAllBelow,
  runCellAbove,
  runSelectionOrLine,
  setInterrupt,
  selectedText,
  setDebugHandler,
  setRunFileHandler,
} from "./editor/monaco.js";
import { copy, copyText, cut, initClipboard, paste, pasteInto } from "./editing.js";
import { attachContextMenu } from "./contextmenu.js";
import { confineSelection, textWithin } from "./selection.js";
import { MENU } from "./menu.js";
import { initMenu, refreshMenu, watchSession } from "./menubar.js";
import {
  closeActiveTab,
  closeEveryTab,
  discardRecovery,
  offerRecovery,
  claimJournal,
  reloadUserSnippets,
  closeFolder,
  closeTab,
  currentFolder,
  confirmDiscardAll,
  newFile,
  openFile,
  openFolder,
  checkOpenFilesExist,
  fileRenamed,
  openPath,
  restoreWorkspace,
  saveAll,
  saveFile,
  saveWorkspace,
  selectTab,
  showFolderAt,
  syncKernelDirectory,
} from "./editor/files.js";
import { initTabStrip } from "./editor/tabstrip.js";
import { initSidebar, toggleSidebar } from "./editor/sidebar.js";
import { chordFromEvent, sameChord } from "./keys.js";
import { chordsFor } from "./keybindings.js";
import { handleKey } from "./titlebar/titlebar.js";
import { followWindowFocus } from "./nativedialog.js";
import { initViewer, showLogo } from "./viewer/viewer.js";
import { initVariables } from "./vars/explorer.js";
import { awaitKernelRestart, showSettings } from "./settings.js";
import { showInfo } from "./info.js";
import {
  initToolbar,
  interruptKernel,
  restartKernel,
  setDebugToggle,
  updateTitle,
} from "./toolbar.js";
import { initDebug } from "./debug/session.js";
import { initDebugUi, stepAction, toggleDebugging } from "./debug/start.js";
import * as ipc from "./ipc.js";
import { initTheme } from "./theme.js";
import { getSetting, initStore, setSetting } from "./store.js";
import { hideBusy, resetBusy, showBusy } from "./busy.js";
import { appendBackendLine, showConsolePanel } from "./debug/console.js";
import { anythingUnwell, record as recordHealth, reset as resetHealth } from "./health.js";
import * as log from "./log.js";
import { guardAgainstReload, suppressNativeContextMenu } from "./reload.js";
import { initRunFile, toggleRunFile } from "./run/file.js";
import { restoreWindow, saveWindow, watchWindow } from "./windowstate.js";

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
  let promptFailed = false;
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
    // But this is now an end that asked nobody, which is exactly what the
    // recovery journal is for - so it is kept rather than cleared below, and
    // the next start offers the work back.
    promptFailed = true;
  } finally {
    asking = false;
  }

  shuttingDown = true;
  // Everything unsaved has just been asked about, so the recovery copies are
  // answering a question nobody is going to be asked again. Whatever survived
  // that prompt was either saved or deliberately discarded, and offering it
  // back at the next start would argue with the answer they gave.
  if (promptFailed) {
    log.warn("Keeping the recovery journal: nobody was asked about this quit");
  } else {
    try {
      await discardRecovery();
    } catch (error) {
      log.warn("Could not clear the recovery journal:", error);
    }
  }
  try {
    await saveWorkspace();
  } catch (error) {
    log.warn("Could not remember the open tabs:", error);
  }
  // Here as well as on resize, because nothing publishes a window *move* - a
  // window that was only dragged would otherwise come back at its old place.
  await saveWindow();
  try {
    await ipc.stopSidecar();
  } catch (error) {
    log.warn("Sidecar shutdown:", error);
  }

  // uv, and whatever it started, and the curl or tar that may be fetching it.
  // Nothing else collects these: Neutralino kills nothing of its own at exit,
  // and unlike the sidecar they hold no contract that takes them with us. A
  // first run interrupted here used to leave an install writing into the
  // environment of an application that had gone.
  //
  // Killing uv part-way is safe by construction - every start runs uv sync,
  // which finishes an interrupted one - and is much better than the two
  // installs in one environment that a relaunch would otherwise meet.
  try {
    const stopped = await stopRunning();
    if (stopped > 0) {
      log.info(`Stopped ${stopped} process(es) still running at quit`);
    }
  } catch (error) {
    log.warn("Stopping what was still running:", error);
  } finally {
    await app.exit();
  }
}

events.on("windowClose", () => {
  shutdown();
});

// Cmd-Q / Ctrl-Q.
//
// Kept now that the menu has landed and carries a real Quit item (menu.js),
// because a menu shortcut only *binds* on macOS: on Windows and GNU/Linux the
// field displays the accelerator and nothing more - menu.js records that as what
// the Neutralino documentation guarantees. So this is what actually delivers
// Ctrl-Q on those two platforms, and removing it as redundant would take the
// shortcut with it there.
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "q") {
    event.preventDefault();
    shutdown();
  }
});

// The kernel's own chords, delivered whatever has the keyboard.
//
// Not editor actions like the run commands, and the difference is the point: a
// restart is what somebody reaches for while the console is wedged or the
// variable explorer has the caret, and an editor action only arrives when the
// editor does. Matched against the keymap rather than against a literal, so
// rebinding it in Settings moves this with it.
//
// macOS cannot help here either - its native menu binds Command plus a single
// character and nothing more - so this listener is the only delivery there is.
window.addEventListener("keydown", (event) => {
  const chord = chordFromEvent(NL_OS, event);
  if (chord === null || !chordsFor("kernel.restart").some((bound) => sameChord(bound, chord))) {
    return;
  }
  event.preventDefault();
  void restartKernel();
});

// The in-window menu bar's keyboard: Alt shows the underlines, Alt-F opens File,
// the arrows walk it. Capture, so a menu that is open answers before the editor
// does - and only what the bar says it consumed is stopped, because a bar that
// swallowed keys it had no use for would be a bar that broke typing.
//
// keyup as well as keydown, because Alt on its own is a gesture only when it is
// released without another key: Alt-F is one thing, Alt alone is another.
for (const type of ["keydown", "keyup"]) {
  window.addEventListener(type, (event) => {
    if (handleKey(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true });
}

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
 * Rebuilt whole rather than item by item: there is no documented way to change
 * one item's state. This is the folder path only - a tab opening or closing, a
 * Settings change, a Run and a debug session all rebuild it from their own call
 * sites, because what is greyed out depends on every one of them. See
 * watchSession below, which says the same thing from the other end.
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

/**
 * Open what the command line asked for, or restore the previous session.
 *
 * A directory becomes the project. A file becomes the project's *containing*
 * directory plus that one open tab, which is what makes `studio main.py` put
 * the kernel where the command was typed: group 2 decided the working directory
 * is the project root when there is a project, so opening the folder is how a
 * file argument gets the behaviour rather than a third rule about working
 * directories being invented for it.
 *
 * A path that has gone falls back to the restore. Someone who typed the name of
 * a deleted file should get their editor, not an empty window and a dialog.
 */
async function openRequestedOrRestore() {
  const requested = openTarget(NL_ARGS);
  if (requested === null) {
    await restoreWorkspace();
    return;
  }

  let stats;
  try {
    stats = await filesystem.getStats(requested);
  } catch (error) {
    log.warn(`Cannot open ${requested}:`, error);
    await restoreWorkspace();
    return;
  }

  if (stats.isDirectory) {
    await showFolderAt(requested);
    return;
  }

  // The containing directory first, so the tree is populated and the kernel is
  // told about the project before the tab appears - the same order
  // restoreWorkspace uses, and for the same reason.
  const parts = await filesystem.getPathParts(requested);
  await showFolderAt(parts.parentPath);
  await openPath(requested);
}

async function main() {
  // Both write into the app-data directory rather than the application's own,
  // so they only need os.getPath - no environment, nothing to bootstrap. Doing
  // them first means the rest of startup is logged and can read settings.
  await log.initLog();
  // The Backend tab shows the log as it happens, from the first line: the
  // application starts on that tab, so what a user is looking at while the
  // window fills is the machinery reporting for itself.
  log.onLine((line, key) => appendBackendLine(line, key));

  // What each part of the machinery says about itself. Recorded so that the
  // end of startup can ask one question - is anything unwell - rather than
  // guessing from whether an exception was thrown, and shown in the pane the
  // user is already looking at.
  ipc.on("subsystem", (frame) => recordHealth(frame.name, frame.state, frame.detail));
  // A replacement sidecar describes itself from scratch, so the dead one's
  // picture goes with it. Without this, `reset` had no caller at all and the
  // toolbar could carry a failure belonging to a process that no longer
  // exists - which is the same defect as a kernel that restarted and stayed
  // `failed`, one level further out.
  ipc.on("sidecar.restarting", () => resetHealth());
  await initStore();
  // How much of the browser console is mirrored into the log. Read here rather
  // than in log.js so that logging keeps its one dependency - the log file -
  // and does not have to care whether the settings are up yet.
  // Errors, at every start, whatever was chosen last time. Turning the console
  // up is for reproducing something now - and left on by accident it costs the
  // viewer real speed, because every notification it makes becomes a line
  // written to disk. So the setting is deliberately not remembered: it is a
  // tool you pick up, not a preference you keep.
  log.setConsoleLevel("error");
  if (getSetting("consoleLevel", "error") !== "error") {
    setSetting("consoleLevel", "error").catch((error) =>
      log.warn("Could not reset the console level:", error),
    );
  }

  log.info("Starting up", { NL_OS, NL_ARCH: typeof NL_ARCH === "string" ? NL_ARCH : "?" });

  // Where the `studio` script looks to find this application. Failing is not
  // worth interrupting startup for: the only casualty is a command line tool
  // the user may never have copied.
  try {
    log.info("Recorded the application location at", await recordAppLocation());
  } catch (error) {
    log.warn("Could not record the application location:", error);
  }

  await neuWindow.setTitle("build123d Studio");
  // Before show(), so the window appears where it belongs rather than at the
  // default and then jumping. Neutralino's own memory of this lives beside its
  // binary and is therefore lost on every new install; ours is in settings.json
  // with everything else.
  await restoreWindow();
  await neuWindow.show();
  watchWindow();

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
  initSidebar({
    onOpenFile: (path) => withTitle(() => openPath(path)),
    // A refresh is the only moment this application learns that a file it has
    // open has been deleted from outside - there is no watcher yet.
    onRefreshed: () => {
      checkOpenFilesExist().catch((error) =>
        log.warn("Could not check whether the open files are still there:", error));
    },
    onRenamed: (from, to) => fileRenamed(from, to),
  });
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
    [MENU.TOGGLE_BOTTOM]: toggleBottomRow,
    [MENU.SAVE]: () => saveFile(),
    [MENU.SAVE_AS]: () => saveFile({ saveAs: true }),
    [MENU.SAVE_ALL]: () => withMenu(saveAll),
    [MENU.CLOSE]: () => withMenu(closeActiveTab),
    [MENU.CLOSE_ALL]: () => withMenu(closeEveryTab),
    "run.cell": () => runCell(),
    "run.cell.stay": () => runCell({ advance: false }),
    "run.selectionOrLine": () => runSelectionOrLine(),
    "run.all": runAll,
    "run.cellAbove": () => runCellAbove(),
    "run.allAbove": () => runAllAbove(),
    "run.allBelow": () => runAllBelow(),
    "run.file": () => void toggleRunFile(),
    "kernel.restart": () => void restartKernel(),
    "debug.start": () => withMenu(toggleDebugging),
    "debug.restart": () => stepAction("restart"),
    "debug.stop": () => stepAction("stop"),
    "debug.continue": () => stepAction("continue"),
    "debug.stepOver": () => stepAction("stepOver"),
    "debug.stepInto": () => stepAction("stepInto"),
    "debug.stepOut": () => stepAction("stepOut"),
  });

  // Debugging: the session listens to the sidecar, the UI follows the session,
  // and the editor's Shift-F5 is handed the action. All three before the
  // workspace is restored, so a file that reopens can be debugged at once.
  // The sidecar's own progress, on the splash, while it is still up. Its log
  // already says what it is doing - the kernel starting, the language server,
  // the two warm-ups - and on a slow machine that is five seconds of "starting"
  // with nothing to show for it.
  ipc.onSidecarProgress((line) => {
    if (splashVisible()) {
      appendLog(line);
    }
    // Nothing goes into the console pane any more. That pane is a transcript of
    // a real session, and the startup narration now has a home of its own - the
    // Backend tab, which is what the application starts on and where every line
    // of this already arrives through the log.
  });

  initDebug();
  initDebugUi();
  initRunFile();
  setDebugHandler(toggleDebugging, stepAction);
  setRunFileHandler(toggleRunFile);
  setDebugToggle(toggleDebugging);

  // Before the splash lifts, so the window is revealed already showing the
  // files rather than the sample being replaced a moment later. Files that have
  // gone are left closed - see restoreWorkspace.
  //
  // An argument replaces the restore rather than joining it, and that is the
  // whole rule: `studio .` says what this window is for, so restoring five
  // files from last time and then opening a folder - which closes them all
  // again, because a folder is a context reset - would be silly. No argument
  // means a double-click, which has nothing to go on but the previous session.
  await openRequestedOrRestore();

  // Said as early as there is a directory to say it in, so a window that
  // crashes during its own startup still leaves a beat behind.
  claimJournal().catch((error) => log.warn("Could not claim the recovery journal:", error));
  // The user's own snippets, if they have written any. Not awaited: the editor
  // works without them and a file read must not stand in front of the window.
  // What the Interrupt button above a cell marker does. Handed to the editor
  // rather than imported by it: interrupting belongs to the toolbar, which
  // already imports the editor.
  setInterrupt(() => void interruptKernel());

  reloadUserSnippets().catch((error) => log.warn("Could not read the snippets file:", error));

  // The window being activated is the one moment we are told about rather than
  // having to guess at: a dialog has closed, the operating system has brought
  // the window back, and nothing inside it holds the caret.
  followWindowFocus();

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

  // After the splash, and that matters: this is a question, and a modal behind
  // a splash screen is one nobody can answer. It waits for an answer, so
  // asking before the window is up holds the whole startup on it.
  //
  // After the session is restored as well, so a recovered buffer joins what was
  // already open rather than the restore arriving on top of it. Before the
  // sidecar only because it does not need one - these are the frontend's own
  // files - and somebody who has just lost work should not wait for a kernel.
  try {
    await offerRecovery();
  } catch (error) {
    log.warn("Could not offer to recover unsaved work:", error);
  }

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

    // The startup is over and it went well, so the pane stops showing how it
    // went and goes back to being the console. A start that fails never
    // reaches this line, which is exactly how the reason stays on screen -
    // there is no dialog to dismiss and nothing to go looking for.
    if (!anythingUnwell()) {
      showConsolePanel("console");
      console_.syncSize();
      focusEditor();
    }
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
