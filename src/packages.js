import { filesystem } from "@neutralinojs/lib";

import { appDir } from "./bootstrap/envroot.js";
import { getSetting, setSetting } from "./store.js";
import {
  insertDependencies,
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
 * Does the shipped uv.lock still describe this environment?
 *
 * Only when nothing has been redirected and nothing has been added. Anything
 * else means uv has to resolve, so `--frozen` would be wrong - it would install
 * the tested combination and quietly ignore what the user asked for.
 */
export function shippedLockApplies(selection = sources, custom = extras) {
  return isDefaultSelection(selection) && parseRequirements(custom).length === 0;
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
 * The pyproject.toml to stage, given the selection.
 *
 * The shipped file is used verbatim when everything is on PyPI, so the common
 * case keeps the exact lock that was tested. Otherwise a [tool.uv.sources]
 * section is appended, which is uv's own mechanism for redirecting a dependency
 * without touching its declaration.
 */
export async function renderPyproject(selection = sources, extras = customPackages()) {
  const base = await filesystem.readFile(`${await appDir()}/runtime/pyproject.toml`);
  const entries = parseRequirements(extras);
  const { dependencies, sources: extraSources } = renderRequirements(entries);

  const ourSources = [];
  for (const p of PACKAGES) {
    if (selection[p.name] === GITHUB) {
      ourSources.push(
        `${p.name} = { git = ${tomlString(p.repository)}, branch = ${tomlString(p.branch)} }`,
      );
      continue;
    }
    if (chosenLocally(selection, p.name)) {
      // Editable: a local checkout is a working copy, and the whole point of
      // choosing one is that what you edit is what runs. Re-install is still
      // there for the times metadata changes rather than code.
      const path = localPathFor(p.name);
      ourSources.push(`${p.name} = { path = ${tomlString(path)}, editable = true }`);
    }
  }

  if (dependencies.length === 0 && ourSources.length === 0 && extraSources.length === 0) {
    // The shipped file verbatim, which is what makes `uv sync --frozen` install
    // exactly the combination this release was tested with.
    return base;
  }

  // Inserted into the existing array rather than appended as a second
  // `dependencies =`, which TOML would reject as a duplicate key. See
  // insertDependencies for why finding the end of that array is not a one-liner.
  const marker = "    # --- custom: added in Settings, and removed by clearing that field ---";
  const rendered =
    dependencies.length === 0 ? base : insertDependencies(base, [marker, ...dependencies]);
  if (rendered === null) {
    // The shipped pyproject.toml is ours, so this is a packaging fault rather
    // than anything the user did. Refusing loudly beats writing a file we could
    // not understand - which is exactly how the array once ended up inside
    // [tool.uv].
    throw new Error("Could not find the dependencies array in the shipped pyproject.toml");
  }

  const allSources = [...ourSources, ...extraSources];
  if (allSources.length === 0) {
    return rendered;
  }
  return `${rendered}
# Written by build123d-studio from the choices made in Settings.
# Edit those rather than this file: it is regenerated on every start.
[tool.uv.sources]
${allSources.join("\n")}
`;
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
