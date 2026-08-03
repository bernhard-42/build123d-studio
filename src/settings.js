import {
  GITHUB,
  PACKAGES,
  PYPI,
  hasGit,
  packageSources,
  savePackageSources,
} from "./packages.js";
import { applyPackageSources, upgradePackages } from "./bootstrap/setup.js";
import {
  acknowledge,
  appendLog,
  clearLog,
  hideSplash,
  setStatus,
  showSplash,
} from "./bootstrap/splash.js";
import { NEW_FILE_TEMPLATE_KEY, newFileTemplate } from "./editor/files.js";
import { setSetting } from "./store.js";
import * as ipc from "./ipc.js";
import * as log from "./log.js";
import { escapeHtml } from "./escape.js";
import { closeOnBackdropClick } from "./backdrop.js";

// Package sources.
//
// Only build123d and bd_warehouse appear here. The rest of the environment is
// frozen on purpose - ocp_vscode has to match the three-cad-viewer build in the
// frontend - and offering a switch for it would only let people break the
// viewer.
//
// Nothing here checks whether the chosen combination is satisfiable.
// bd_warehouse tracks build123d and the constraint between them moves with
// every release, so any rule encoded here would be wrong within weeks. uv
// refuses what it cannot resolve, and ensureEnvironment falls back to PyPI
// rather than leaving a broken environment behind.

// A restart is a fresh kernel process: jupyter_client's own wait_for_ready is
// 60 s, and the console is started after it. Only a backstop for a sidecar that
// answers nothing at all - a sidecar that dies is reported immediately by the
// death signals below.
const RESTART_TIMEOUT = 120000;

/**
 * Restart the kernel and wait for the outcome.
 *
 * Shared by both flows here, and by the recovery banner when the kernel dies
 * on its own, so none of them can forget one of the ways this ends.
 * Awaiting only kernel.restarted/kernel.restart_failed was not enough: if the
 * sidecar process dies during the restart, or was already gone when the send
 * happened to succeed, neither frame is ever sent and the splash stays up for
 * ever with no OK button.
 */
export async function awaitKernelRestart() {
  ipc.send("kernel.restart");
  await ipc.awaitOutcome(
    "kernel.restarted",
    ["kernel.restart_failed", "sidecar.exit", "sidecar.disconnected"],
    { timeout: RESTART_TIMEOUT, what: "The kernel" },
  );
}

function close() {
  document.getElementById("settings-dialog")?.remove();
  document.removeEventListener("keydown", onKeyDown);
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    close();
  }
}

function packageRow(pkg, selection, gitPresent) {
  const disabled = gitPresent ? "" : "disabled";
  // Said plainly: this option installs and runs whatever is on that branch at
  // the moment it is fetched. That is the point of the feature, and it is
  // opt-in, but it should not be discovered afterwards.
  const gitNote = gitPresent
    ? `Builds and runs the <code>${escapeHtml(pkg.branch)}</code> branch as fetched, ` +
      "which is unreleased code from the internet."
    : "Requires git, which was not found on this computer.";

  return `
    <div class="settings-package">
      <div class="settings-package-name">${escapeHtml(pkg.name)}</div>
      <label class="settings-option">
        <input type="radio" name="src-${escapeHtml(pkg.name)}" value="${PYPI}"
               ${selection[pkg.name] === PYPI ? "checked" : ""}>
        <span><strong>PyPI</strong> — the released version.</span>
      </label>
      <label class="settings-option ${gitPresent ? "" : "settings-option-disabled"}">
        <input type="radio" name="src-${escapeHtml(pkg.name)}" value="${GITHUB}"
               ${selection[pkg.name] === GITHUB ? "checked" : ""} ${disabled}>
        <span>
          <strong>GitHub development version</strong> — ${gitNote}
        </span>
      </label>
    </div>`;
}

/**
 * Upgrade the floating packages to their newest versions.
 *
 * Lives here rather than on the toolbar because it belongs with the source
 * choice - both answer "which build123d am I running?" - and because it is a
 * rare action that was taking permanent space in a row that has to stay narrow.
 *
 * Only build123d and bd_warehouse move; see upgradePackages for why the rest
 * must not.
 */
async function upgradeAndResync() {
  close();
  showSplash();
  clearLog();
  setStatus("Upgrading packages…");

  try {
    await upgradePackages(appendLog);
    // The running kernel already imported the old modules.
    setStatus("Restarting the kernel…");
    await awaitKernelRestart();
    // Held open until acknowledged: what the upgrade actually did - which
    // packages moved and to which versions - is the point of running it, and
    // dismissing itself put that on screen only while it was still scrolling.
    setStatus("Upgrade complete.");
  } catch (error) {
    log.error("Upgrade failed:", error);
    appendLog("");
    appendLog(`Upgrade failed: ${error?.message ?? error}`);
    setStatus("Upgrade failed.");
  } finally {
    await acknowledge();
    hideSplash();
  }
}

async function applyAndResync(selection) {
  close();
  showSplash();
  clearLog();
  setStatus("Changing package sources…");
  appendLog("Rebuilding the environment for the selected package sources.");

  try {
    await savePackageSources(selection);
    await applyPackageSources(selection, appendLog);

    setStatus("Restarting the kernel…");
    await awaitKernelRestart();
    setStatus("Package sources applied.");
  } catch (error) {
    log.error("Could not apply the package sources:", error);
    appendLog("");
    appendLog(`Failed: ${error?.message ?? error}`);
    setStatus("Could not apply the package sources.");
    appendLog("");
    appendLog("The combination may be unsatisfiable - bd_warehouse tracks");
    appendLog("build123d, so a released one and a development one often do");
    appendLog("not fit together. Restart the app to fall back to PyPI.");
  } finally {
    // Dismissed by the user, not by a timer: the log explains what happened,
    // and after a failure it is the only place that says why.
    await acknowledge();
    hideSplash();
  }
}

export async function showSettings() {
  close();

  const selection = packageSources();
  const gitPresent = await hasGit();

  const overlay = document.createElement("div");
  overlay.id = "settings-dialog";
  overlay.className = "info-overlay";
  overlay.innerHTML = `
    <div class="info-panel" role="dialog" aria-label="Settings">
      <div class="info-header">
        <span class="info-title">Packages</span>
        <button class="btn" id="settings-close" title="Close">
          <span class="icon icon-close"></span>
        </button>
      </div>
      <div class="info-body">
        <p class="info-note">
          Only these two can be changed. The viewer's packages are fixed to the
          versions this application was built against.
        </p>
        ${PACKAGES.map((p) => packageRow(p, selection, gitPresent)).join("")}

        <h2 class="info-heading">Updates</h2>
        <p class="info-note">
          Fetch the newest build123d and bd_warehouse. Everything else stays as
          the application shipped it, so the viewer cannot be broken by an
          upgrade. The kernel restarts afterwards.
        </p>
        <button class="settings-btn" id="settings-upgrade">Upgrade packages</button>

        <h2 class="info-heading">New file</h2>
        <p class="info-note">
          What a new file starts with. Left empty, New File opens an empty
          buffer.
        </p>
        <textarea class="settings-template" id="settings-new-template" rows="6"
                  spellcheck="false"
                  placeholder="from build123d import *&#10;from build123d_studio import show"
        >${escapeHtml(newFileTemplate())}</textarea>

        <div class="settings-actions">
          <button class="settings-btn" id="settings-cancel">Cancel</button>
          <button class="settings-btn settings-btn-primary" id="settings-apply">Apply</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  closeOnBackdropClick(overlay, close);
  document.getElementById("settings-close").addEventListener("click", close);
  document.getElementById("settings-upgrade").addEventListener("click", upgradeAndResync);
  document.getElementById("settings-cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKeyDown);

  document.getElementById("settings-apply").addEventListener("click", async () => {
    // Saved whether or not the package sources changed, and before the branch
    // below: the two settings share a dialog but nothing else, and rebuilding
    // the environment must not be the price of editing a template - nor may
    // closing without a rebuild silently drop it.
    const template = document.getElementById("settings-new-template").value;
    if (template !== newFileTemplate()) {
      await setSetting(NEW_FILE_TEMPLATE_KEY, template);
    }

    const chosen = {};
    for (const p of PACKAGES) {
      const picked = overlay.querySelector(`input[name="src-${p.name}"]:checked`);
      chosen[p.name] = picked === null ? PYPI : picked.value;
    }
    // Rebuilding takes a while, so do not do it for a dialog that was opened
    // and closed without changing anything.
    const unchanged = PACKAGES.every((p) => chosen[p.name] === selection[p.name]);
    if (unchanged) {
      close();
      return;
    }
    applyAndResync(chosen);
  });
}
