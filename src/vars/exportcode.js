// The Export dialog's arithmetic: values in, a line of Python out.
//
// Split from exportdialog.js so it can be tested under `node --test`, where no
// DOM exists. Nothing here touches the page or the kernel.
//
// A form is one entry of the kernel's answer - see
// kernel/build123d_studio/exporting.py - and its options are in one of five
// kinds: bool, number, enum, text and fixed. A value is what a control holds:
// a boolean, the number field's string, an enum member's name, or the text
// field's string.

/**
 * A Python string literal for any JavaScript string.
 *
 * JSON's escapes are a subset of Python's - \" \\ \n \t \uXXXX and the rest -
 * so a JSON string is also a Python string, Windows backslashes included.
 */
export function pythonString(text) {
  return JSON.stringify(String(text));
}

/** The control's value as the form's kind holds it, from what the kernel sent. */
export function defaultValue(option) {
  switch (option.kind) {
    case "bool":
      return option.default === true;
    case "number":
      return String(option.default);
    case "text":
      return option.default === null ? "" : String(option.default);
    default:
      return option.default;
  }
}

/**
 * Whether a value still fits its option - for values remembered from an
 * earlier export, which a different build123d may no longer accept.
 */
export function fits(option, value) {
  switch (option.kind) {
    case "bool":
      return typeof value === "boolean";
    case "number":
      return typeof value === "string";
    case "enum":
      return typeof value === "string" && option.choices.includes(value);
    case "text":
      return typeof value === "string";
    default:
      return false;
  }
}

/**
 * What is wrong with the values, one sentence per option, or [] when nothing.
 *
 * Only numbers can be wrong: a checkbox, a dropdown and a text field cannot
 * hold anything their kind refuses.
 */
export function problems(form, values) {
  const found = [];
  for (const option of form.options) {
    if (option.kind !== "number") {
      continue;
    }
    const text = String(values[option.name] ?? "").trim();
    const number = Number(text);
    if (text === "" || !Number.isFinite(number)) {
      found.push(`${option.name} needs a number.`);
    } else if (option.integer === true && !Number.isInteger(number)) {
      found.push(`${option.name} needs a whole number.`);
    }
  }
  return found;
}

/** The value as Python source, for an option it has been checked against. */
function pythonValue(option, value) {
  switch (option.kind) {
    case "bool":
      return value === true ? "True" : "False";
    case "number":
      return String(Number(String(value).trim()));
    case "enum":
      return `${option.enum}.${value}`;
    case "text":
      return option.optional === true && value === "" ? "None" : pythonString(value);
    default:
      return null;
  }
}

/** Whether a value says anything its default does not. */
function changed(option, value) {
  if (option.kind === "fixed") {
    return false;
  }
  if (option.kind === "number") {
    return Number(String(value).trim()) !== Number(option.default);
  }
  return value !== defaultValue(option);
}

/**
 * The code Export runs: the call, and a sentence either way.
 *
 * Only the options that differ from their defaults are passed, so the line says
 * what was chosen rather than restating build123d. The imports are the function
 * and any enum class a passed option needs - from build123d, which is where
 * the kernel found them. `if`/`else` because the functions answer with a bool:
 * a bare call would leave a failed export as a lone `False` in the console.
 *
 * @param {object} form the format's entry from the kernel
 * @param {string} expression what is exported: `bracket`, or `bp.part`
 * @param {string} path where it is written
 * @param {Record<string, unknown>} values the dialog's values, checked first
 */
export function exportCode(form, expression, path, values) {
  const passed = [];
  const imports = [form.function];
  for (const option of form.options) {
    const value = values[option.name];
    if (!changed(option, value)) {
      continue;
    }
    passed.push(`${option.name}=${pythonValue(option, value)}`);
    if (option.kind === "enum" && !imports.includes(option.enum)) {
      imports.push(option.enum);
    }
  }

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
