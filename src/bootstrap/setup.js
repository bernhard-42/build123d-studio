import { filesystem } from "@neutralinojs/lib";
import { appDir, resolveEnvRoot, uvEnvironment, venvPython } from "./envroot.js";
import { ensureUv } from "./uv.js";

// The groups an upgrade may move, in the order they appear in the file.
const UPGRADE_GROUPS = ["app", "core_cad", "user"];
import {
  PACKAGES,
  loadPackageSources,
  checkoutsFromSources,
  projectSources,
  userGroupEntries,
  saveCustomPackages,
  saveLocalPaths,
  savePackageSources,
} from "../packages.js";
import { editableBuildFlags } from "../requirements.js";
import {
  groupEntries,
  projectVersion,
  replaceGroup,
  replaceSources,
  sourceEntries,
  spliceRelease,
} from "../pyproject.js";
import { run, quote } from "../proc.js";
import { acknowledge, appendLog, setStatus } from "./splash.js";
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
 * Make sure the environment has the two uv files, and that [project] and the
 * application's groups describe *this* release.
 *
 * The file is the user's. It is written whole exactly once - when an
 * environment has none - and after that a new release replaces its own three
 * regions and nothing else. Everything they added, from a comment to their own
 * package index, survives. spliceRelease is that operation, and the banner at
 * the top of runtime/pyproject.toml is the promise it keeps.
 *
 * uv.lock is seeded the same way and then never written again: the versions a
 * release ships are where a new environment starts, not something re-imposed on
 * one that has moved on. Deleting it is the cheap repair - the next start seeds
 * the tested set again without re-downloading the interpreter or the cache.
 *
 * Settings does not write here. It writes when it is used - see
 * writeProjectSettings - which is what lets a hand edit survive a restart.
 */
async function stageProjectFiles(envRoot) {
  const shippedPath = `${await appDir()}/runtime/pyproject.toml`;
  const shipped = await filesystem.readFile(shippedPath);
  const projectPath = `${envRoot}/pyproject.toml`;

  let existing = null;
  try {
    existing = await filesystem.readFile(projectPath);
  } catch {
    // No environment yet, or one somebody emptied.
  }

  if (existing === null) {
    log.info("No pyproject.toml in the environment; writing the one this release ships");
    await filesystem.writeFile(projectPath, shipped);
  } else if (projectVersion(existing) !== projectVersion(shipped)) {
    // Compared against the shipped file rather than against the application's
    // version constant: it is the same question asked of the two things that
    // actually have to agree, and it stays true if the stamp ever moves.
    log.info(
      `The environment was built by ${projectVersion(existing) ?? "an unknown release"};`
        + ` bringing [project] and the app groups up to ${projectVersion(shipped)}`,
    );
    appendLog("Updating the environment's dependencies for this release…");
    await filesystem.writeFile(projectPath, spliceRelease(existing, shipped));
  }

  const lockPath = `${envRoot}/uv.lock`;
  if (!(await exists(lockPath))) {
    log.info("No lock in the environment; seeding the one this release shipped");
    await filesystem.writeFile(lockPath, await filesystem.readFile(`${await appDir()}/runtime/uv.lock`));
  }
}

/**
 * Put what Settings says into the environment's pyproject.toml.
 *
 * Two regions and no more: [tool.uv.sources] and the `user` group. The rest of
 * the file is either the application's - replaced by a release - or the user's,
 * and this must not touch either.
 *
 * Called when Settings is *used*, never on a start. That is the whole of what
 * makes the file editable: a hand edit survives every restart, and is replaced
 * only when somebody presses Apply, which is them asking for it.
 *
 * @returns {Promise<boolean>} false when the file could not be understood
 */
export async function writeProjectSettings(envRoot, selection, custom) {
  const path = `${envRoot}/pyproject.toml`;
  const text = await filesystem.readFile(path);

  const withGroup = replaceGroup(text, "user", userGroupEntries(custom));
  if (withGroup === null) {
    // The group is gone, so there is nowhere to put them. Saying so beats
    // guessing where the user meant their packages to live.
    log.warn("No `user` group in the environment's pyproject.toml; leaving it alone");
    return false;
  }
  await filesystem.writeFile(path, replaceSources(withGroup, projectSources(selection, custom)));
  return true;
}

/**
 * What the environment's pyproject.toml currently says, or null.
 *
 * Null when the file is not there or cannot be understood, and that is a
 * meaningful answer rather than a failure: Settings shows what it can and
 * disables the rest, because a dialog that silently showed stale fields over a
 * file somebody had edited would be worse than one that says it cannot read it.
 *
 * @returns {Promise<{user: string[]|null, app: string[]|null, coreCad: string[]|null,
 *                    sources: Object<string, string>}|null>}
 */
export async function readProjectFile() {
  const { path: envRoot } = await resolveEnvRoot();
  let text;
  try {
    text = await filesystem.readFile(`${envRoot}/pyproject.toml`);
  } catch {
    return null;
  }
  return {
    user: groupEntries(text, "user"),
    app: groupEntries(text, "app"),
    coreCad: groupEntries(text, "core_cad"),
    sources: sourceEntries(text),
  };
}

/** Write Settings' two regions into the environment's file. */
export async function applyProjectSettings(selection, custom) {
  const { path: envRoot } = await resolveEnvRoot();
  return writeProjectSettings(envRoot, selection, custom);
}

/**
 * Put the environment back to what this release ships. Throws on failure.
 *
 * Both files written whole, rather than the lock deleted and left to be seeded
 * at the next start: deleting it would make this sync *resolve* instead of
 * install, which is not the tested set and not what "factory settings" can
 * mean. Written here, Restore is byte for byte a first run, without a restart.
 *
 * The stored settings go back too. Restore that left a local checkout selected
 * would put the sources straight back the next time Settings was applied, which
 * is precisely the confusion it exists to end.
 */
export async function restoreEnvironment(onLine) {
  const { path: envRoot } = await resolveEnvRoot();
  const root = await appDir();

  for (const name of ["pyproject.toml", "uv.lock"]) {
    await filesystem.writeFile(`${envRoot}/${name}`, await filesystem.readFile(`${root}/runtime/${name}`));
  }
  await savePackageSources({});
  await saveLocalPaths({});
  await saveCustomPackages("");

  const { code, changed } = await syncNoticingChanges(["sync"], envRoot, onLine, []);
  if (code !== 0) {
    throw new Error(`uv sync failed with exit code ${code}`);
  }
  await verifiedAfterChange(envRoot, changed);
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
async function verifyNativeLibraries(python, { changed = false } = {}) {
  setStatus(
    NL_OS === "Darwin"
      ? "macOS is verifying the OCP libraries — this happens once, and takes a minute or two…"
      : "Preparing the CAD libraries — this happens once…",
  );

  const started = Date.now();
  // A file rather than `-c`, because it says three things before it says
  // nothing for a minute: each import announces itself, so a splash that is
  // going to sit still for a hundred seconds says which of the three it is
  // sitting on. See sidecar/verify_imports.py for the measurements behind the
  // numbers it prints, and for why cadquery is only attempted when it is there.
  const code = await run(
    `${quote(python)} ${quote(`${await appDir()}/sidecar/verify_imports.py`)}`,
    { onLine: appendLog },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (code !== 0) {
    // Not fatal, and not silent either. It used to warn into the log and carry
    // on, which was right when this only ever ran on a first start: a slow
    // import would be paid later and nothing was wrong. It is the wrong answer
    // after a package change, because the reason the import fails is usually
    // that the change removed something - `uv sync` is exact, so pointing
    // build123d at a checkout that does not declare cadquery-ocp uninstalls
    // OCP - and what the user then sees is a kernel that says `dead`, with the
    // traceback in a log file they have no reason to open.
    //
    // Still not fatal, because throwing here stops startup at the splash and
    // Settings is where this gets fixed. Said plainly instead, and the splash
    // waits to be dismissed so it cannot be missed.
    log.error(`The environment cannot import what the application needs (exit ${code})`);
    appendLog("");
    appendLog("This environment cannot import OCP or build123d.");
    appendLog("The Python backend will not start until that is fixed.");
    if (changed) {
      appendLog("");
      appendLog("A package change removed something the application needs.");
      appendLog("Settings -> Packages -> Restore puts the environment back.");
    }
    setStatus("The environment is incomplete - see above.");
    await acknowledge();
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
 * One `uv sync`, whatever the selection is. It locks when the declarations have
 * changed and does nothing when they have not - measured: 64 ms and no network
 * at all on an unchanged project. There is no --frozen and no separate `uv
 * lock` step any more, because there is no longer a case where this application
 * knows better than the pyproject it just wrote.
 *
 * No --upgrade, which is what keeps a start from moving anything: uv holds
 * every locked version the constraints still allow, including the commit a
 * GitHub branch is pinned at. Moving versions is the Upgrade button's job.
 *
 * @returns {Promise<number>} exit code
 */
/**
 * @returns {Promise<{code: number, changed: boolean}>} whether uv moved anything
 */
async function syncSelection(envRoot, onLine) {
  return syncNoticingChanges(["sync"], envRoot, onLine, await checkouts(envRoot));
}

/**
 * A sync that also says whether uv moved anything.
 *
 * uv says so itself: "Installed 3 packages", "Uninstalled 1 package",
 * "Prepared 2 packages" - against "Checked 77 packages", which is the no-op.
 * Read from the output rather than diffed out of the lock, because what matters
 * is whether the *installed* set moved, and a sync that only reconciles a venv
 * to an unchanged lock still moves it.
 *
 * Every route that changes the environment asks, because every one of them then
 * has to decide whether to verify it can still import what the application
 * needs - see verifiedAfterChange.
 */
async function syncNoticingChanges(args, envRoot, onLine, checkoutList) {
  let changed = false;
  const code = await runUvSync(args, envRoot, {
    onLine: (line) => {
      if (/^(Installed|Uninstalled|Prepared) /.test(line)) {
        changed = true;
      }
      onLine(line);
    },
  }, checkoutList);
  return { code, changed };
}

/**
 * Load OCP again after a package change, on the splash the caller already has up.
 *
 * The same step a first start runs, and for the reason its own comment gives: it
 * is the only thing that asks whether the environment can still *run* the
 * application, and a package change is exactly when that stops being true. It
 * used to run on startup alone, so an Upgrade or an Install that removed
 * something left a working-looking dialog and a kernel that said `dead` at the
 * next Run, with the traceback in a log nobody opens.
 *
 * It is also slow, and that is half the point. macOS re-verifies the OCCT
 * libraries whenever they change - measured around thirty seconds, and longer
 * again for a cadquery import - and that minute is paid either way. Paying it
 * here, against a splash that says what it is doing, is a minute of progress
 * rather than a minute of a kernel that appears to have hung.
 *
 * Only when uv moved something. An Install that changed nothing has nothing to
 * re-verify, and spending the minute anyway would teach people not to press it.
 */
async function verifiedAfterChange(envRoot, changed) {
  if (!changed) {
    return;
  }
  await verifyNativeLibraries(venvPython(envRoot), { changed: true });
}

/**
 * The local checkouts the environment's file declares.
 *
 * Read from the file every time rather than passed down from the settings: the
 * file is what uv installs from, so it is also what decides which packages need
 * telling how to lay an editable install out.
 */
async function checkouts(envRoot) {
  try {
    return checkoutsFromSources(sourceEntries(await filesystem.readFile(`${envRoot}/pyproject.toml`)));
  } catch (error) {
    log.warn("Could not read the environment's sources:", error);
    return [];
  }
}

/**
 * Make sure the encapsulated Python environment exists and matches uv.lock.
 *
 * @returns {Promise<{envRoot: string, python: string, firstRun: boolean}>}
 */
export async function ensureEnvironment() {
  const { path: envRoot, source, stranded } = await resolveEnvRoot();
  log.info(`Environment root (${source}):`, envRoot);
  appendLog(`Environment: ${envRoot}`);

  // Said once, in the log, where a Windows install that predates the move to
  // %LOCALAPPDATA% can be recognised. Nothing is moved - a virtualenv holds
  // absolute paths - so the old tree is simply left, and several gigabytes
  // sitting in a roaming profile is worth naming rather than leaving to be
  // discovered.
  if (stranded !== null && (await exists(stranded))) {
    log.warn(`An older environment is still in ${stranded}; it is safe to delete`);
  }

  // Before anything else needs it: uv is what builds the environment.
  await ensureUv(envRoot);

  // Before the report below, which reads that file: on a first start it does
  // not exist yet, and reading it here is what made a fresh install fail with
  // "Unable to open file: .../pyproject.toml" before uv was ever run.
  await stageProjectFiles(envRoot);

  // Loaded for its side effect - it fills the in-memory settings the dialog
  // falls back to - while what is *reported* comes from the environment's own
  // file, which is what uv will read.
  await loadPackageSources();
  const sources = sourceEntries(await filesystem.readFile(`${envRoot}/pyproject.toml`));
  for (const p of PACKAGES) {
    const written = sources[p.name];
    appendLog(`${p.name}: ${written === undefined ? "PyPI" : written}`);
  }

  const python = venvPython(envRoot);
  const firstRun = !(await exists(python));

  setStatus(
    firstRun
      ? "Preparing the Python environment — this downloads about 500 MB and happens once…"
      : "Checking the Python environment…",
  );

  let { code, changed } = await syncSelection(envRoot, appendLog);

  // A line somebody added must not lock them out of the dialog that would fix
  // it. This runs before the window is usable, so one typo - or a git URL that
  // has gone - would otherwise mean the application never starts, with the
  // field that caused it unreachable.
  //
  // The environment's own file is what is relaxed, in the order that gives up
  // the least: their packages first, then their sources. Nothing is deleted -
  // the text is still in Settings, and the emptied region is written back the
  // moment they press Apply.
  if (code !== 0) {
    ({ code, changed } = await retryWithout(envRoot, "user", {
      failed: "Could not build the environment with the additional packages.",
      dropped: "Starting without them - they are still in Settings, uncorrected.",
      status: "Retrying without the additional packages…",
    }));
  }
  if (code !== 0) {
    ({ code, changed } = await retryWithout(envRoot, "sources", {
      failed: "Could not build the environment with the selected package sources.",
      dropped: "Reverting to PyPI for all packages.",
      status: "Reverting to the default package sources…",
    }));
  }

  if (code !== 0) {
    throw new Error(`uv sync failed with exit code ${code}`);
  }
  if (!(await exists(python))) {
    throw new Error(`uv sync reported success but ${python} is missing`);
  }

  // On a first start, and after any sync that moved a package. It used to be
  // the first start alone, on the grounds that this only pre-pays a slow
  // import - but it is also the only thing that asks whether the environment
  // can still run the application, and a package change is exactly when that
  // stops being true. An ordinary start where uv changed nothing skips it.
  if (firstRun || changed) {
    await verifyNativeLibraries(python, { changed: changed && !firstRun });
  }

  return { envRoot, python, firstRun };
}

/**
 * Empty one of the two user-owned regions and sync again, or say it was already
 * empty by returning a failure unchanged.
 *
 * Returns the exit code of the retry, or 1 when there was nothing to give up -
 * so the caller can chain the two attempts without asking twice what is in the
 * file.
 */
async function retryWithout(envRoot, region, { failed, dropped, status }) {
  const path = `${envRoot}/pyproject.toml`;
  const text = await filesystem.readFile(path);

  const relaxed = region === "user"
    ? (groupEntries(text, "user")?.length ? replaceGroup(text, "user", []) : null)
    : (Object.keys(sourceEntries(text)).length > 0 ? replaceSources(text, {}) : null);
  if (relaxed === null) {
    return { code: 1, changed: false };
  }

  log.warn(`Sync failed; retrying with the ${region} region emptied`);
  appendLog("");
  appendLog(failed);
  appendLog(dropped);
  setStatus(status);
  await filesystem.writeFile(path, relaxed);
  return syncSelection(envRoot, appendLog);
}

/**
 * Upgrade every *declared* package as far as its own constraint allows, then
 * sync. The caller has to restart the kernel afterwards - the running one still
 * holds the old modules.
 *
 * Declared is the whole of it: the two with a range, and whatever the user put
 * in the additional-packages field. What arrives underneath those - the seventy
 * or so packages nobody named - moves when a release of this application moves
 * it, which is the only place that combination was ever tested.
 */
export async function upgradePackages(onLine) {
  const { path: envRoot } = await resolveEnvRoot();

  // Staged first, as every other route into uv does, and reinstallPackage's
  // comment records leaving it out as a bug. Two things make it matter here.
  // A source just changed in this dialog has not reached the environment's
  // pyproject.toml yet, so the upgrade would resolve the previous one. And the
  // file is one an experienced user may well have opened and edited - it is
  // theirs to look at, it says MANAGED FILE at the top, and rewriting it before
  // uv reads it is what makes that true rather than merely written down.
  await stageProjectFiles(envRoot);

  // uv is deliberately not refreshed here.
  //
  // It used to be, on the grounds that a stale uv caps how new an interpreter
  // the environment can ever get. That reasoning went away when the interpreter
  // itself was pinned: uv no longer chooses the Python version, this
  // application does, and both move only when the application is rebuilt. So
  // "Upgrade packages" upgrades packages - it does not quietly swap the tool
  // that built the environment, which is the last thing a user chasing a
  // package problem wants changing underneath them. See src/bootstrap/pins.json.

  // By group, not a blanket --upgrade. Measured on the shipped lock: a blanket
  // upgrade moved 23 packages and neither of the two this button is for, taking
  // jupyter-client, pyzmq, ipython, tornado, numpy, scipy and the Node the
  // language server runs on with it - none of them named anywhere, all of them
  // landing on combinations no release ever tested.
  //
  // Groups say it once and keep saying it: a package added to `app` becomes
  // upgradable with nothing else to remember, and the `==` pins inside a group
  // still hold. Measured that --upgrade-group has the same power as
  // --upgrade-package: a plain `uv lock` left a locked 5.5.2 alone where
  // --upgrade-group moved it to 7.1.8.
  //
  // ocp-viewer-core's own dependencies are in `core_cad` too, named without
  // versions: a fix in ocp-tessellate is a fix in what the viewer draws and can
  // arrive without ocp-viewer-core moving, so the group has to reach it - while
  // the range stays ocp-viewer-core's, because uv would intersect a second one.
  const lockCode = await runUv(
    ["lock", ...UPGRADE_GROUPS.flatMap((g) => ["--upgrade-group", g])],
    envRoot,
    { onLine },
  );
  if (lockCode !== 0) {
    throw new Error(`uv lock failed with exit code ${lockCode}`);
  }

  const { code: syncCode, changed } = await syncNoticingChanges(
    ["sync"], envRoot, onLine, await checkouts(envRoot),
  );
  if (syncCode !== 0) {
    throw new Error(`uv sync failed with exit code ${syncCode}`);
  }
  await verifiedAfterChange(envRoot, changed);
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
  await stageProjectFiles(envRoot);

  // One sync, as everywhere else: it locks first if the source just written is
  // one the lock has not heard of, and reinstalls the named package either way.
  // No --upgrade, so this puts one package back without moving the others.
  const { code, changed } = await syncNoticingChanges(
    ["sync", "--reinstall-package", name],
    envRoot,
    onLine,
    await checkouts(envRoot),
  );
  if (code !== 0) {
    throw new Error(`uv sync failed with exit code ${code}`);
  }
  await verifiedAfterChange(envRoot, changed);
}

/** Re-sync after the package selection changed. Throws on failure. */
export async function applyPackageSources(selection, onLine) {
  const { path: envRoot } = await resolveEnvRoot();
  await stageProjectFiles(envRoot);
  const { code, changed } = await syncSelection(envRoot, onLine);
  if (code !== 0) {
    throw new Error(`uv failed with exit code ${code}`);
  }
  await verifiedAfterChange(envRoot, changed);
}
