// Runner for tests/integration.py.
//
// The test needs three things it cannot work out for itself: where the
// application's Python environment is, which interpreter inside it to use, and
// where the repository is. The first two come from scripts/envroot.mjs, which
// mirrors how the application itself is arranged - src/bootstrap/envroot.js owns
// path policy and hands the sidecar an --env-root - so there is one statement of
// it per platform instead of several that can drift.
//
// It runs against the environment a real launch created, deliberately. An
// environment built specially for the test would be a different environment from
// the one that breaks, and the bugs this exists to catch were all in the seam
// between the application and its own runtime.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requirePython } from "./envroot.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { envRoot, python } = requirePython();

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
