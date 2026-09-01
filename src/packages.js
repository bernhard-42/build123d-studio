import { getSetting, setSetting } from "./store.js";
import {
  parseRequirements,
  renderRequirements,
  tomlString,
} from "./requirements.js";
import { run } from "./proc.js";
import * as log from "./log.js";

// Which source each upgradable package comes from.
//
// Only build123d is offered. Everything else the application declares is frozen:
// ocp-viewer-core is tied to the three-cad-viewer build in the frontend - both
// halves of it ship as one version - and it owns ocp_tessellate's range through
// its own metadata. See runtime/pyproject.toml.
// Anything else a user wants goes in the additional-packages field, where the
// line itself says where the package comes from.
//
// No attempt is made to police which combinations are compatible. uv refuses an
// unsatisfiable combination on its own and explains it better than a rule here
// could, and a failed change is rolled back rather than left to break the next
// start.

const STORAGE_KEY = "packageSources";
const LOCAL_PATH_KEY = "packageLocalPaths";
const CUSTOM_KEY = "customPackages";

export const PYPI = "pypi";
export const GITHUB = "github";
export const LOCAL = "local";

export const PACKAGES = [
  {
    name: "build123d",
    repository: "https://github.com/gumyr/build123d",
    // build123d's default branch is "dev", not "main".
    branch: "dev",
  },
  {
    // The shared viewer half, on PyPI and pinned like everything else. Offered
    // here because it is the half most likely to be worked on beside this
    // application: a uv source wins over whatever the dependency itself says -
    // measured - so choosing GitHub or a local checkout redirects it entirely.
    name: "ocp-viewer-core",
    repository: "git@github.com:bernhard-42/ocp-viewer-core",
    branch: "main",
  },
];

// Everything the application declares for itself, which the additional-packages
// field may not name. Kept here rather than parsed out of the shipped
// pyproject.toml: this list is what the *rule* is about, and reading it from a
// file would make a refusal depend on a parse of TOML we deliberately do not do.
//
// ocp-tessellate is deliberately absent. Nothing here imports it - it arrives
// under ocp-viewer-core, which owns its range - so constraining it is the
// user's business, and uv enforces the parent's range on top of whatever they
// write. Anything that *is* on this list must be refused in the
// additional-packages field, because uv intersects duplicate declarations
// rather than letting the later one win: a user asking for an older version
// would get an unsolvable environment instead of their version.
export const DECLARED = [
  "ocp-viewer-core",
  "jupyter_console",
  "orjson",
  "websockets",
  "pywinpty",
  "basedpyright",
  "build123d",
];

const DEFAULTS = Object.fromEntries(PACKAGES.map((p) => [p.name, PYPI]));

let sources = { ...DEFAULTS };
let localPaths = {};
let extras = "";
let gitAvailable = null;

export function packageSources() {
  return { ...sources };
}

/** Where a package redirected to LOCAL lives, or "" if none has been chosen. */
export function localPathFor(name) {
  const path = localPaths[name];
  return typeof path === "string" ? path : "";
}

/** The additional-packages field, as the user typed it. */
export function customPackages() {
  return extras;
}

export function isDefaultSelection(selection = sources) {
  return PACKAGES.every((p) => selection[p.name] === PYPI);
}


/**
 * Is a git binary available?
 *
 * uv resolves git refs over HTTPS on its own, but `uv sync` shells out to git
 * to fetch and build - it fails with "Git executable not found" otherwise. The
 * PyPI sources never need it, so this only gates the GitHub option.
 */
export async function hasGit() {
  if (gitAvailable !== null) {
    return gitAvailable;
  }
  try {
    const code = await run("git --version", {});
    gitAvailable = code === 0;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

export async function loadPackageSources() {
  const stored = getSetting(STORAGE_KEY);
  if (typeof stored === "object" && stored !== null) {
    for (const p of PACKAGES) {
      if (stored[p.name] === PYPI || stored[p.name] === GITHUB || stored[p.name] === LOCAL) {
        sources[p.name] = stored[p.name];
      }
    }
  }

  const paths = getSetting(LOCAL_PATH_KEY);
  if (typeof paths === "object" && paths !== null) {
    for (const p of PACKAGES) {
      if (typeof paths[p.name] === "string") {
        localPaths[p.name] = paths[p.name];
      }
    }
  }

  const custom = getSetting(CUSTOM_KEY);
  extras = typeof custom === "string" ? custom : "";

  // A stored GitHub choice is worthless if git has since disappeared; fall back
  // rather than fail every start. A local path is not checked here - it may sit
  // on a volume that is not mounted yet, and uv reports a missing one far more
  // clearly than a guess made at startup would.
  if (Object.values(sources).includes(GITHUB) && !(await hasGit())) {
    log.warn("git is not available; reverting package sources to PyPI");
    sources = { ...DEFAULTS };
  }
  return packageSources();
}

/** Store the additional-packages text. Validation belongs to the dialog. */
export async function saveCustomPackages(text) {
  extras = typeof text === "string" ? text : "";
  await setSetting(CUSTOM_KEY, extras);
  return extras;
}

export async function saveLocalPaths(paths) {
  localPaths = { ...paths };
  await setSetting(LOCAL_PATH_KEY, { ...localPaths });
  return { ...localPaths };
}

export async function savePackageSources(selection) {
  sources = { ...DEFAULTS, ...selection };
  await setSetting(STORAGE_KEY, { ...sources });
  return packageSources();
}

/** Whether this package is redirected to a checkout on this machine.
 *
 * A local choice with no path chosen yet is not an error worth failing a start
 * over - it simply has nothing to redirect, so the declared version applies as
 * it would on PyPI. Both the source entry and the build settings hang off this
 * one answer, so they cannot disagree about what a local checkout is.
 */
function chosenLocally(selection, name) {
  return selection[name] === LOCAL && localPathFor(name) !== "";
}

/**
 * The requirement strings for the `user` group, from the additional-packages
 * field.
 *
 * A line the user has mistyped contributes nothing, exactly as it contributes
 * nothing to what uv is asked to install. findProblems is what tells them why;
 * this only has to be sure a broken line cannot reach the file.
 */
export function userGroupEntries(extras = customPackages()) {
  return parseRequirements(extras)
    .filter((entry) => entry.error === null)
    .map((entry) => entry.requirement);
}

/**
 * What [tool.uv.sources] should say, as package -> inline table.
 *
 * Both halves of it: the two packages with a source picker, and any entry in
 * the additional-packages field that named a path or a git URL rather than a
 * plain requirement.
 */
export function projectSources(selection = sources, extras = customPackages()) {
  const entries = {};

  for (const p of PACKAGES) {
    if (selection[p.name] === GITHUB) {
      entries[p.name] = `{ git = ${tomlString(p.repository)}, branch = ${tomlString(p.branch)} }`;
      continue;
    }
    if (chosenLocally(selection, p.name)) {
      // Editable: a local checkout is a working copy, and the whole point of
      // choosing one is that what you edit is what runs.
      entries[p.name] = `{ path = ${tomlString(localPathFor(p.name))}, editable = true }`;
    }
  }

  for (const entry of parseRequirements(extras)) {
    if (entry.error !== null || entry.source === null) {
      continue;
    }
    const fields = Object.entries(entry.source)
      .map(([key, value]) =>
        // A TOML boolean is bare; only strings are quoted. `editable = "true"`
        // is a string and uv rejects it.
        typeof value === "boolean" ? `${key} = ${value}` : `${key} = ${tomlString(value)}`,
      )
      .join(", ");
    entries[entry.name] = `{ ${fields} }`;
  }

  return entries;
}

/**
 * Every package the file installs from a working copy on disk.
 *
 * From [tool.uv.sources] rather than from settings.json, for the same reason
 * the dialog is: the file is what uv reads. A checkout somebody added by hand
 * needs `editable_mode=compat` exactly as much as one chosen in the dialog, and
 * deriving this from the settings meant the hand-added one was underlined in
 * the editor as an unresolved import - correct at runtime, wrong on screen.
 * See editableBuildFlags for why that setting is needed at all.
 *
 * @param {Object<string, string>} entries from sourceEntries
 */
export function checkoutsFromSources(entries) {
  return Object.entries(entries)
    .filter(([, written]) => /\bpath\s*=/.test(written) && /\beditable\s*=\s*true\b/.test(written))
    .map(([name]) => name);
}

/**
 * The source picker state the file implies.
 *
 * The dialog is filled from pyproject.toml rather than from settings.json,
 * because the file is what uv reads and therefore what is true. A package with
 * a `git =` source is on its branch, one with a `path =` is a local checkout,
 * and one with no entry at all is on PyPI - which is the whole vocabulary the
 * two radio rows can express.
 *
 * A source the dialog cannot express - a git URL with a rev, say, or a path
 * that is not editable - still reads as GitHub or Local, because that is what
 * it is. Applying would rewrite it in the dialog's own spelling, which is why
 * Apply is a deliberate act and a start no longer writes this file at all.
 *
 * @param {Object<string, string>} entries from sourceEntries
 * @returns {{selection: Object<string, string>, localPaths: Object<string, string>}}
 */
export function selectionFromSources(entries) {
  const selection = {};
  const localPaths = {};
  for (const p of PACKAGES) {
    const written = entries[p.name];
    if (written === undefined) {
      selection[p.name] = PYPI;
      continue;
    }
    if (/\bgit\s*=/.test(written)) {
      selection[p.name] = GITHUB;
      continue;
    }
    const path = /\bpath\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(written);
    if (path === null) {
      selection[p.name] = PYPI;
      continue;
    }
    selection[p.name] = LOCAL;
    // Unescaped, because tomlString wrote it: a Windows path is full of them.
    localPaths[p.name] = path[1].replace(/\\(.)/g, "$1");
  }
  return { selection, localPaths };
}

/**
 * Every package installed from a local checkout, whichever way it was chosen.
 *
 * The source picker and the additional-packages field both produce them, and
 * both kinds need the same thing said to uv when they are installed - see
 * editableBuildFlags.
 *
 * @returns {string[]} package names, in no particular order
 */
export function localCheckouts(selection = sources, extras = customPackages()) {
  const ours = PACKAGES.filter((p) => chosenLocally(selection, p.name)).map((p) => p.name);
  const { editables } = renderRequirements(parseRequirements(extras));
  return [...ours, ...editables];
}


/** A short string that changes whenever the selection does. */
export function selectionSignature(selection = sources) {
  return PACKAGES.map((p) => `${p.name}=${selection[p.name]}`).join(",");
}
