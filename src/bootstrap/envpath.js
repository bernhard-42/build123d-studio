// Where the Python environment goes, decided without a filesystem.
//
// Pure, and split from envroot.js for the reason keys.js is split from
// keybindings.js: both decisions here are rules about a string, both have a
// branch that only ever runs on somebody else's machine, and neither needs
// Neutralino to be exercised. envroot.js is the half that reads the environment
// and creates directories.
//
// ## Why the environment is not simply "the app-data directory"
//
// Two things are true of the tree this names, and no other directory the
// application writes shares them:
//
// * It is large. Measured on macOS: 1.8 GB and 37,905 files in `.venv` alone,
//   4.6 GB and 94,201 files including the interpreter and uv's cache.
// * It is *executed*. uv, a whole CPython, and the native extension modules
//   underneath OCP are all run from inside it.
//
// Both matter on a managed machine, and they pull in opposite directions from
// where settings belong.

/** The variable that overrides everything below. */
export const ENV_ROOT_VARIABLE = "BUILD123D_STUDIO_ENV_ROOT";

/**
 * The separator a path is already written with.
 *
 * %LOCALAPPDATA% comes back backslashed and Neutralino's data path forward-
 * slashed, so joining with whichever the base used keeps each result in one
 * spelling. The sibling of separatorOf in editor/tree.js, duplicated rather
 * than imported because bootstrap must not depend on the editor.
 */
function separatorOf(path) {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function join(base, name) {
  const trimmed = base.replace(/[/\\]+$/, "");
  return `${trimmed}${separatorOf(base)}${name}`;
}

/**
 * Whether a path stands on its own, with no working or home directory implied.
 *
 * A POSIX path, a drive letter, or a UNC share. `~/x` and `../x` are refused
 * rather than expanded: this value arrives from the environment of whatever
 * launched the application - a desktop session, not a shell - so there is no
 * dependable answer to what they would be relative to, and the bad case is not
 * the one that fails but the one that finds a different directory of the same
 * name. The same rule, and the same reason, as a local checkout in
 * requirements.js.
 */
function absolute(text) {
  return text.startsWith("/") || text.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(text);
}

/**
 * Why this value cannot be an environment root, or null if it can.
 *
 * Reported rather than ignored. A user who sets this variable is working around
 * a machine that will not run binaries out of the default location, so falling
 * back to that location silently would rebuild several gigabytes in the one
 * place already known not to work - and say nothing about why.
 *
 * @param {string} value the raw variable
 */
export function envRootProblem(value) {
  if (typeof value !== "string") {
    return `${ENV_ROOT_VARIABLE} is not a string`;
  }
  const chosen = value.trim();
  if (chosen === "") {
    return `${ENV_ROOT_VARIABLE} is empty`;
  }
  if (!absolute(chosen)) {
    return (
      `${ENV_ROOT_VARIABLE} must be a full path - "${chosen}" has nothing to be ` +
      "relative to here, because this is not a shell"
    );
  }
  return null;
}

/**
 * Where the environment lives, and why it is there.
 *
 * Three cases, in order:
 *
 * 1. **The override**, which wins on every platform. It exists for machines
 *    that refuse to execute binaries out of a user-writable path - AppLocker
 *    and WDAC deny `%APPDATA%`, `%LOCALAPPDATA%` and `%TEMP%` in their
 *    recommended rule sets, and a `noexec` mount over `/home` is the same
 *    policy on Linux. Without it there is nothing such a user can try: the
 *    location was not configurable at all, so the application simply did not
 *    work and said nothing that pointed at the reason.
 *
 * 2. **`%LOCALAPPDATA%` on Windows**, not `%APPDATA%`. Roaming is the wrong
 *    half of AppData for this: under folder redirection or a roaming profile it
 *    is a network share or is copied at every logon, and a 38,000-file
 *    interpreter and package cache is exactly what those policies exist to keep
 *    off the wire - profile quotas are normally a small fraction of it. Local
 *    is excluded from roaming by design, which is what makes it the
 *    conventional home for a downloaded toolchain. Settings and snippets stay
 *    in Roaming, where a preference that follows the user belongs.
 *
 * 3. **The app-data directory** everywhere else, which is already per-user and
 *    already local.
 *
 * `source` is returned alongside because the log and the About dialog should
 * say which of the three answered - "it is not where you expected" is otherwise
 * a question nobody can settle from a bug report.
 *
 * @param {object} where
 * @param {string|null} where.override a validated ENV_ROOT_VARIABLE, or null
 * @param {string} where.dataDir the per-user app-data directory
 * @param {string|null} where.localAppData %LOCALAPPDATA%, or null off Windows
 * @param {string} where.platform NL_OS: "Windows", "Darwin" or "Linux"
 * @param {string} where.appName the directory name under localAppData
 * @returns {{path: string, source: "override"|"local"|"data"}}
 */
export function chooseEnvRoot({ override, dataDir, localAppData, platform, appName }) {
  if (typeof override === "string" && override.trim() !== "") {
    return { path: override.trim().replace(/[/\\]+$/, ""), source: "override" };
  }

  if (platform === "Windows" && typeof localAppData === "string" && localAppData.trim() !== "") {
    return { path: join(join(localAppData.trim(), appName), "runtime"), source: "local" };
  }

  // Off Windows this is the only answer. On Windows it is reached only when
  // %LOCALAPPDATA% is not set, which is not a configuration anyone chooses -
  // but the alternative is refusing to start over a missing variable that has
  // been standard since Windows Vista, and Roaming does work.
  return { path: join(dataDir, "runtime"), source: "data" };
}

/**
 * The directory holding this one, or null when there is nothing above it.
 *
 * Only enough of a path parser to walk upwards while creating directories, and
 * the stopping conditions are the whole of the difficulty: a drive root
 * (`C:\`), a POSIX root (`/`) and a UNC share (`\\server\share`) all have to
 * report null, because asking the filesystem to create any of them is a request
 * that fails for a reason nobody can act on.
 *
 * @returns {string|null}
 */
export function parentOf(path) {
  const trimmed = path.replace(/[/\\]+$/, "");

  // `\\server\share` - the share itself is the top, not `\\server`.
  const unc = /^\\\\[^\\/]+[\\/][^\\/]+$/.test(trimmed);
  if (unc || /^[A-Za-z]:$/.test(trimmed) || trimmed === "") {
    return null;
  }

  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) {
    return null;
  }
  const above = trimmed.slice(0, cut);
  // "/one" cuts to "", which is the POSIX root and is a real directory.
  if (above === "") {
    return trimmed.startsWith("/") ? "/" : null;
  }
  return /^[A-Za-z]:$/.test(above) ? `${above}\\` : above;
}

/**
 * The environment a Windows install used to build, if it is not the one now.
 *
 * Nothing is moved. A virtualenv records absolute paths - `pyvenv.cfg` names
 * its interpreter, and every console-script shim embeds the path of the python
 * that will run it - so a moved `.venv` is a broken one, and `uv sync` deciding
 * to repair rather than rebuild it is not something to depend on. The new
 * location bootstraps from scratch instead, which costs a download and is the
 * path ensureEnvironment already takes when the interpreter is absent.
 *
 * What is left behind is named so the log says where it is, and so the
 * documentation can tell somebody which directory it is safe to delete.
 *
 * @returns {string|null}
 */
export function strandedEnvRoot({ source, dataDir }) {
  return source === "local" ? join(dataDir, "runtime") : null;
}
