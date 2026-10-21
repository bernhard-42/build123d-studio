// The Export and Import dialogs' values, and the arguments they become.
//
// Separate from the dialogs so it can be tested under `node --test`, where no
// DOM exists. Nothing here touches the page or the kernel.
//
// A form is one entry of the kernel's answer - see
// kernel/build123d_studio/signatures.py - and its options are in one of five
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
 * The keyword arguments for the options that differ from their defaults.
 *
 * Only those, so a call says what was chosen rather than restating build123d.
 * `enums` names the enum classes the arguments use, which the call's import
 * line has to bring in.
 *
 * @returns {{args: string[], enums: string[]}}
 */
export function passedArguments(form, values) {
  const args = [];
  const enums = [];
  for (const option of form.options) {
    const value = values[option.name];
    if (!changed(option, value)) {
      continue;
    }
    args.push(`${option.name}=${pythonValue(option, value)}`);
    if (option.kind === "enum" && !enums.includes(option.enum)) {
      enums.push(option.enum);
    }
  }
  return { args, enums };
}
