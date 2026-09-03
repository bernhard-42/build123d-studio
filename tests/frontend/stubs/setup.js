/** The Python environment bootstrap, already done.
 *
 * Aliased over `src/bootstrap/setup.js` by vite.config.test.js. This is the one
 * module the harness replaces rather than stubs underneath, and the reason is
 * that it is not frontend behaviour at all: it downloads uv, resolves a lock
 * file and runs `uv sync`, which takes minutes on a cold machine and is already
 * covered where it belongs - `tests/sidecar` for the classes, `pin-uv.mjs` for
 * the digest, and the real application for the rest.
 *
 * Faking it underneath through the filesystem stub was the alternative and is
 * worse: it would mean writing a plausible uv, a plausible lock and a plausible
 * venv into an in-memory filesystem, and the suite would then be asserting that
 * a fiction it authored is consistent with itself.
 *
 * What the rest of startup needs from it is two paths, so that is what it
 * returns. `appendLog` is the splash's progress line and stays real, because
 * whether the splash shows progress *is* frontend behaviour.
 */

export async function ensureEnvironment() {
  return {
    envRoot: "/appdata/build123d-studio",
    python: "/appdata/build123d-studio/runtime/.venv/bin/python",
  };
}

/** Every line the Settings dialog's four buttons produced, for a test to read.
 *
 * settings.js imports these three, so they have to exist or the dialog does not
 * load. They report through the same onLine callback the real ones do - which
 * is the half of them the dialog actually shows - and record the call so a test
 * can say which button ran what without an environment to run it against.
 */
export const environmentCalls = [];

// Exposed on the window as well as exported, because a Playwright test runs in
// node and can only read the page through page.evaluate.
globalThis.__HARNESS_ENV_CALLS__ = environmentCalls;

export async function upgradePackages(onLine) {
  environmentCalls.push({ name: "upgradePackages" });
  onLine?.("Resolving dependencies…");
  onLine?.("Done.");
}


export async function applyPackageSources(selection, onLine) {
  environmentCalls.push({ name: "applyPackageSources", selection });
  onLine?.("Applying…");
  onLine?.("Done.");
}

/** The environment's pyproject.toml, as far as the dialog is concerned.
 *
 * A real file rather than null, because null is the "no environment yet" answer
 * and would make every test exercise the fallback path instead of the one the
 * application actually takes. The shape is the shipped file's: three groups and
 * no sources, which is what a fresh environment has.
 *
 * Mutable, so a test can put a source or a user package in it and check that
 * the dialog shows what the *file* says rather than what settings.json does -
 * which is the whole point of the change these stubs are here for.
 */
export let projectFile = {
  user: [],
  app: ["basedpyright==1.39.9", "ruff==0.16.3"],
  coreCad: ["ocp-viewer-core>=1.0.4,<1.1.0", "build123d>=0.11.1"],
  sources: {},
};

globalThis.__HARNESS_PROJECT__ = {
  set: (next) => {
    projectFile = next;
  },
  get: () => projectFile,
};

export async function readProjectFile() {
  return projectFile;
}

/** Writes to the environment's pyproject.toml, kept apart from the uv calls.
 *
 * Not in environmentCalls, and the distinction is the dialog's: Apply writes
 * this file and runs no uv, which is what "Apply touches nothing else" has
 * always meant and still does. Filing both in one list would have made that
 * test fail for a change that did not break it.
 */
export const projectWrites = [];
globalThis.__HARNESS_PROJECT_WRITES__ = projectWrites;

export async function applyProjectSettings(selection, custom) {
  projectWrites.push({ selection, custom });
  projectFile = { ...projectFile, user: custom.split("\n").filter((line) => line.trim() !== "") };
  return true;
}

export async function restoreEnvironment(onLine) {
  environmentCalls.push({ name: "restoreEnvironment" });
  // What Restore actually does, in the only terms this stub can express: the
  // file goes back to the shipped shape. A test that presses it and then
  // reopens Settings must see the additional packages gone.
  projectFile = {
    user: [],
    app: ["basedpyright==1.39.9", "ruff==0.16.3"],
    coreCad: ["ocp-viewer-core>=1.0.4,<1.1.0", "build123d>=0.11.1"],
    sources: {},
  };
  onLine?.("Restoring…");
  onLine?.("Done.");
}
