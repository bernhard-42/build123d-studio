import { filesystem } from "@neutralinojs/lib";

import { appDir } from "./bootstrap/envroot.js";
import { getSetting, setSetting } from "./store.js";
import { run } from "./proc.js";
import * as log from "./log.js";

// Which source each upgradable package comes from.
//
// Only build123d and bd_warehouse are offered. Everything else in the
// environment is frozen: ocp_vscode is tied to the three-cad-viewer build in the
// frontend, and ocp_tessellate follows ocp_vscode. See runtime/pyproject.toml.
//
// No attempt is made to police which combinations are compatible. bd_warehouse
// tracks build123d, and the constraint between them changes with every release,
// so encoding it here would be wrong within weeks. uv refuses an unsatisfiable
// combination on its own, and a failed change is rolled back rather than left
// to break the next start.

const STORAGE_KEY = "packageSources";

export const PYPI = "pypi";
export const GITHUB = "github";

export const PACKAGES = [
  {
    name: "build123d",
    repository: "https://github.com/gumyr/build123d",
    // build123d's default branch is "dev", not "main".
    branch: "dev",
  },
  {
    name: "bd_warehouse",
    repository: "https://github.com/gumyr/bd_warehouse",
    branch: "main",
  },
];

const DEFAULTS = Object.fromEntries(PACKAGES.map((p) => [p.name, PYPI]));

let sources = { ...DEFAULTS };
let gitAvailable = null;

export function packageSources() {
  return { ...sources };
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
      if (stored[p.name] === PYPI || stored[p.name] === GITHUB) {
        sources[p.name] = stored[p.name];
      }
    }
  }

  // A stored GitHub choice is worthless if git has since disappeared; fall back
  // rather than fail every start.
  if (Object.values(sources).includes(GITHUB) && !(await hasGit())) {
    log.warn("git is not available; reverting package sources to PyPI");
    sources = { ...DEFAULTS };
  }
  return packageSources();
}

export async function savePackageSources(selection) {
  sources = { ...DEFAULTS, ...selection };
  await setSetting(STORAGE_KEY, { ...sources });
  return packageSources();
}

/**
 * The pyproject.toml to stage, given the selection.
 *
 * The shipped file is used verbatim when everything is on PyPI, so the common
 * case keeps the exact lock that was tested. Otherwise a [tool.uv.sources]
 * section is appended, which is uv's own mechanism for redirecting a dependency
 * without touching its declaration.
 */
export async function renderPyproject(selection = sources) {
  const base = await filesystem.readFile(`${await appDir()}/runtime/pyproject.toml`);
  if (isDefaultSelection(selection)) {
    return base;
  }

  const lines = PACKAGES.filter((p) => selection[p.name] === GITHUB).map(
    (p) => `${p.name} = { git = "${p.repository}", branch = "${p.branch}" }`,
  );

  return `${base}
# Written by build123d-studio from the package sources chosen in the config dialog.
# Edit that dialog rather than this file: it is regenerated on every start.
[tool.uv.sources]
${lines.join("\n")}
`;
}

/** A short string that changes whenever the selection does. */
export function selectionSignature(selection = sources) {
  return PACKAGES.map((p) => `${p.name}=${selection[p.name]}`).join(",");
}
