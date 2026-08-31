// Where the application keeps its Python environment, for the test runners.
//
// The *decision* is imported from src/bootstrap/envpath.js, which is pure for
// exactly this reason - what cannot be imported is src/bootstrap/envroot.js,
// which is part of the frontend bundle and reaches for Neutralino's os.getPath.
// This file supplies what that decision needs from node: the data directory,
// %LOCALAPPDATA%, and the platform under node's own spelling of it.
//
// Two statements of one policy is what this arrangement removes. It used to be
// two, and the day the application moved its Windows environment to
// %LOCALAPPDATA% the test runners would have gone on looking in Roaming and
// reported that there was no environment at all.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ENV_ROOT_VARIABLE, chooseEnvRoot, envRootProblem } from "../src/bootstrap/envpath.js";

const APP_DIR_NAME = "build123d-studio";

/**
 * The per-user data directory, matching Neutralino's os.getPath("data").
 *
 * Windows is Roaming rather than Local: %APPDATA%, which is what the shipped
 * application actually uses - confirmed against its own logs, which name
 * C:\Users\<user>\AppData\Roaming\build123d-studio. The settings, the snippets
 * and the log are still there; the environment is not, and that is envRoot's
 * business rather than this function's.
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

/**
 * The environment the application would build, under the same three rules it
 * uses - the override included, so the suites can be run on a machine where the
 * default location is not usable.
 */
export function envRoot() {
  const override = process.env[ENV_ROOT_VARIABLE] ?? null;
  if (override !== null && override.trim() !== "") {
    const problem = envRootProblem(override);
    if (problem !== null) {
      console.error(problem);
      process.exit(2);
    }
  }
  return chooseEnvRoot({
    override,
    dataDir: appDataDir(),
    localAppData: process.env.LOCALAPPDATA ?? null,
    platform: process.platform === "win32" ? "Windows" : "Other",
    appName: APP_DIR_NAME,
  }).path;
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
