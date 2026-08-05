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

export async function reinstallPackage(name, onLine) {
  environmentCalls.push({ name: "reinstallPackage", package: name });
  onLine?.(`Reinstalling ${name}…`);
  onLine?.("Done.");
}

export async function applyPackageSources(selection, onLine) {
  environmentCalls.push({ name: "applyPackageSources", selection });
  onLine?.("Applying…");
  onLine?.("Done.");
}
