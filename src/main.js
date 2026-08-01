import { app, events, init, window as neuWindow } from "@neutralinojs/lib";
import "./styles.css";
import "./icons.css";

import { ensureEnvironment } from "./bootstrap/setup.js";
import { appDir } from "./bootstrap/envroot.js";
import { acknowledge, fail, hideSplash, showSplash, splashVisible } from "./bootstrap/splash.js";
import { initSplitters } from "./layout/splitter.js";
import { initConsole } from "./console/terminal.js";
import { focusAt, initEditor } from "./editor/monaco.js";
import {
  confirmDiscardChanges,
  lastViewState,
  rememberPosition,
  restoreLastFile,
  syncKernelDirectory,
} from "./editor/files.js";
import { initViewer, showLogo } from "./viewer/viewer.js";
import { initVariables } from "./vars/explorer.js";
import { awaitKernelRestart } from "./settings.js";
import { initToolbar, updateTitle } from "./toolbar.js";
import * as ipc from "./ipc.js";
import { initTheme } from "./theme.js";
import { initStore } from "./store.js";
import { hideBusy, resetBusy, showBusy } from "./busy.js";
import * as log from "./log.js";

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
    if (!(await confirmDiscardChanges())) {
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
    await rememberPosition();
  } catch (error) {
    log.warn("Could not remember the caret position:", error);
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
// Neutralino creates no native menu bar, so macOS never wires the standard
// Quit shortcut to anything and the app simply ignores it. Handling the key in
// the webview is the only place it can be caught. Ctrl-Q is included for Linux
// and Windows, where it is the common equivalent.
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "q") {
    event.preventDefault();
    shutdown();
  }
});

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
  initViewer();
  initVariables();
  initToolbar();
  const console_ = initConsole();

  // Before the splash lifts, so the window is revealed already showing the file
  // rather than the sample being replaced a moment later. A missing file falls
  // back to the sample and is forgotten - see restoreLastFile.
  const reopened = await restoreLastFile();
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
  // Only restore a position when the file it described actually came back.
  focusAt(reopened === null ? null : lastViewState());

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
