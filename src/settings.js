import {
  DECLARED,
  GITHUB,
  LOCAL,
  PACKAGES,
  PYPI,
  customPackages,
  hasGit,
  localPathFor,
  packageSources,
  saveCustomPackages,
  saveLocalPaths,
  savePackageSources,
} from "./packages.js";
import { findProblems, parseRequirements } from "./requirements.js";
import {
  COMMANDS,
  chordFromEvent,
  chordProblem,
  defaultChordsFor,
  describeChord,
  findChordConflicts,
} from "./keys.js";
import { chordsFor, setChordsFor } from "./keybindings.js";
import { rebindRunActions } from "./editor/monaco.js";
import { refreshMenu } from "./menubar.js";
import {
  applyPackageSources,
  reinstallPackage,
  upgradePackages,
} from "./bootstrap/setup.js";
import {
  acknowledge,
  appendLog,
  clearLog,
  hideSplash,
  setStatus,
  showSplash,
} from "./bootstrap/splash.js";
import { NEW_FILE_TEMPLATE_KEY, newFileTemplate } from "./editor/files.js";
import { lineLengthProblem, usableLineLength } from "./editor/format.js";
import {
  FORMAT_ON_SAVE_KEY,
  formatLineLength,
  formatOnSave,
  LINE_LENGTH_KEY,
} from "./editor/formatting.js";
import { DEFAULT_NEW_FILE_TEMPLATE } from "./editor/starters.js";
import {
  JUST_MY_CODE_KEY,
  ON_STOP_BREAKPOINTS_ONLY_KEY,
  ON_STOP_KEY,
  justMyCode,
  onStopBreakpointsOnly,
  onStopExpression,
} from "./debug/settings.js";
import { getSetting, setSetting } from "./store.js";
import { os } from "@neutralinojs/lib";
import * as ipc from "./ipc.js";
import * as log from "./log.js";
import { escapeHtml } from "./escape.js";
import { closeOnBackdropClick } from "./backdrop.js";
import { refreshToolbarTitles } from "./toolbar.js";

// Package sources.
//
// Only build123d has a source picker. The rest of what the application declares
// is frozen on purpose - ocp_vscode has to match the three-cad-viewer build in
// the frontend - and offering a switch for it would only let people break the
// viewer. Anything else a user wants goes in the additional-packages field,
// where the line itself says where the package comes from.
//
// Nothing here checks whether the chosen combination is satisfiable. uv refuses
// what it cannot resolve and says why far better than a rule encoded here
// would, and ensureEnvironment falls back rather than leaving a broken
// environment behind.

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

// The panels of the dialog. Order is the order they appear in.
const TABS = [
  { id: "packages", label: "Packages" },
  { id: "newfile", label: "New file" },
  { id: "editor", label: "Editor" },
  { id: "debugging", label: "Debugging" },
  { id: "shortcuts", label: "Shortcuts" },
];
const TAB_KEY = "settingsTab";

/**
 * The tab to open on, given whatever was remembered.
 *
 * A stored id that no longer exists falls back rather than showing an empty
 * panel: settings.json is a file a user can edit, and tabs can be renamed
 * between releases.
 */
function rememberedTab() {
  const stored = getSetting(TAB_KEY);
  return TABS.some((tab) => tab.id === stored) ? stored : TABS[0].id;
}

function packageRow(pkg, selection, gitPresent, localPath) {
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
      <label class="settings-option">
        <input type="radio" name="src-${escapeHtml(pkg.name)}" value="${LOCAL}"
               ${selection[pkg.name] === LOCAL ? "checked" : ""}>
        <span>
          <strong>Local checkout</strong> — your own working copy, installed from
          disk. This is the only way to run against a source tree you are editing;
          the field below refuses to name a package the application declares.
        </span>
      </label>
      <div class="settings-local">
        <input class="settings-line" type="text" spellcheck="false"
               id="local-${escapeHtml(pkg.name)}"
               value="${escapeHtml(localPath)}"
               placeholder="no folder chosen">
        <button class="settings-btn" id="choose-${escapeHtml(pkg.name)}">Choose…</button>
      </div>
      <button class="settings-btn settings-action" id="reinstall-${escapeHtml(pkg.name)}">
        Re-install ${escapeHtml(pkg.name)}
      </button>
    </div>`;
}

/**
 * Run one environment action behind the splash, then come back to the dialog.
 *
 * Only Apply and Cancel close Settings. Install, Re-install and Upgrade all act
 * on the environment and return to where they were pressed - on success as well
 * as on failure, so the rule is one sentence rather than two.
 */
async function runEnvironmentAction({ status, done, work }) {
  close();
  showSplash();
  clearLog();
  setStatus(status);

  try {
    await work();
    // The running kernel has already imported whatever was replaced.
    setStatus("Restarting the kernel…");
    await awaitKernelRestart();
    setStatus(done);
  } catch (error) {
    log.error(`${status} failed:`, error);
    appendLog("");
    appendLog(`Failed: ${error?.message ?? error}`);
    setStatus("Failed - see above.");
  } finally {
    // Dismissed by the user, not by a timer: the log explains what happened,
    // and after a failure it is the only place that says why.
    await acknowledge();
    hideSplash();
  }
  await showSettings({ tab: "packages" });
}

/** Make the environment match the saved configuration, changing nothing else. */
function installPackages() {
  return runEnvironmentAction({
    status: "Installing packages…",
    done: "Packages installed.",
    work: () => applyPackageSources(packageSources(), appendLog),
  });
}

/** Put one package back from its source - see reinstallPackage. */
function reinstall(name) {
  return runEnvironmentAction({
    status: `Re-installing ${name}…`,
    done: `${name} re-installed.`,
    work: () => reinstallPackage(name, appendLog),
  });
}

/** Move every package as far as its own constraint allows. */
function upgradeAndResync() {
  return runEnvironmentAction({
    status: "Upgrading packages…",
    done: "Upgrade complete.",
    work: () => upgradePackages(appendLog),
  });
}

export async function showSettings({ tab = null } = {}) {
  close();

  const selection = packageSources();
  const gitPresent = await hasGit();

  const overlay = document.createElement("div");
  overlay.id = "settings-dialog";
  overlay.className = "info-overlay";
  overlay.innerHTML = `
    <div class="info-panel" role="dialog" aria-label="Settings">
      <div class="info-header">
        <span class="info-title">Settings</span>
        <button class="btn" id="settings-close" title="Close">
          <span class="icon icon-close"></span>
        </button>
      </div>
      <div class="settings-tabs" role="tablist">
        ${TABS.map(
          (tab) => `
          <button class="settings-tab" role="tab" data-tab="${tab.id}"
                  id="tab-${tab.id}">${escapeHtml(tab.label)}</button>`,
        ).join("")}
      </div>
      <div class="info-body">
        <section class="settings-panel" data-panel="packages">
          <p class="info-note">
            Where build123d comes from. Everything else the application declares is
            fixed to the versions this release was built and tested against.
          </p>
          ${PACKAGES.map((p) => packageRow(p, selection, gitPresent, localPathFor(p.name))).join("")}

          <h2 class="info-heading">Additional packages</h2>
          <p class="info-note">
            One per line. The line itself says where the package comes from — a
            name for PyPI, a folder for a local checkout, or a git URL. Add
            <code>name @</code> in front when the package is not named after its
            folder or repository. Nothing here is checked for you beyond the two
            rules below; uv reports anything else, and reports it better.
          </p>
          <textarea class="settings-template" id="settings-custom" rows="6" spellcheck="false"
                    placeholder="ocp-widgets&#10;/Users/me/src/mylib&#10;git+https://github.com/someone/other@main"
          >${escapeHtml(customPackages())}</textarea>
          <p class="info-note" id="settings-custom-problems" hidden></p>
          <button class="settings-btn settings-action" id="settings-install">
            Install packages
          </button>

          <h2 class="info-heading">Upgrade</h2>
          <p class="info-note">
            Move every package as far as its own version range allows, then
            install the result. build123d can move, and so can anything above
            with a range of its own; whatever is pinned to an exact version
            cannot, which is what keeps the viewer's packages where they are.
            The kernel restarts afterwards, because the running one has already
            imported the versions being replaced.
          </p>
          <button class="settings-btn" id="settings-upgrade">Upgrade packages</button>
        </section>

        <section class="settings-panel" data-panel="newfile" hidden>
          <p class="info-note">
            What a new file starts with. Cleared, New File opens an empty buffer;
            Restore default puts the shipped template back.
          </p>
          <textarea class="settings-template" id="settings-new-template" rows="12"
                    spellcheck="false"
                    placeholder="Empty: New File opens a blank buffer"
          >${escapeHtml(newFileTemplate())}</textarea>
          <button class="settings-btn settings-template-reset" id="settings-template-default">
            Restore default
          </button>
        </section>

        <section class="settings-panel" data-panel="editor" hidden>
          <p class="settings-group">black</p>
          <p class="info-note">
            The width black wraps at, and the column the editor's ruler is drawn
            at - they are the same number so that the line you are looking at is
            the line the formatter will break. 88 is black's own default.
          </p>
          <label class="settings-field">
            <span>Line length</span>
            <input class="settings-number" id="settings-line-length" type="number"
                   min="20" max="1000" step="1" />
          </label>

          <p class="info-note">
            Format the buffer with black each time it is saved. black changes
            layout and never meaning, the result is one undo away, and a buffer
            that does not parse is left exactly as it is rather than half done.
          </p>
          <label class="settings-check">
            <input type="checkbox" id="settings-format-on-save" />
            <span>Format on save</span>
          </label>
          <p class="info-note" id="settings-editor-problems" hidden></p>
        </section>

        <section class="settings-panel" data-panel="debugging" hidden>
          <p class="info-note">
            With this on, Step Into stays inside your own file. Off, it follows
            the call into build123d - useful for seeing what a shape operation did
            with your arguments, and a longer way round when you did not mean it.
          </p>
          <label class="settings-check">
            <input type="checkbox" id="settings-just-my-code" />
            <span>Step into my code only</span>
          </label>

          <p class="info-note">
            Run an expression every time execution stops.
            <code>show_all(locals())</code> draws whatever the current frame
            holds, so stepping through a model is watching it being built. It
            costs a tessellation per stop, which on a large assembly is seconds -
            clear the field to switch it off.
          </p>
          <input class="settings-line" id="settings-on-stop" type="text" spellcheck="false"
                 placeholder="empty — nothing runs at a stop" />
          <label class="settings-check">
            <input type="checkbox" id="settings-on-stop-breakpoints" />
            <span>Only at breakpoints, not at every step</span>
          </label>
        </section>

        <section class="settings-panel" data-panel="shortcuts" hidden>
          <p class="info-note">
            Click a chord to remove it, or <strong>Record</strong> to add one.
            A command may answer to several. Changes apply when this dialog is
            applied, and the editor is re-bound straight away.
          </p>
          <div id="settings-shortcuts"></div>
          <p class="info-note settings-problem" id="settings-chord-problems" hidden></p>
          <button class="settings-btn settings-action" id="settings-chords-reset">
            Restore all defaults
          </button>
        </section>

        <div class="settings-actions">
          <button class="settings-btn" id="settings-cancel">Cancel</button>
          <button class="settings-btn settings-btn-primary" id="settings-apply">Apply</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  closeOnBackdropClick(overlay, close);
  document.getElementById("settings-close").addEventListener("click", close);
  document.getElementById("settings-cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKeyDown);

  // Tabs. Remembered across openings, because five panels means the one you
  // want is usually the one you were last on - and stored immediately rather
  // than on Apply, since which tab you were looking at is not a setting anyone
  // would want to cancel.
  const showTab = (id) => {
    for (const tab of TABS) {
      const button = document.getElementById(`tab-${tab.id}`);
      const panel = overlay.querySelector(`[data-panel="${tab.id}"]`);
      const active = tab.id === id;
      button.classList.toggle("settings-tab-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      panel.hidden = !active;
    }
    setSetting(TAB_KEY, id).catch((error) => log.warn("Could not remember the tab:", error));
  };
  for (const tab of TABS) {
    document.getElementById(`tab-${tab.id}`).addEventListener("click", () => showTab(tab.id));
  }
  showTab(tab === null ? rememberedTab() : tab);

  // The folder picker for a local checkout. Choosing one also selects the Local
  // radio, because picking a folder and then finding it had no effect is the
  // obvious way for this to be annoying.
  for (const p of PACKAGES) {
    document.getElementById(`choose-${p.name}`).addEventListener("click", async () => {
      const chosen = await os.showFolderDialog(`Where is your ${p.name} checkout?`, {
        defaultPath: document.getElementById(`local-${p.name}`).value || undefined,
      });
      // Cancel is undocumented; anything that is not a non-empty string is one.
      if (typeof chosen !== "string" || chosen === "") {
        return;
      }
      document.getElementById(`local-${p.name}`).value = chosen;
      const radio = overlay.querySelector(`input[name="src-${p.name}"][value="${LOCAL}"]`);
      radio.checked = true;
    });
  }

  // Puts the text back in the field, not in settings: Apply is still what
  // saves, so restoring and then cancelling leaves the stored template alone
  // like every other edit in this dialog. Without this there is no way back -
  // clearing the field is one keystroke and retyping twenty lines is not.
  document.getElementById("settings-template-default").addEventListener("click", () => {
    document.getElementById("settings-new-template").value = DEFAULT_NEW_FILE_TEMPLATE;
  });

  // --- shortcuts -----------------------------------------------------------
  //
  // Edited in a working copy and written by saveEverything, like every other
  // field here: recording a chord must not become a change you cannot cancel.
  const chords = Object.fromEntries(COMMANDS.map((c) => [c.id, [...chordsFor(c.id)]]));
  let recording = null;

  const renderChords = () => {
    const list = document.getElementById("settings-shortcuts");
    list.innerHTML = COMMANDS.map((command) => {
      const chips = chords[command.id]
        .map(
          (chord) =>
            `<button class="settings-chord" data-command="${escapeHtml(command.id)}"
                     data-chord="${escapeHtml(chord)}"
                     title="Remove this shortcut">${escapeHtml(describeChord(NL_OS, chord))}</button>`,
        )
        .join("");
      const label = recording === command.id ? "Press a chord…" : "Record";
      return `
        <div class="settings-shortcut">
          <span class="settings-shortcut-name">${escapeHtml(command.label)}</span>
          <span class="settings-shortcut-chords">${chips}</span>
          <button class="settings-btn settings-record" data-record="${escapeHtml(command.id)}"
                  >${label}</button>
        </div>`;
    }).join("");

    // Conflicts are reported, not prevented: which of two commands the user
    // meant to keep is theirs to decide, and silently refusing the second would
    // look like the dialog had ignored them.
    const found = findChordConflicts(chords);
    const report = document.getElementById("settings-chord-problems");
    if (found.length === 0) {
      report.hidden = true;
    } else {
      const name = (id) => COMMANDS.find((c) => c.id === id)?.label ?? id;
      report.innerHTML = found
        .map(
          (conflict) =>
            escapeHtml(
              `${describeChord(NL_OS, conflict.chord)} is on ` +
                `${conflict.commands.map(name).join(" and ")} - whichever registers last wins.`,
            ),
        )
        .join("<br>");
      report.hidden = false;
    }
  };

  const stopRecording = () => {
    recording = null;
    document.removeEventListener("keydown", onRecord, true);
    renderChords();
  };

  function onRecord(event) {
    // Capturing, and swallowed: while recording, the chord being pressed must
    // not also run the command it is being bound to.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    const chord = chordFromEvent(NL_OS, event);
    if (chord === null) {
      // A modifier on its own - the user is still assembling one.
      return;
    }
    const problem = chordProblem(chord);
    const report = document.getElementById("settings-chord-problems");
    if (problem !== null) {
      const target = recording;
      stopRecording();
      report.textContent = `${describeChord(NL_OS, chord) || chord}: ${problem}`;
      report.hidden = false;
      void target;
      return;
    }
    if (!chords[recording].includes(chord)) {
      chords[recording].push(chord);
    }
    stopRecording();
  }

  document.getElementById("settings-shortcuts").addEventListener("click", (event) => {
    const record = event.target.closest("[data-record]");
    if (record !== null) {
      if (recording !== null) {
        stopRecording();
      }
      recording = record.dataset.record;
      document.addEventListener("keydown", onRecord, true);
      renderChords();
      return;
    }
    const chip = event.target.closest("[data-chord]");
    if (chip !== null) {
      const list = chords[chip.dataset.command];
      chords[chip.dataset.command] = list.filter((chord) => chord !== chip.dataset.chord);
      renderChords();
    }
  });

  document.getElementById("settings-chords-reset").addEventListener("click", () => {
    for (const command of COMMANDS) {
      chords[command.id] = [...defaultChordsFor(command.id)];
    }
    renderChords();
  });

  renderChords();

  document.getElementById("settings-line-length").value = String(formatLineLength());
  document.getElementById("settings-format-on-save").checked = formatOnSave();
  document.getElementById("settings-just-my-code").checked = justMyCode();
  document.getElementById("settings-on-stop").value = onStopExpression();
  document.getElementById("settings-on-stop-breakpoints").checked =
    onStopBreakpointsOnly();


  /**
   * Save every field, or report why not. True when it was saved.
   *
   * Shared by Apply, Install and Upgrade, so none of them can drift into saving
   * a different subset of the dialog than the others - which is the way a
   * settings dialog usually starts losing edits.
   */
  const saveEverything = async () => {
    // The additional packages, checked first: nothing is saved from a dialog
    // that is about to be rejected, so the stored config never holds a
    // combination the two rules below already refuse.
    //
    // Only the two rules this application owns - a package it declares itself,
    // and the same package twice. Whether a version exists, whether a
    // combination resolves, whether a URL is reachable: all uv's to answer, and
    // it answers better than a guess made here would.
    const custom = document.getElementById("settings-custom").value;
    const problems = findProblems(parseRequirements(custom), DECLARED);
    const report = document.getElementById("settings-custom-problems");
    if (problems.length > 0) {
      report.innerHTML = problems.map((line) => escapeHtml(line)).join("<br>");
      report.hidden = false;
      report.classList.add("settings-problem");
      showTab("packages");
      document.getElementById("settings-custom").focus();
      return false;
    }
    report.hidden = true;

    // Refused rather than rounded, and reported where it was typed. A line
    // length that silently became something else would be a dialog answering a
    // question the user is still in the middle of asking.
    const typedLength = document.getElementById("settings-line-length").value;
    const lengthProblem = lineLengthProblem(typedLength);
    const editorReport = document.getElementById("settings-editor-problems");
    editorReport.hidden = lengthProblem === null;
    editorReport.textContent = lengthProblem ?? "";
    editorReport.classList.toggle("settings-problem", lengthProblem !== null);
    if (lengthProblem !== null) {
      showTab("editor");
      document.getElementById("settings-line-length").focus();
      return false;
    }

    // Both take effect on the next format rather than needing anything told
    // about them - the length is read when a request is built, and the ruler
    // when the editor is created. A window already open keeps the old ruler
    // until it is restarted, which is worth knowing and not worth a reload.
    if (usableLineLength(typedLength) !== formatLineLength()) {
      await setSetting(LINE_LENGTH_KEY, usableLineLength(typedLength));
    }

    const onSave = document.getElementById("settings-format-on-save").checked;
    if (onSave !== formatOnSave()) {
      await setSetting(FORMAT_ON_SAVE_KEY, onSave);
    }

    const template = document.getElementById("settings-new-template").value;
    if (template !== newFileTemplate()) {
      await setSetting(NEW_FILE_TEMPLATE_KEY, template);
    }

    // Read by the next session rather than the one running, which is honest:
    // the adapter is told at attach and there is no way to change its mind.
    const stepIntoMine = document.getElementById("settings-just-my-code").checked;
    if (stepIntoMine !== justMyCode()) {
      await setSetting(JUST_MY_CODE_KEY, stepIntoMine);
    }

    // Takes effect at the next stop rather than the next session: it is
    // evaluated when execution pauses, so there is nothing to reconfigure.
    const onStop = document.getElementById("settings-on-stop").value.trim();
    if (onStop !== onStopExpression()) {
      await setSetting(ON_STOP_KEY, onStop);
    }

    const atBreakpointsOnly = document.getElementById("settings-on-stop-breakpoints").checked;
    if (atBreakpointsOnly !== onStopBreakpointsOnly()) {
      await setSetting(ON_STOP_BREAKPOINTS_ONLY_KEY, atBreakpointsOnly);
    }

    const chosen = {};
    const paths = {};
    for (const p of PACKAGES) {
      const picked = overlay.querySelector(`input[name="src-${p.name}"]:checked`);
      chosen[p.name] = picked === null ? PYPI : picked.value;
      paths[p.name] = document.getElementById(`local-${p.name}`).value.trim();
    }
    await savePackageSources(chosen);
    await saveLocalPaths(paths);
    await saveCustomPackages(custom);

    // A command back on its shipped chords is stored as *absent* rather than as
    // a copy of the defaults, so a later release that moves a default moves it
    // for everyone who never changed it.
    let chordsChanged = false;
    for (const command of COMMANDS) {
      const wanted = chords[command.id];
      if (wanted.join(",") === chordsFor(command.id).join(",")) {
        continue;
      }
      const isDefault = wanted.join(",") === defaultChordsFor(command.id).join(",");
      await setChordsFor(command.id, isDefault ? null : wanted);
      chordsChanged = true;
    }
    if (chordsChanged) {
      // The editor holds the old chords until its actions are registered again,
      // and the menu and the toolbar each carry their own copy of the text.
      rebindRunActions();
      refreshToolbarTitles();
      await refreshMenu();
    }
    return true;
  };

  // Apply saves and closes. It does not touch the environment.
  //
  // That split is the whole point of the two buttons above: choosing packages
  // and installing them were one action, and it was not obvious which of the
  // two pressing Apply was going to do - nor that it might take a minute and
  // restart the kernel. Saving without installing is coherent because startup
  // reconciles anyway: ensureEnvironment runs uv sync on every launch, so a
  // saved-but-not-installed change simply lands at the next start.
  document.getElementById("settings-apply").addEventListener("click", async () => {
    if (await saveEverything()) {
      close();
    }
  });

  // Install and Upgrade act on the environment and come back here afterwards.
  // Only Apply and Cancel close the dialog.
  document.getElementById("settings-install").addEventListener("click", async () => {
    if (await saveEverything()) {
      await installPackages();
    }
  });

  for (const p of PACKAGES) {
    document.getElementById(`reinstall-${p.name}`).addEventListener("click", async () => {
      if (await saveEverything()) {
        await reinstall(p.name);
      }
    });
  }

  document.getElementById("settings-upgrade").addEventListener("click", async () => {
    if (await saveEverything()) {
      await upgradeAndResync();
    }
  });
}
