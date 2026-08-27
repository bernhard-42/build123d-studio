import { filesystem } from "@neutralinojs/lib";
import { appDir, resolveEnvRoot, uvEnvironment, venvPython } from "./envroot.js";
import { ensureUv } from "./uv.js";
import {
  PACKAGES,
  customPackages,
  isDefaultSelection,
  loadPackageSources,
  localCheckouts,
  packageSources,
  renderPyproject,
  savePackageSources,
  shippedLockApplies,
} from "../packages.js";
import { editableBuildFlags } from "../requirements.js";
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
async function stageProjectFiles(envRoot, selection, custom) {
  const root = await appDir();
  await filesystem.writeFile(`${envRoot}/pyproject.toml`, await renderPyproject(selection, custom));

  const lockPath = `${envRoot}/uv.lock`;
  const shipped = await filesystem.readFile(`${root}/runtime/uv.lock`);

  if (shippedLockApplies(selection, custom)) {
    await filesystem.writeFile(lockPath, shipped);
    return true;
  }

  // Whatever lock is here stays, including the shipped one.
  //
  // It used to be deleted when it still matched the shipped copy, to stop a
  // stale lock sending us down `uv sync --frozen` with the wrong contents. That
  // job belongs to shippedLockApplies above, which already answers false
  // whenever anything has been added or redirected - so the deletion was
  // redundant, and it cost the one thing that makes Apply different from
  // Upgrade.
  //
  // Measured: `uv lock` keeps a package at its locked version even after its
  // constraint is loosened, and still adds whatever is new. Delete the lock
  // first and the same command resolves from scratch and moves everything. So
  // deleting it meant the first Apply after adding a single package silently
  // upgraded the entire environment, which is precisely what Upgrade is for and
  // what Apply should not do.
  //
  // Keeping it is safe because the constraints still do the work: an app update
  // that ships `ocp_vscode==4.1.0` invalidates the locked 4.0.1 and uv
  // re-resolves that package regardless of what the old lock preferred.
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
 * A `uv sync`, carrying what a local checkout needs said about how it is built.
 *
 * Every sync goes through here rather than each site remembering the flags,
 * because forgetting them does not fail: it installs the checkout in the layout
 * a static analyser cannot read, and what comes back weeks later is "the editor
 * says my package is not installed" - with the kernel importing it perfectly.
 * See editableBuildFlags for what the flags are and why they cannot live in the
 * generated pyproject.toml.
 */
function runUvSync(args, envRoot, { onLine }, checkouts) {
  return runUv([...args, ...editableBuildFlags(checkouts)], envRoot, { onLine });
}

/**
 * Bring the environment in line with the current package selection.
 *
 * @returns {Promise<number>} exit code of the last uv command
 */
async function syncSelection(envRoot, selection, onLine, custom = customPackages()) {
  const shippedLockApplies = await stageProjectFiles(envRoot, selection, custom);

  const checkouts = localCheckouts(selection, custom);

  if (shippedLockApplies) {
    // Nothing to resolve: install exactly what was tested.
    return runUvSync(["sync", "--frozen"], envRoot, { onLine }, checkouts);
  }

  // A GitHub source is in play, so uv has to resolve. Without --upgrade this
  // keeps whatever commit is already pinned, so it is quick on later starts and
  // does not silently move the branch under the user.
  const lockCode = await runUv(["lock"], envRoot, { onLine });
  if (lockCode !== 0) {
    return lockCode;
  }
  return runUvSync(["sync"], envRoot, { onLine }, checkouts);
}

/**
 * Make sure the encapsulated Python environment exists and matches uv.lock.
 *
 * @returns {Promise<{envRoot: string, python: string, firstRun: boolean}>}
 */
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

  // A bad line in the additional-packages field must not lock the user out of
  // the dialog that would fix it.
  //
  // This runs before the window is usable, so a single typo - or a git URL that
  // has gone - would otherwise mean the application never starts, with the
  // field that caused it unreachable. Retried without the custom section, which
  // is the same shape as the package-source fallback below: keep the app
  // usable, say plainly what was dropped, and leave the text alone so it can be
  // corrected rather than retyped.
  if (code !== 0 && customPackages() !== "") {
    log.warn("Sync failed with the additional packages; retrying without them");
    appendLog("");
    appendLog("Could not build the environment with the additional packages.");
    appendLog("Starting without them - they are still in Settings, uncorrected.");
    setStatus("Retrying without the additional packages…");
    code = await syncSelection(envRoot, selection, appendLog, "");
  }

  if (code !== 0 && !isDefaultSelection(selection)) {
    // The user chose a source uv cannot satisfy - a dev branch that has moved
    // ahead of what the frozen packages accept, or a local checkout that does
    // not build. Not predictable in advance, so rather than leave the
    // application unusable, fall back to the tested selection and say so.
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

  // A blanket --upgrade, and the exact pins are what make it safe.
  //
  // This used to name each package with --upgrade-package, on the grounds that
  // a blanket upgrade would move ocp_vscode and break the viewer. Measured:
  // `uv lock --upgrade` cannot move a dependency pinned with ==, so the pins in
  // runtime/pyproject.toml were already the guarantee and the name list was
  // restating it. Everything now moves as far as its own constraint allows,
  // which is one sentence a user can hold - build123d>=0.11.1 moves,
  // ocp_vscode==4.0.1 does not, and an added package moves exactly as far as
  // whatever the user wrote for it.
  //
  // The cost is transitive drift: packages nothing here declares may land on
  // combinations this release never tested. That is the nature of the button,
  // and anyone pressing it has left the tested configuration by definition.
  // Naming packages instead would mean parsing names out of the user's own text
  // and putting them on a command line, which this avoids entirely.
  const lockCode = await runUv(["lock", "--upgrade"], envRoot, { onLine });
  if (lockCode !== 0) {
    throw new Error(`uv lock failed with exit code ${lockCode}`);
  }

  const syncCode = await runUvSync(["sync"], envRoot, { onLine }, localCheckouts());
  if (syncCode !== 0) {
    throw new Error(`uv sync failed with exit code ${syncCode}`);
  }
}

/**
 * Put one package back into the environment from its source. Throws on failure.
 *
 * For a local checkout, which is the case that needs it: uv installs a `path`
 * source as an ordinary build rather than a live link, so editing the source
 * tree changes nothing in the environment until it is installed again - and
 * nothing in the lock has changed, so an ordinary sync is a no-op. Only
 * `--reinstall-package` makes it happen.
 *
 * The staging is not optional, and leaving it out was a bug. What uv reinstalls
 * *from* is the environment's own pyproject and lock, and those are generated
 * from the settings rather than being the settings - so a source just changed
 * in this dialog has not reached them. Without this, --reinstall-package
 * faithfully put back the source that was selected before, and only restarting
 * applied the new one, because ensureEnvironment stages on every launch.
 *
 * The name comes from PACKAGES, so what reaches the command line is a constant
 * in this repository rather than anything a user typed.
 */
export async function reinstallPackage(name, onLine) {
  const { path: envRoot } = await resolveEnvRoot();
  const usesShippedLock = await stageProjectFiles(
    envRoot,
    await loadPackageSources(),
    customPackages(),
  );

  if (!usesShippedLock) {
    // A path or branch source is in play, so the lock has to learn about it
    // before anything can be installed from it. No --upgrade: this reinstalls
    // one package, it does not move the others.
    const lockCode = await runUv(["lock"], envRoot, { onLine });
    if (lockCode !== 0) {
      throw new Error(`uv lock failed with exit code ${lockCode}`);
    }
  }

  // --frozen exactly where syncSelection uses it: with the shipped lock in
  // force there is nothing to resolve, and the reinstall should put back what
  // this release was tested against rather than re-deciding it.
  const args = usesShippedLock
    ? ["sync", "--frozen", "--reinstall-package", name]
    : ["sync", "--reinstall-package", name];
  const code = await runUvSync(args, envRoot, { onLine }, localCheckouts());
  if (code !== 0) {
    throw new Error(`uv sync failed with exit code ${code}`);
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
