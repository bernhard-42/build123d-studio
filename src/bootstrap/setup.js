import { filesystem } from "@neutralinojs/lib";
import { appDir, resolveEnvRoot, uvEnvironment, venvPython } from "./envroot.js";
import { ensureUv } from "./uv.js";
import {
  PACKAGES,
  isDefaultSelection,
  loadPackageSources,
  packageSources,
  renderPyproject,
  savePackageSources,
} from "../packages.js";
import { run, quote } from "../proc.js";
import { appendLog, setStatus } from "./splash.js";
import * as log from "../log.js";

// Environment bootstrap.
//
// uv sync is run on every start, not just the first one: it is a no-op costing
// well under a second when the environment already matches uv.lock, and it
// self-heals an environment that was interrupted mid-install or left stale by a
// package upgrade.

async function exists(path) {
  try {
    await filesystem.getStats(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the uv project files into the environment.
 *
 * Done on every start, not just the first: these files are the application's
 * statement of what the environment should contain, so re-staging them is what
 * makes an app update reconcile an environment built by an earlier version.
 *
 * The shipped uv.lock is staged only when every package is on PyPI. That is the
 * tested, reproducible combination and installs with --frozen, resolving
 * nothing. Once a package is redirected to a GitHub branch the shipped lock no
 * longer describes the environment, so it is dropped and uv re-resolves.
 *
 * @returns {Promise<boolean>} whether the shipped lock applies
 */
async function stageProjectFiles(envRoot, selection) {
  const root = await appDir();
  await filesystem.writeFile(`${envRoot}/pyproject.toml`, await renderPyproject(selection));

  const lockPath = `${envRoot}/uv.lock`;
  const shipped = await filesystem.readFile(`${root}/runtime/uv.lock`);

  if (isDefaultSelection(selection)) {
    await filesystem.writeFile(lockPath, shipped);
    return true;
  }

  if (await exists(lockPath)) {
    // A leftover copy of the shipped lock pins the PyPI builds and would send
    // --frozen down the wrong path; a lock uv wrote for this selection stays.
    const current = await filesystem.readFile(lockPath);
    if (current === shipped) {
      await filesystem.remove(lockPath);
    }
  }
  return false;
}

async function runUv(args, envRoot, { onLine }) {
  // Every argument quoted, not just the binary. They are all constants today -
  // "sync", "--frozen", a package name from PACKAGES - so nothing here is
  // currently at risk. Phase 3 adds a config field where users type extra
  // packages in pyproject.toml syntax, and those end up as arguments; a habit
  // that only quotes what looks dangerous is the one that misses that.
  const command = `${quote(await ensureUv(envRoot))} ${args.map(quote).join(" ")}`;
  log.info("Running uv:", command, "in", envRoot);
  const code = await run(command, {
    cwd: envRoot,
    envs: uvEnvironment(envRoot),
    onLine: (line) => {
      log.info("uv:", line);
      onLine(line);
    },
  });
  log.info("uv exited with", code);
  return code;
}

/**
 * Load OCP's native libraries once, while the splash is still up.
 *
 * cadquery-ocp is several hundred megabytes of OCCT shared libraries, and the
 * first time macOS loads them Gatekeeper verifies the lot - ten seconds and up,
 * paid once per installation. Left alone that lands on the user's first Run,
 * long after the app looks ready, where it reads as a hang.
 *
 * Done in a throwaway interpreter rather than in the kernel: this runs before
 * the sidecar exists, and the point is to have the verification finished and
 * cached by the time anything else asks for OCP.
 */
async function verifyNativeLibraries(python) {
  setStatus(
    NL_OS === "Darwin"
      ? "macOS is verifying the OCP libraries — this happens once, and takes a minute…"
      : "Preparing the CAD libraries — this happens once…",
  );
  appendLog("Loading OCP for the first time…");

  const started = Date.now();
  // build123d rather than OCP alone: it pulls in the OCP submodules that are
  // actually used, so the verification covers the libraries that matter.
  const code = await run(
    `${quote(python)} -c ${quote("import OCP; import build123d")}`,
    { onLine: appendLog },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (code !== 0) {
    // Not fatal: the import will simply be paid later, in the kernel.
    log.warn(`Pre-loading OCP failed with exit code ${code}`);
    appendLog(`Pre-loading OCP failed (exit ${code}); continuing anyway.`);
    return;
  }
  log.info(`OCP verified in ${seconds}s`);
  appendLog(`OCP ready (${seconds}s)`);
}

/**
 * Make sure the encapsulated Python environment exists and matches uv.lock.
 *
 * @returns {Promise<{envRoot: string, python: string, firstRun: boolean}>}
 */
/**
 * Bring the environment in line with the current package selection.
 *
 * @returns {Promise<number>} exit code of the last uv command
 */
async function syncSelection(envRoot, selection, onLine) {
  const shippedLockApplies = await stageProjectFiles(envRoot, selection);

  if (shippedLockApplies) {
    // Nothing to resolve: install exactly what was tested.
    return runUv(["sync", "--frozen"], envRoot, { onLine });
  }

  // A GitHub source is in play, so uv has to resolve. Without --upgrade this
  // keeps whatever commit is already pinned, so it is quick on later starts and
  // does not silently move the branch under the user.
  const lockCode = await runUv(["lock"], envRoot, { onLine });
  if (lockCode !== 0) {
    return lockCode;
  }
  return runUv(["sync"], envRoot, { onLine });
}

export async function ensureEnvironment() {
  const { path: envRoot } = await resolveEnvRoot();
  log.info("Environment root:", envRoot);
  appendLog(`Environment: ${envRoot}`);

  // Before anything else needs it: uv is what builds the environment.
  await ensureUv(envRoot);

  const selection = await loadPackageSources();
  for (const p of PACKAGES) {
    appendLog(`${p.name}: ${selection[p.name] === "github" ? `${p.branch} branch` : "PyPI"}`);
  }

  const python = venvPython(envRoot);
  const firstRun = !(await exists(python));

  setStatus(
    firstRun
      ? "Preparing the Python environment — this downloads about 500 MB and happens once…"
      : "Checking the Python environment…",
  );

  let code = await syncSelection(envRoot, selection, appendLog);

  if (code !== 0 && !isDefaultSelection(selection)) {
    // The user chose a combination uv cannot satisfy - build123d and
    // bd_warehouse constrain each other, and which pairs work changes with
    // every release, so this is not predictable in advance. Rather than leave
    // the application unusable, fall back to the tested selection and say so.
    log.warn("Sync failed with the chosen package sources; reverting to PyPI");
    appendLog("");
    appendLog("Could not build the environment with the selected package sources.");
    appendLog("Reverting to PyPI for all packages.");
    setStatus("Reverting to the default package sources…");
    await savePackageSources({});
    code = await syncSelection(envRoot, packageSources(), appendLog);
  }

  if (code !== 0) {
    throw new Error(`uv sync failed with exit code ${code}`);
  }
  if (!(await exists(python))) {
    throw new Error(`uv sync reported success but ${python} is missing`);
  }

  // Only when the environment was just built - which also covers the user
  // deleting it, since firstRun is derived from the interpreter being absent
  // rather than from any stored flag.
  if (firstRun) {
    await verifyNativeLibraries(python);
  }

  return { envRoot, python, firstRun };
}

/**
 * Upgrade every package to the newest version its constraints allow, then sync.
 * The caller has to restart the kernel afterwards - the running one still holds
 * the old modules.
 */
export async function upgradePackages(onLine) {
  const { path: envRoot } = await resolveEnvRoot();

  // uv is deliberately not refreshed here.
  //
  // It used to be, on the grounds that a stale uv caps how new an interpreter
  // the environment can ever get. That reasoning went away when the interpreter
  // itself was pinned: uv no longer chooses the Python version, this
  // application does, and both move only when the application is rebuilt. So
  // "Upgrade packages" upgrades packages - it does not quietly swap the tool
  // that built the environment, which is the last thing a user chasing a
  // package problem wants changing underneath them. See src/bootstrap/pins.json.

  // Named packages, never a blanket --upgrade.
  //
  // ocp_vscode is tied to the three-cad-viewer build in the frontend and
  // ocp_tessellate follows it, so upgrading them here would break the viewer
  // without touching a line of application code. Only the packages the config
  // dialog exposes may move.
  const upgrades = PACKAGES.flatMap((p) => ["--upgrade-package", p.name]);

  const lockCode = await runUv(["lock", ...upgrades], envRoot, { onLine });
  if (lockCode !== 0) {
    throw new Error(`uv lock failed with exit code ${lockCode}`);
  }

  const syncCode = await runUv(["sync"], envRoot, { onLine });
  if (syncCode !== 0) {
    throw new Error(`uv sync failed with exit code ${syncCode}`);
  }
}

/** Re-sync after the package selection changed. Throws on failure. */
export async function applyPackageSources(selection, onLine) {
  const { path: envRoot } = await resolveEnvRoot();
  const code = await syncSelection(envRoot, selection, onLine);
  if (code !== 0) {
    throw new Error(`uv failed with exit code ${code}`);
  }
}
