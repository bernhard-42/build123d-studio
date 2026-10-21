// The variable explorer's Export dialog.
//
// One format at a time, chosen from a dropdown, with that format's options drawn
// from build123d's own export_* signature - the kernel reads it, see
// kernel/build123d_studio/exporting.py - and Export asking for the file last.
//
// Two steps of one workflow: Export closes this dialog and opens the save
// panel, and cancelling either step ends the export - nothing asks twice.
// What runs is a line of Python echoed into the console like Show's, so the
// export can be copied into a script; exportcode.js writes it.
//
// The name chosen in the save panel is taken as typed, as Save takes it - see
// saveBuffer in editor/files.js. The panel asks before replacing a file and can
// only ask about the name it was given, so an extension appended afterwards
// would write to a file it never warned about. The suggested name carries the
// extension already.

import { os } from "@neutralinojs/lib";

import * as ipc from "../ipc.js";
import * as log from "../log.js";
import { currentFolder } from "../editor/files.js";
import { execute } from "../editor/monaco.js";
import { afterNativeDialog } from "../nativedialog.js";
import { chooseSaveName } from "../savedialog.js";
import { getSetting, setSetting } from "../store.js";
import { problems } from "../signatureform.js";
import { escapeHtml, optionRows, readControl, startingValues } from "../signaturecontrols.js";
import { exportCode, filtersFor, suggestedName } from "./exportcode.js";

// The controls' ids: export-option-unit and so on.
const PREFIX = "export-option-";

// The last format and the values per format, so the next export starts where
// the last one ended: { format: "STEP", values: { STEP: { unit: "IN" } } }.
export const EXPORT_KEY = "exportDialog";

// Reading signatures is quick, but the inspection lane may be behind a slow
// variable listing; the sidecar's own inspection budget is the longer wait.
const FORMS_TIMEOUT = 20000;

// One line under the dropdown for the two formats that cannot hold an
// assembly's structure - measured: one mesh, no names, no colours.
const NOTES = {
  STL: "STL stores one mesh: an assembly is flattened, without names or colours.",
  OBJ: "OBJ is written as one mesh: an assembly is flattened, without names or colours.",
};

let open = false;

/** What was remembered, made safe to read whatever settings.json holds. */
function remembered() {
  const stored = getSetting(EXPORT_KEY);
  if (typeof stored !== "object" || stored === null) {
    return { format: null, values: {} };
  }
  const values = typeof stored.values === "object" && stored.values !== null ? stored.values : {};
  const format = typeof stored.format === "string" ? stored.format : null;
  return { format, values };
}

/**
 * Ask the kernel for the formats, then show the dialog for one variable.
 *
 * @param {{name: string, expression: string}} target the row's variable, and
 *   what is exported for it - the name itself, or `bp.part` for a builder
 */
export async function openExportDialog(target) {
  // One at a time: a second right-click while the first is up is ignored
  // rather than stacking dialogs that share element ids.
  if (open) {
    return;
  }
  open = true;

  const overlay = document.createElement("div");
  overlay.id = "export-dialog";
  overlay.className = "info-overlay";
  overlay.innerHTML = `
    <div class="info-panel export-panel" role="dialog" aria-label="Export">
      <div class="info-header">
        <span class="info-title">Export ${escapeHtml(target.expression)}</span>
      </div>
      <div class="info-body">
        <p class="info-note" id="export-status">Reading the export options…</p>
        <div id="export-form" hidden>
          <label class="settings-viewer-row">
            <span class="settings-viewer-name">Format</span>
            <select id="export-format"></select>
          </label>
          <p class="info-note" id="export-note" hidden></p>
          <div id="export-options"></div>
          <p class="info-note settings-problem" id="export-problems" hidden></p>
        </div>
        <div class="settings-actions">
          <button class="settings-btn" id="export-cancel">Cancel</button>
          <button class="settings-btn settings-btn-primary" id="export-run" disabled>Export</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    open = false;
  };
  // Capture, so Monaco and xterm cannot take Escape first - the same reason as
  // the confirmation dialog's.
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.querySelector("#export-cancel").addEventListener("click", close);

  const reply = await ipc.request("export.forms", {}, { timeout: FORMS_TIMEOUT });
  if (!open) {
    return; // cancelled while the kernel was being asked
  }
  const forms = Array.isArray(reply?.forms) ? reply.forms : null;
  const status = overlay.querySelector("#export-status");
  if (forms === null || !forms.some((form) => form.available === true)) {
    status.textContent = forms === null
      ? "The export options could not be read from the kernel. Try again once it is idle."
      : "The installed build123d has none of the export functions.";
    return;
  }
  status.hidden = true;
  overlay.querySelector("#export-form").hidden = false;

  const stored = remembered();
  // Every format's values, kept while the dialog is open, so switching back
  // and forth does not lose what was typed.
  const valuesByFormat = new Map();
  for (const form of forms) {
    if (form.available === true) {
      valuesByFormat.set(form.format, startingValues(form, stored.values[form.format]));
    }
  }

  const select = overlay.querySelector("#export-format");
  select.innerHTML = forms
    .map((form) => {
      const label = form.available === true ? form.format : `${form.format} (not in this build123d)`;
      return `<option value="${escapeHtml(form.format)}" ${form.available === true ? "" : "disabled"}>${escapeHtml(label)}</option>`;
    })
    .join("");
  const firstAvailable = forms.find((form) => form.available === true).format;
  let current = valuesByFormat.has(stored.format) ? stored.format : firstAvailable;
  select.value = current;

  const formFor = (format) => forms.find((form) => form.format === format);

  const keepCurrent = () => {
    const form = formFor(current);
    const values = valuesByFormat.get(current);
    for (const option of form.options) {
      const value = readControl(option, PREFIX);
      if (value !== undefined && option.kind !== "fixed") {
        values[option.name] = value;
      }
    }
  };

  const render = () => {
    const form = formFor(current);
    const values = valuesByFormat.get(current);
    const note = overlay.querySelector("#export-note");
    note.textContent = NOTES[form.format] ?? "";
    note.hidden = note.textContent === "";
    const options = overlay.querySelector("#export-options");
    options.innerHTML = optionRows(form, values, PREFIX);
    overlay.querySelector("#export-problems").hidden = true;
  };

  select.addEventListener("change", () => {
    keepCurrent();
    current = select.value;
    render();
  });
  render();

  const run = overlay.querySelector("#export-run");
  run.disabled = false;
  run.addEventListener("click", async () => {
    keepCurrent();
    const form = formFor(current);
    const values = valuesByFormat.get(current);
    const found = problems(form, values);
    const report = overlay.querySelector("#export-problems");
    if (found.length > 0) {
      report.textContent = found.join(" ");
      report.hidden = false;
      return;
    }
    report.hidden = true;

    // Remembered now rather than after the panel: this dialog is gone once the
    // panel opens, so a cancel there would otherwise lose what was chosen here.
    const memory = { format: current, values: { ...stored.values } };
    for (const [format, kept] of valuesByFormat) {
      memory.values[format] = kept;
    }
    await setSetting(EXPORT_KEY, memory);

    // The dialog's step is done; the save panel is the next one.
    close();
    const folder = currentFolder() ?? (await os.getPath("documents"));
    let path = "";
    try {
      path = await chooseSaveName({ os, log, platform: NL_OS }, `Export ${form.format}`, {
        folder,
        name: suggestedName(target.name, form),
        filters: filtersFor(form),
      });
    } finally {
      afterNativeDialog();
    }
    if (typeof path !== "string" || path === "") {
      return; // closed in the panel: the export is cancelled
    }
    execute(exportCode(form, target.expression, path, values));
  });
}
