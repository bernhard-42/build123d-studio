// The Export dialog's line of Python: values in, the call out.
//
// Separate from exportdialog.js so it can be tested under `node --test`. The
// values and the arguments they become are signatureform.js's, shared with the
// Import dialog.

import { passedArguments, pythonString } from "../signatureform.js";

/**
 * The code Export runs: the call, and a sentence either way.
 *
 * Only the options that differ from their defaults are passed - see
 * passedArguments. The imports are the function and any enum class a passed
 * option needs - from build123d, which is where the kernel found them. `if`/`else` because the functions answer with a bool:
 * a bare call would leave a failed export as a lone `False` in the console.
 *
 * @param {object} form the format's entry from the kernel
 * @param {string} expression what is exported: `bracket`, or `bp.part`
 * @param {string} path where it is written
 * @param {Record<string, unknown>} values the dialog's values, checked first
 */
export function exportCode(form, expression, path, values) {
  const { args: passed, enums } = passedArguments(form, values);
  const imports = [form.function, ...enums];

  const target = pythonString(path);
  const args = [expression, target, ...passed].join(", ");
  return [
    `from build123d import ${imports.join(", ")}`,
    `if ${form.function}(${args}):`,
    `    print(${pythonString(`Exported ${expression} to ${path}`)})`,
    "else:",
    `    print(${pythonString(`${form.function} returned False: ${path} was not written`)})`,
  ].join("\n");
}

/**
 * The name the save panel suggests: the variable, with the format's extension.
 *
 * The variable's name rather than the expression, so a builder `bp` suggests
 * `bp.step`, not `bp.part.step`.
 */
export function suggestedName(name, form) {
  return `${name}${form.extension}`;
}

/** The save panel's filters, where the platform's panel takes them - as Save's. */
export function filtersFor(form) {
  return [
    { name: form.format, extensions: [form.extension.replace(/^\./, "")] },
    { name: "All files", extensions: ["*"] },
  ];
}
