import { filesystem, os } from "@neutralinojs/lib";

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
 * Per-user directory for everything the application writes.
 *
 * ~/Library/Application Support/build123d-studio on macOS, %LOCALAPPDATA% on
 * Windows, ~/.local/share on Linux.
 *
 * The application writes nothing into its own directory, so an installation can
 * be read-only: a .app dragged to /Applications, an AppImage's read-only mount,
 * an install under Program Files. The environment, the settings file and the log
 * all hang off here.
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
 * Directory holding the interpreter, venv, uv cache and the uv project files.
 *
 * ~/Library/Application Support/build123d-studio/runtime on macOS, %LOCALAPPDATA% on
 * Windows, ~/.local/share on Linux - os.getPath("data") resolves the per-OS
 * convention. Resolved once per session.
 *
 * It survives replacing the application, which is what makes an app update
 * cheap: uv.lock ships with the app and is staged here on every start, so
 * `uv sync --frozen` reconciles whatever is here to whatever the running
 * version expects.
 *
 * @returns {Promise<{path: string}>}
 */
export async function resolveEnvRoot() {
  if (envRootCache !== null) {
    return envRootCache;
  }

  const root = `${await appDataDir()}/runtime`;
  await ensureDirectory(root);

  envRootCache = { path: root };
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
    UV_PYTHON: "3.14",
    UV_PYTHON_DOWNLOADS: "automatic",
    UV_NO_CONFIG: "1",
    UV_PROJECT: envRoot,
  };
}
