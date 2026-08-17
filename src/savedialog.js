// Where "Save As" gets its dialog, and why one platform needs its own.
//
// Neutralino's os.showSaveDialog is AppleScript underneath: on macOS it shells
// out to `osascript` and runs `choose file name`. That command takes the folder
// and the file name as two independent parameters - `default location` and
// `default name` - but the API in front of it has one string, `defaultPath`, and
// picks between them by looking at what it was given: a directory becomes the
// location, anything else becomes the name. A Save As passes the file being
// saved, so the whole path went into the name field and the panel opened asking
// whether to save a file called "/Users/bernhard/Desktop/test/notes.py".
//
// One string cannot say both things, so nothing passed through that parameter
// can fix it. The script is therefore ours on macOS, where AppleScript is
// perfectly willing to be told both. Windows and Linux keep Neutralino's dialog:
// a full path is the right thing to hand each of those, and they split it
// themselves.
//
// Injected `os` and `log` rather than imported ones, for safewrite.js's reason:
// it makes the script that is built - the part with the quoting in it - testable
// from node, where no webview exists.

import { quoteFor } from "./quoting.js";

// What AppleScript's cancel is. `choose file name` raises rather than returning
// nothing when the panel is dismissed, and -128 ("User canceled") is the number
// every Standard Additions dialog raises for it.
const CANCELLED = -128;

/**
 * Escape a value for inclusion in an AppleScript double-quoted string.
 *
 * Backslash first, or the escape added for a quote would itself be escaped by
 * the pass that follows it. Nothing else is special inside AppleScript's string
 * literals, which is why there is no third case.
 */
export function quoteApplescript(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`);
}

/**
 * The AppleScript for a save panel, as one line per element.
 *
 * Both placement parameters are optional and independent: a Save As has a name
 * and a folder, a new file has only a folder to open in. Omitting `name` leaves
 * the field empty, which is what "save this untitled thing somewhere" means.
 *
 * `default location` wants an alias, which is AppleScript for "a folder that
 * exists" - hence the coercion, and hence the caller checking. A path that is
 * not there raises, and the panel never opens.
 *
 * The cancel branch is what makes this a dialog rather than an error: it answers
 * with an empty line, which is exactly what os.showSaveDialog returns when
 * somebody presses Cancel, so the caller has one contract to read either way.
 *
 * @param {{title: string, name: string|null, folder: string|null}} placement
 * @returns {string[]}
 */
export function saveScript({ title, name, folder }) {
  let ask = `set chosen to choose file name with prompt "${quoteApplescript(title)}"`;
  if (typeof name === "string" && name !== "") {
    ask += ` default name "${quoteApplescript(name)}"`;
  }
  if (typeof folder === "string" && folder !== "") {
    ask += ` default location (POSIX file "${quoteApplescript(folder)}" as alias)`;
  }
  return [
    "try",
    ask,
    "POSIX path of chosen",
    `on error number ${CANCELLED}`,
    `return ""`,
    "end try",
  ];
}

/**
 * The command that runs those lines.
 *
 * One `-e` per line rather than one argument with newlines in it, because that
 * is the form osascript documents, and every one of them is shell-quoted -
 * `title` is ours but `folder` and `name` come from a file on somebody's disk.
 * The quoting is quoting.js's, tested, and this branch only ever runs on macOS,
 * which is why it may name Darwin outright.
 */
export function saveCommand(lines) {
  const arguments_ = lines.map((line) => `-e ${quoteFor("Darwin", line)}`).join(" ");
  return `osascript ${arguments_}`;
}

/**
 * A folder and a name back into one path, for the platforms that want it that way.
 *
 * The separator comes from the folder rather than from a constant, because these
 * two halves came from splitting a path that a Windows machine may have written
 * with backslashes - and rebuilding it with "/" would hand its dialog
 * `C:\\parts/notes.py`. Accepted there, but a needless difference from the
 * string the application was given.
 */
function joined(folder, name) {
  if (typeof folder !== "string" || folder === "") {
    return name;
  }
  const separator = folder.includes("\\") ? "\\" : "/";
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`;
}

/**
 * What osascript said, as a path.
 *
 * Exactly one trailing newline is removed, and with a regular expression rather
 * than trim(): a trailing space is legal in a macOS file name, and trim() would
 * quietly save to a different file from the one that was named.
 */
export function pathFromOutput(stdOut) {
  return String(stdOut ?? "").replace(/\r?\n$/, "");
}

/**
 * Ask for a name to save under.
 *
 * @param {{os: object, log: object, platform: string}} services
 * @param {string} title
 * @param {{folder: string|null, name: string|null, filters: object[]|undefined}} placement
 * @returns {Promise<string>} the chosen path, or "" for cancel.
 */
export async function chooseSaveName({ os, log, platform }, title, { folder, name, filters }) {
  const named = typeof name === "string" && name !== "";

  if (platform !== "Darwin") {
    // Unchanged from what this always did, and correct on both: a Win32 save
    // dialog splits a full path into its folder and its name, and zenity's
    // --filename does the same.
    const defaultPath = named ? joined(folder, name) : (folder ?? undefined);
    const answered = await os.showSaveDialog(title, { defaultPath, filters });
    return typeof answered === "string" ? answered : "";
  }

  // Deliberately without `filters`: `choose file name` has no type parameter to
  // give them to. Nothing is lost, because Neutralino's own dialog does not
  // apply them here either - typing a name with no extension into it produces a
  // file with no extension, which is why saveBuffer adds .py afterwards.
  const command = saveCommand(saveScript({ title, name: named ? name : null, folder }));
  let result;
  try {
    result = await os.execCommand(command);
  } catch (error) {
    log.warn("Could not run the save panel, falling back to the built-in dialog:", error);
    result = null;
  }

  if (result === null || result.exitCode !== 0) {
    // A folder that has been deleted since it was remembered is the way this
    // is reached: `as alias` raises on it and the panel never opens. Falling
    // back rather than failing, because a save that cannot be asked about is a
    // save that is lost - and Neutralino's dialog, name field and all, is still
    // a dialog.
    if (result !== null) {
      log.warn(`The save panel exited ${result.exitCode}: ${result.stdErr}`);
    }
    const defaultPath = named ? joined(folder, name) : (folder ?? undefined);
    const answered = await os.showSaveDialog(title, { defaultPath, filters });
    return typeof answered === "string" ? answered : "";
  }

  return pathFromOutput(result.stdOut);
}
