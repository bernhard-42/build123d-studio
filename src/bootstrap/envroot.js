import { filesystem, os } from "@neutralinojs/lib";

import pins from "./pins.json";
import {
  ENV_ROOT_VARIABLE,
  chooseEnvRoot,
  envRootProblem,
  parentOf,
  strandedEnvRoot,
} from "./envpath.js";

// resolve_env_root() lives here, in the frontend, on purpose.
//
// The frontend is what bootstraps the environment and spawns both children, so
// it has to know the env root first. Implementing it here and passing the
// result to the sidecar as --env-root keeps a single source of truth instead of
// the same policy written twice in two languages.
//
// The environment always lives in the per-user app-data directory - never in
// the application's own tree, even when that happens to be writable.
//
// It used to prefer the app tree and fall back here, which meant development
// exercised one branch and every packaged install the other: the configuration
// that ships was the one least tested. A signed .app bundle and an install under
// Program Files are both read-only anyway, so the app-tree branch only ever ran
// on a developer's working copy.
//
// What the original requirement was actually for is unchanged: the interpreter,
// venv and cache are entirely the application's own, and no system or user
// Python is ever touched.

const APP_DIR_NAME = "build123d-studio";

// Read by the `studio` script, which cannot find the application any other way
// once it has been copied onto the user's PATH. See recordAppLocation.
const APP_LOCATION_FILE = "app-location";

let appDirCache = null;
let appDataCache = null;
let envRootCache = null;

/**
 * Absolute path of the application directory.
 *
 * NL_PATH is relative during development (`neu run` passes --path=.), and a
 * relative path breaks as soon as a child process is given a different cwd,
 * so it is resolved once here and every other path is built from the result.
 */
export async function appDir() {
  if (appDirCache === null) {
    // getAbsolutePath alone leaves the "." in place (".../build123d-studio/./bin"),
    // which is harmless for the shell but ugly in logs and in the paths handed
    // to Python, so normalize as well.
    const absolute = await filesystem.getAbsolutePath(NL_PATH);
    appDirCache = await filesystem.getNormalizedPath(absolute);
  }
  return appDirCache;
}

/**
 * Per-user directory for the settings, the snippets, the log and the recovery
 * copies.
 *
 * ~/Library/Application Support/build123d-studio on macOS, %APPDATA% on Windows
 * - Roaming, not Local - and ~/.local/share on Linux. os.getPath("data")
 * resolves the per-OS convention; the Windows answer was written down as
 * LOCALAPPDATA here and is not, as the shipped application's own logs say:
 * C:\Users\<user>\AppData\Roaming\build123d-studio.
 *
 * Roaming is right for what is left here. A preference, a snippet file and an
 * unsaved buffer are the user's, and following them to another machine is what
 * that half of AppData is for. The environment is a different matter and no
 * longer lives here on Windows - see resolveEnvRoot.
 *
 * The application writes nothing into its own directory, so an installation can
 * be read-only: a .app dragged to /Applications, an AppImage's read-only mount,
 * an install under Program Files.
 */
export async function appDataDir() {
  if (appDataCache === null) {
    const dataDir = await os.getPath("data");
    const root = `${dataDir}/${APP_DIR_NAME}`;
    await ensureDirectory(root);
    appDataCache = root;
  }
  return appDataCache;
}

/**
 * Record where this application is installed, for the `studio` command.
 *
 * The script is meant to be copied onto the user's PATH, which is exactly what
 * stops it working out the application's location from its own: once copied it
 * has no relationship to the bundle it came from. Searching the usual install
 * locations would work on macOS and nowhere else - a Windows package is
 * unzipped wherever the user felt like it, and an AppImage lives anywhere at
 * all - so the application says where it is instead, on every start, and the
 * script reads that.
 *
 * Written on every start rather than once, so moving the application fixes
 * itself the next time it runs. Two instances write the same value; the last
 * one wins and they agree. Two *different* installations do not agree, and the
 * most recently started wins, which is the only answer that can be given
 * without asking the user which one they meant.
 */
export async function recordAppLocation() {
  const path = `${await appDataDir()}/${APP_LOCATION_FILE}`;
  await filesystem.writeFile(path, await appDir());
  return path;
}

/**
 * Directory holding the interpreter, venv, uv cache and the uv project files.
 *
 * Three places it can be, in order of precedence - the rules are in envpath.js,
 * which explains why each exists:
 *
 * 1. BUILD123D_STUDIO_ENV_ROOT, for a machine that will not execute binaries
 *    out of the default location
 * 2. %LOCALAPPDATA%\build123d-studio\runtime on Windows
 * 3. <app-data>/runtime everywhere else
 *
 * Resolved once per session. It survives replacing the application, which is
 * what makes an app update cheap: uv.lock ships with the app and is staged here
 * on every start, so `uv sync --frozen` reconciles whatever is here to whatever
 * the running version expects. An empty directory is not a special case either
 * - ensureEnvironment derives firstRun from the interpreter being absent, so a
 * root that has just moved builds itself exactly as a first start does.
 *
 * A bad override throws rather than falling back. Somebody who set that
 * variable did so because the default location does not work on their machine,
 * and quietly rebuilding several gigabytes there would be the one answer that
 * cannot help them.
 *
 * @returns {Promise<{path: string, source: string, stranded: string|null}>}
 */
export async function resolveEnvRoot() {
  if (envRootCache !== null) {
    return envRootCache;
  }

  // getEnv answers "" for a variable that is not set, so absence and emptiness
  // arrive here as the same thing - and are the same thing: an override nobody
  // set and one set to nothing both mean "decide it yourself".
  const raw = await os.getEnv(ENV_ROOT_VARIABLE);
  const override = typeof raw === "string" && raw.trim() !== "" ? raw : null;
  if (override !== null) {
    const problem = envRootProblem(override);
    if (problem !== null) {
      throw new Error(problem);
    }
  }

  const dataDir = await appDataDir();
  const chosen = chooseEnvRoot({
    override,
    dataDir,
    localAppData: NL_OS === "Windows" ? await os.getEnv("LOCALAPPDATA") : null,
    platform: NL_OS,
    appName: APP_DIR_NAME,
  });

  try {
    await ensureDirectoryChain(chosen.path);
  } catch (error) {
    if (chosen.source === "override") {
      // Named, because the variable is the reason this path was tried at all
      // and "permission denied" on its own does not say where to look.
      throw new Error(
        `${ENV_ROOT_VARIABLE} names ${chosen.path}, which could not be created: ` +
          `${error?.message ?? error}`,
      );
    }
    throw error;
  }

  envRootCache = {
    path: chosen.path,
    source: chosen.source,
    stranded: strandedEnvRoot({ source: chosen.source, dataDir }),
  };
  return envRootCache;
}

/**
 * Create a directory, tolerating one that is already there.
 *
 * Neutralino's createDirectory raises NE_FS_DIRCRER for an existing directory
 * just as it does for a genuine failure, so the two are told apart by checking
 * afterwards. Without this every run after the first fails at startup - which
 * is exactly what happened.
 */
export async function ensureDirectory(path) {
  try {
    await filesystem.createDirectory(path);
  } catch (error) {
    try {
      const stats = await filesystem.getStats(path);
      if (stats.isDirectory) {
        return;
      }
    } catch {
      // Fall through: it is not there, so the original failure was real.
    }
    throw error;
  }
}

/**
 * Create a directory and whatever is missing above it.
 *
 * Both new roots need this and neither used to. `%LOCALAPPDATA%` exists but
 * `%LOCALAPPDATA%\build123d-studio` does not on a machine that has only ever
 * had the Roaming one, and an override may name anything at all - somebody
 * pointing at `D:\studio\env` should not have to make `D:\studio` by hand
 * first. The old root never needed it because appDataDir had already made its
 * parent on the way past.
 *
 * Upwards rather than downwards: the failure is asked for, not predicted, so
 * there is no second implementation of "which prefixes of this path exist".
 * parentOf stops at a root, which is what terminates it.
 */
async function ensureDirectoryChain(path) {
  try {
    await ensureDirectory(path);
    return;
  } catch (error) {
    const above = parentOf(path);
    if (above === null) {
      throw error;
    }
    await ensureDirectoryChain(above);
    // If this fails now, it is not a missing parent, so it is the answer.
    await ensureDirectory(path);
  }
}

/** Path of the Python interpreter inside the environment's venv. */
export function venvPython(envRoot) {
  if (NL_OS === "Windows") {
    return `${envRoot}\\.venv\\Scripts\\python.exe`;
  }
  return `${envRoot}/.venv/bin/python`;
}

/**
 * Environment variables that confine every uv operation to the env root.
 *
 * UV_NO_CONFIG matters as much as the directory settings: without it a user's
 * global uv.toml could redirect the index or the cache back out of the tree.
 */
export function uvEnvironment(envRoot) {
  return {
    UV_PYTHON_INSTALL_DIR: `${envRoot}/interpreters`,
    UV_CACHE_DIR: `${envRoot}/cache`,
    UV_MANAGED_PYTHON: "1",
    // An exact interpreter, not a "3.14" that resolves to whatever patch
    // release is current. Two people on the same build123d Studio then run the
    // same Python, which is what makes a bug report answerable - and nobody
    // reports 3.14.6 versus 3.14.7 anyway. The cost is deliberate: a CPython
    // patch, including a security one, reaches users when this pin moves, which
    // is a rebuild of the application. See src/bootstrap/pins.json.
    UV_PYTHON: pins.python,
    UV_PYTHON_DOWNLOADS: "automatic",
    UV_NO_CONFIG: "1",
    UV_PROJECT: envRoot,
  };
}
