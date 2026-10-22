// File > Import…: a CAD file into a variable, through build123d's importer.
//
// One workflow in three steps, the Export dialog's shape run the other way:
// the open dialog asks for the file, this dialog for the variable's name and
// the importer's options - read from its own signature by the kernel, see
// kernel/build123d_studio/importing.py - and then the assignment and a show()
// of the result run in the console. Ticked, a box puts the import statement
// alone into the open file at the caret - no show(), and an import line only
// for what the file does not already import. Cancelling either dialog ends it.

import { os } from "@neutralinojs/lib";

import * as ipc from "../ipc.js";
import { currentFolder } from "./files.js";
import { bufferText, caretPosition, execute, hasBuffer, insertBlockAtCaret } from "./monaco.js";
import { afterNativeDialog } from "../nativedialog.js";
import { getSetting, setSetting } from "../store.js";
import { problems } from "../signatureform.js";
import { escapeHtml, optionRows, readControl, startingValues } from "../signaturecontrols.js";
import {
  bufferLines,
  defaultVariableName,
  importCode,
  importFilters,
  variableProblem,
} from "./importcode.js";
import { importerFor } from "./importfile.js";

// The options per format, so the next import of an STL starts where the last
// one ended: { values: { STL: { model_unit: "IN" } } }. The variable name is
// not remembered - it comes from the file.
export const IMPORT_KEY = "importDialog";

// The controls' ids: import-option-model_unit and so on.
const PREFIX = "import-option-";

// See the Export dialog's: the inspection lane may be behind a slow listing.
const FORMS_TIMEOUT = 20000;

let open = false;

function remembered() {
  const stored = getSetting(IMPORT_KEY);
  if (typeof stored !== "object" || stored === null) {
    return {};
  }
  return typeof stored.values === "object" && stored.values !== null ? stored.values : {};
}

function baseName(path) {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Step one: the file. Then the dialog, unless the open dialog was cancelled. */
export async function importFile() {
  if (open) {
    return;
  }
  // Taken now, so the code goes where the user was when they chose Import,
  // whatever happens to the caret while the two dialogs are up.
  const caret = caretPosition();
  const folder = currentFolder() ?? (await os.getPath("documents"));
  let entries = [];
  try {
    entries = await os.showOpenDialog("Import a CAD file", {
      defaultPath: folder,
      filters: importFilters(),
      multiSelections: false,
    });
  } finally {
    afterNativeDialog();
  }
  if (!Array.isArray(entries) || entries.length !== 1) {
    return; // cancelled: the import ends here
  }
  await showImportDialog(entries[0], caret);
}

/**
 * Step two: the name and the options. Step three runs from its Import button.
 *
 * @param {string} path the chosen file
 * @param {{lineNumber: number, column: number}|null} caret where the caret was
 *   before the open dialog, for the code the box puts into the buffer
 */
async function showImportDialog(path, caret) {
  open = true;
  const overlay = document.createElement("div");
  overlay.id = "import-dialog";
  overlay.className = "info-overlay";
  overlay.innerHTML = `
    <div class="info-panel export-panel" role="dialog" aria-label="Import">
      <div class="info-header">
        <span class="info-title">Import ${escapeHtml(baseName(path))}</span>
      </div>
      <div class="info-body">
        <p class="info-note" id="import-status">Reading the import options…</p>
        <div id="import-form" hidden>
          <label class="settings-viewer-row">
            <span class="settings-viewer-name">Variable name</span>
            <input type="text" id="import-variable" spellcheck="false" />
          </label>
          <div id="import-options"></div>
          <label class="settings-check" id="import-insert-row">
            <input type="checkbox" id="import-insert" />
            <span>Add import code at cursor position</span>
          </label>
          <p class="info-note settings-problem" id="import-problems" hidden></p>
        </div>
        <div class="settings-actions">
          <button class="settings-btn" id="import-cancel">Cancel</button>
          <button class="settings-btn settings-btn-primary" id="import-run" disabled>Import</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    open = false;
  };
  // Capture, so Monaco and xterm cannot take Escape first.
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.querySelector("#import-cancel").addEventListener("click", close);

  const status = overlay.querySelector("#import-status");
  const importer = importerFor(path);
  if (importer === null) {
    status.textContent = `${baseName(path)} is not a file build123d imports: BREP, DXF, STEP, STL or SVG.`;
    return;
  }

  const reply = await ipc.request("import.forms", {}, { timeout: FORMS_TIMEOUT });
  if (!open) {
    return; // cancelled while the kernel was being asked
  }
  const forms = Array.isArray(reply?.forms) ? reply.forms : null;
  const form = forms?.find((entry) => entry.function === importer) ?? null;
  if (forms === null) {
    status.textContent = "The import options could not be read from the kernel. Try again once it is idle.";
    return;
  }
  if (form === null || form.available !== true) {
    status.textContent = `The installed build123d has no ${importer}.`;
    return;
  }
  status.hidden = true;
  overlay.querySelector("#import-form").hidden = false;

  const stored = remembered();
  const values = startingValues(form, stored[form.format]);
  overlay.querySelector("#import-options").innerHTML = optionRows(form, values, PREFIX);
  // Unticked every time, and offered only with a file to put the code into.
  const insert = overlay.querySelector("#import-insert");
  insert.disabled = !hasBuffer() || caret === null;
  if (insert.disabled) {
    overlay.querySelector("#import-insert-row").title = "No file is open.";
  }
  const variable = overlay.querySelector("#import-variable");
  variable.value = defaultVariableName(path);
  variable.focus();
  variable.select();

  const run = overlay.querySelector("#import-run");
  run.disabled = false;
  run.addEventListener("click", async () => {
    for (const option of form.options) {
      const value = readControl(option, PREFIX);
      if (value !== undefined && option.kind !== "fixed") {
        values[option.name] = value;
      }
    }
    const name = variable.value.trim();
    const found = [variableProblem(name), ...problems(form, values)].filter((text) => text !== null);
    const report = overlay.querySelector("#import-problems");
    if (found.length > 0) {
      report.textContent = found.join(" ");
      report.hidden = false;
      return;
    }

    await setSetting(IMPORT_KEY, { values: { ...stored, [form.format]: values } });
    close();
    if (insert.checked && !insert.disabled) {
      // The import statement alone; the console's run below also shows it and
      // always carries every import.
      insertBlockAtCaret(bufferLines(form, name, path, values, bufferText()), caret);
    }
    for (const code of importCode(form, name, path, values)) {
      execute(code);
    }
  });
}
