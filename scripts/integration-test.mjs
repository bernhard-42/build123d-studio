// Runner for tests/integration.py.
//
// The test needs three things it cannot work out for itself: where the
// application's Python environment is, which interpreter inside it to use, and
// where the repository is. Resolving those here rather than in the test mirrors
// how the application itself is arranged - src/bootstrap/envroot.js owns path
// policy and hands the sidecar an --env-root - so there is one statement of it
// per platform instead of two that can drift.
//
// It runs against the environment a real launch created, deliberately. An
// environment built specially for the test would be a different environment from
// the one that breaks, and the bugs this exists to catch were all in the seam
// between the application and its own runtime.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR_NAME = "build123d-studio";

/**
 * The per-user data directory, matching Neutralino's os.getPath("data").
 *
 * Windows is Roaming rather than Local: %APPDATA%, which is what the shipped
 * application actually uses - confirmed against its own logs, which name
 * C:\Users\<user>\AppData\Roaming\build123d-studio\runtime.
 */
function appDataDir() {
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

const envRoot = join(appDataDir(), "runtime");
const python =
  process.platform === "win32"
    ? join(envRoot, ".venv", "Scripts", "python.exe")
    : join(envRoot, ".venv", "bin", "python");

if (!existsSync(python)) {
  // Not a failure of the code under test, so say which it is: the difference
  // between "this is broken" and "there is nothing here yet" is the whole
  // message.
  console.error(`No Python environment at ${envRoot}.`);
  console.error("Start the application once so it builds one, then run this again.");
  process.exit(2);
}

const result = spawnSync(
  python,
  [join(ROOT, "tests", "integration.py"), "--env-root", envRoot, "--app-dir", ROOT],
  { stdio: "inherit" },
);

if (result.error !== undefined) {
  console.error(`Could not run the integration test: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
