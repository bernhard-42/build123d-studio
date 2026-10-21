// The option controls the Export and Import dialogs draw from a form.
//
// One row per option, the Settings Viewer tab's layout: the name on the left
// with the docstring's line as its tooltip, the control on the right. Ids are
// `<prefix><option name>`, so each dialog keeps its own.

import { defaultValue, fits } from "./signatureform.js";

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A format's starting values: remembered where they still fit, else defaults. */
export function startingValues(form, stored) {
  const values = {};
  for (const option of form.options) {
    const kept = stored?.[option.name];
    values[option.name] = kept !== undefined && fits(option, kept) ? kept : defaultValue(option);
  }
  return values;
}

function controlFor(option, value, prefix) {
  const id = `${prefix}${option.name}`;
  switch (option.kind) {
    case "bool":
      return `<input type="checkbox" id="${id}" ${value === true ? "checked" : ""} />`;
    case "number":
      return `<input type="text" inputmode="decimal" id="${id}" value="${escapeHtml(value)}" />`;
    case "enum":
      return `<select id="${id}">${option.choices
        .map((choice) => `<option value="${escapeHtml(choice)}" ${choice === value ? "selected" : ""}>${escapeHtml(choice)}</option>`)
        .join("")}</select>`;
    case "text":
      return `<input type="text" id="${id}" value="${escapeHtml(value)}"
                     placeholder="${option.optional === true ? "None" : ""}" spellcheck="false" />`;
    default:
      // Shown so nothing is hidden, and left at its default because the dialog
      // could not write anything else back as Python.
      return `<input type="text" id="${id}" value="${escapeHtml(option.default)}" disabled />`;
  }
}

/** What a control holds now, or undefined when it is not on the page. */
export function readControl(option, prefix) {
  const element = document.getElementById(`${prefix}${option.name}`);
  if (element === null) {
    return undefined;
  }
  if (option.kind === "bool") {
    return element.checked;
  }
  return element.value;
}

/** The rows for a form's options, or a line saying the function has none. */
export function optionRows(form, values, prefix) {
  if (form.options.length === 0) {
    return `<p class="info-note">${escapeHtml(form.function)} has no options.</p>`;
  }
  return form.options
    .map((option) => `
      <label class="settings-viewer-row" title="${escapeHtml(option.doc ?? "")}">
        <span class="settings-viewer-name">${escapeHtml(option.name)}</span>
        ${controlFor(option, values[option.name], prefix)}
      </label>`)
    .join("");
}
