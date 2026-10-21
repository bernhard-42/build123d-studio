// The Import dialog's line of Python: a file, a name and options in, the
// assignment out.
//
// Separate from importdialog.js so it can be tested under `node --test`. The
// options and their arguments are signatureform.js's, shared with Export; the
// importer for a file is importfile.js's, shared with the file tree's Show.

import { passedArguments, pythonString } from "../signatureform.js";
import { importExtensions } from "./importfile.js";

// Python's hard keywords, which cannot be assigned to. The soft ones - match,
// case, type, _ - are ordinary names outside their statements.
const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally", "for",
  "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
  "pass", "raise", "return", "try", "while", "with", "yield",
]);

// Close to Python's rule for an identifier: a letter or _ first, then letters,
// digits and _. Python also takes a few combining marks this does not, which
// costs nothing but a name nobody types.
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

function baseName(path) {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * The name the dialog suggests: the file's, made into a Python name.
 *
 * `frame-v2.step` becomes `frame_v2`. Never one starting with `_`, which the
 * variable explorer does not list, so a name starting with a digit gets
 * `shape_` in front instead.
 */
export function defaultVariableName(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  let variable = stem.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+/, "");
  if (variable === "") {
    return "imported";
  }
  if (/^\p{N}/u.test(variable)) {
    variable = `shape_${variable}`;
  }
  return KEYWORDS.has(variable) ? `${variable}_` : variable;
}

/** What is wrong with a variable name, or null when Python takes it. */
export function variableProblem(name) {
  if (name === "") {
    return "A variable name is needed.";
  }
  if (!IDENTIFIER.test(name)) {
    return `${name} is not a Python name: letters, digits and _, and not a digit first.`;
  }
  if (KEYWORDS.has(name)) {
    return `${name} is a Python keyword.`;
  }
  return null;
}

/**
 * The two lines the kernel runs, as two executes - see importfile.js's
 * importCode for why the comment is a request of its own: its echo is on
 * screen while OCCT reads a large file.
 *
 * @param {object} form the importer's entry from the kernel
 * @param {string} variable what the result is assigned to, checked first
 * @param {string} path the file
 * @param {Record<string, unknown>} values the dialog's values, checked first
 * @returns {string[]}
 */
export function importCode(form, variable, path, values) {
  const { args, enums } = passedArguments(form, values);
  const imports = [form.function, ...enums];
  return [
    `# Importing ${baseName(path)} as ${variable} ...`,
    [
      `from build123d import ${imports.join(", ")}`,
      `${variable} = ${form.function}(${[pythonString(path), ...args].join(", ")})`,
    ].join("\n"),
  ];
}

/** The open dialog's filters: everything build123d imports, then anything. */
export function importFilters() {
  return [
    { name: "CAD files", extensions: importExtensions() },
    { name: "All files", extensions: ["*"] },
  ];
}
