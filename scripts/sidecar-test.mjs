// Runner for the sidecar's unit tests, in tests/sidecar.
//
// Separate from `yarn test:integration`, and the split is about what each one
// can see rather than about speed. The integration test drives the whole sidecar
// from outside, the way the webview does, so it can only assert on what crosses
// the socket - it cannot see which kernel generation a pump is holding, or
// whether a write went to a descriptor that has stopped meaning the pty. These
// tests reach the classes directly and assert on exactly that.
//
// They still need the application's interpreter, because channel.py imports
// websockets and there is nowhere else it exists: the environment is generated
// for the user at first launch and no development tool is installed into it.
// That is the same reason ruff is run through uvx.
//
// PYTHONPATH rather than a sys.path insert in each test file. The sidecar is run
// by path in production, so its modules import each other as plain top-level
// names; putting the directory on the path from outside is what reproduces that,
// and it keeps the tests free of import-order hacks that ruff would rightly
// complain about.

import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requirePython } from "./envroot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { python } = requirePython();

// Both halves of the Python this repository owns. `sidecar` is run by path in
// production, so its modules import each other as plain top-level names, and
// `kernel` is what the application puts on the *kernel process's* PYTHONPATH -
// which is the only reason `build123d_studio` is importable there. Putting both
// here from outside is what reproduces each, and keeps the tests free of
// import-order hacks that ruff would rightly complain about.
const owned = [join(ROOT, "sidecar"), join(ROOT, "kernel")];
const existing = process.env.PYTHONPATH ?? "";
const pythonPath = (existing === "" ? owned : [...owned, existing]).join(delimiter);

const result = spawnSync(
  python,
  ["-m", "unittest", "discover", "--start-directory", join(ROOT, "tests", "sidecar"), "--verbose"],
  {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: pythonPath },
  },
);

if (result.error !== undefined) {
  console.error(`Could not run the sidecar tests: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
