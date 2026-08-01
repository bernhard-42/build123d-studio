// Where the application keeps its Python environment, for the test runners.
//
// This mirrors src/bootstrap/envroot.js rather than importing it: that module is
// part of the frontend bundle and reaches for Neutralino's os.getPath, which does
// not exist in node. What is shared is the *policy* - one statement of it per
// platform - and both test runners now read it from here instead of carrying a
// copy each.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR_NAME = "build123d-studio";

/**
 * The per-user data directory, matching Neutralino's os.getPath("data").
 *
 * Windows is Roaming rather than Local: %APPDATA%, which is what the shipped
 * application actually uses - confirmed against its own logs, which name
 * C:\Users\<user>\AppData\Roaming\build123d-studio\runtime.
 */
export function appDataDir() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(roaming, APP_DIR_NAME);
  }
  const share = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(share, APP_DIR_NAME);
}

export function envRoot() {
  return join(appDataDir(), "runtime");
}

export function venvPython(root) {
  return process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python");
}

/**
 * The interpreter both test runners need, or a message saying which problem it is.
 *
 * The distinction is the whole point: "this is broken" and "there is nothing
 * here yet" are different answers, and exit code 2 says the second one so a CI
 * job can tell them apart without reading the text.
 */
export function requirePython() {
  const root = envRoot();
  const python = venvPython(root);
  if (!existsSync(python)) {
    console.error(`No Python environment at ${root}.`);
    console.error("Start the application once so it builds one, then run this again.");
    process.exit(2);
  }
  return { envRoot: root, python };
}
