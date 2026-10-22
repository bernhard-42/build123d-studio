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

/** The assignment, and the build123d names it needs. */
function importParts(form, variable, path, values) {
  const { args, enums } = passedArguments(form, values);
  return {
    names: [form.function, ...enums],
    assignment: `${variable} = ${form.function}(${[pythonString(path), ...args].join(", ")})`,
  };
}

/**
 * The import itself: the assignment, then show() of what arrived.
 *
 * This is what the kernel runs, with every import it needs, whatever the
 * namespace already holds. The show passes the name, so the viewer's tree says
 * `frame` rather than `Solid` - as the explorer's Show does - and resets the
 * camera, because an imported model is at an unknown size and position - as
 * the file tree's Show does.
 *
 * @param {object} form the importer's entry from the kernel
 * @param {string} variable what the result is assigned to, checked first
 * @param {string} path the file
 * @param {Record<string, unknown>} values the dialog's values, checked first
 * @returns {string}
 */
export function importLines(form, variable, path, values) {
  const { names, assignment } = importParts(form, variable, path, values);
  return [
    `from build123d import ${names.join(", ")}`,
    "from build123d_studio import show, Camera",
    assignment,
    `show(${variable}, names=[${pythonString(variable)}], reset_camera=Camera.RESET)`,
  ].join("\n");
}

// `from build123d import ...` and `from build123d_studio import ...`, the names
// running to the end of the line, across a backslash continuation, or through
// a parenthesised list over several lines. build123d_studio is read as well so
// the answer is whole, though only build123d's names go into a buffer.
const FROM_IMPORT = /^[ \t]*from[ \t]+(build123d|build123d_studio)[ \t]+import[ \t]+(\([^)]*\)|(?:[^\n\\#]|\\\n)*)/gm;

/**
 * The names a buffer's own imports bind from build123d and build123d_studio.
 *
 * Read from the text, so it also works on a buffer that does not parse. An
 * alias binds the alias, not the name it renames; `*` binds everything the
 * module exports, which for build123d covers every importer and the enums
 * their options use - checked against its __all__.
 *
 * @param {string} source the buffer
 * @returns {Map<string, Set<string>>} module to bound names, "*" for a star
 */
export function importedNames(source) {
  const bound = new Map();
  for (const match of source.matchAll(FROM_IMPORT)) {
    const names = match[2]
      .replace(/#[^\n]*/g, "")
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const set = bound.get(match[1]) ?? new Set();
    for (const entry of names) {
      const alias = entry.match(/^\S+\s+as\s+(\S+)$/);
      set.add(alias === null ? entry.split(/\s+/)[0] : alias[1]);
    }
    bound.set(match[1], set);
  }
  return bound;
}

/**
 * The lines for the buffer: the import alone - the assignment, after an import
 * line for whatever build123d names the buffer does not already have. No
 * show(): that is the console's, for seeing what arrived; what goes into a
 * script is the statement that loads the file.
 *
 * @param {string} source the buffer the lines go into
 * @returns {string}
 */
export function bufferLines(form, variable, path, values, source) {
  const { names, assignment } = importParts(form, variable, path, values);
  const bound = importedNames(source).get("build123d") ?? new Set();
  const missing = bound.has("*") ? [] : names.filter((name) => !bound.has(name));
  return [...(missing.length > 0 ? [`from build123d import ${missing.join(", ")}`] : []), assignment].join("\n");
}

/**
 * What the kernel runs, as two executes: an announcing comment, then the
 * import. See importfile.js's importCode for why the comment is a request of
 * its own: its echo is on screen while OCCT reads a large file.
 *
 * @returns {string[]}
 */
export function importCode(form, variable, path, values) {
  return [`# Importing ${baseName(path)} as ${variable} ...`, importLines(form, variable, path, values)];
}

/** The open dialog's filters: everything build123d imports, then anything. */
export function importFilters() {
  return [
    { name: "CAD files", extensions: importExtensions() },
    { name: "All files", extensions: ["*"] },
  ];
}
