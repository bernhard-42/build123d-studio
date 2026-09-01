// The additional-packages field: what the user typed, and what it becomes.
//
// One entry per line, and the line itself says how the package is installed -
// there is no source picker for these, because the string is the source. Three
// forms, and which one a line is follows from how it starts:
//
//   mylib>=0.3                                    PyPI, with or without a range
//   /Users/me/src/mylib                           a local checkout
//   git+https://github.com/someone/mylib          a git repository
//   mylib @ git+https://github.com/x/python-lib   named explicitly
//
// Nothing here judges whether a requirement is satisfiable, resolvable, or
// spelled correctly. uv does that, it does it properly, and its errors are
// better than anything written here - the same reasoning packages.js already
// applies to build123d. What this file owns is narrower and is not resolution:
// working out what to call a package that was given as a bare path or URL, and
// making sure a line of free text cannot change the structure of the TOML it is
// written into.

// PEP 503 normalisation, which is how Python decides two names are the same
// package: case-insensitive, and runs of -, _ and . are all equivalent. So
// `ocp_tessellate`, `ocp-tessellate` and `OCP.Tessellate` collide with each
// other, and the collision rules below have to see that.
export function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";
// PEP 508's direct reference: `name @ url`. The name cannot contain + or : or /,
// so `git+https://...` never matches this by accident.
const EXPLICIT = new RegExp(`^(${NAME})\\s*@\\s*(\\S.*)$`);
const REQUIREMENT_NAME = new RegExp(`^(${NAME})`);

function looksLikePath(text) {
  return (
    text.startsWith("/") ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

/** Whether a path needs a working directory or a home directory to make sense. */
function relative(text) {
  return text.startsWith("./") || text.startsWith("../") || text.startsWith("~/");
}

function looksLikeGit(text) {
  return (
    text.startsWith("git+") ||
    text.startsWith("http://") ||
    text.startsWith("https://") ||
    text.startsWith("ssh://") ||
    text.endsWith(".git")
  );
}

/**
 * The package name a bare path or URL implies.
 *
 * The last path segment, without a `.git` suffix and without a trailing `@ref`.
 * It is a guess, and it is wrong whenever the distribution is not named after
 * its directory or repository - `python-foo` shipping `foo`, or a package in a
 * subdirectory of a monorepo. That is what the explicit `name @ source` form is
 * for, and why the field's help text mentions it.
 */
function inferName(text) {
  let last = text.replace(/[/\\]+$/, "");
  const cut = Math.max(last.lastIndexOf("/"), last.lastIndexOf("\\"));
  if (cut !== -1) {
    last = last.slice(cut + 1);
  }
  // A git ref, as uv writes it: git+https://host/owner/repo@branch
  const at = last.lastIndexOf("@");
  let ref = null;
  if (at > 0) {
    ref = last.slice(at + 1);
    last = last.slice(0, at);
  }
  last = last.replace(/\.git$/, "");
  return { name: last, ref };
}

/**
 * Parse the field into entries, one per non-empty line.
 *
 * Blank lines and `#` comments are dropped, so the field can be annotated.
 * A line that yields no usable name is returned with an `error` rather than
 * thrown on: the dialog reports every bad line at once, not the first.
 *
 * @returns {Array<{line: number, raw: string, name: string|null, key: string|null,
 *                  requirement: string|null, source: object|null, error: string|null}>}
 */
export function parseRequirements(text) {
  if (typeof text !== "string") {
    return [];
  }

  const entries = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (raw === "" || raw.startsWith("#")) {
      continue;
    }
    const at = { line: index + 1, raw, name: null, key: null, requirement: null, source: null, error: null };

    const explicit = EXPLICIT.exec(raw);
    if (explicit !== null) {
      // Already a PEP 508 direct reference. It carries its own name and needs
      // no [tool.uv.sources] entry - uv understands it as written.
      at.name = explicit[1];
      at.requirement = raw;
    } else if (looksLikePath(raw)) {
      const { name } = inferName(raw);
      at.name = name;
      at.requirement = name;
      // A relative path has nothing to be relative to here.
      //
      // This is a field in a dialog, not a shell, so there is no working
      // directory the user could mean. uv resolves it against the project root,
      // which is the environment under the per-user app-data directory - so
      // "../../src/mylib" points somewhere nobody intended. Refused rather than
      // left to fail, because the dangerous case is not the one that fails: it
      // is the one that resolves to a directory which happens to exist.
      if (relative(raw)) {
        at.error = "give the full path - a relative one has nothing to be relative to here";
      }
      // Editable, because a folder is a working copy: pointing at one and then
      // having to re-install after every edit is not what anybody means by it.
      // uv records this as `source = { editable = "…" }` and the checkout is
      // live in the environment.
      at.source = { path: raw, editable: true };
    } else if (looksLikeGit(raw)) {
      const { name, ref } = inferName(raw);
      at.name = name;
      at.requirement = name;
      at.source = ref === null ? { git: raw } : { git: raw.slice(0, raw.lastIndexOf("@")), rev: ref };
    } else {
      const found = REQUIREMENT_NAME.exec(raw);
      at.name = found === null ? null : found[1];
      at.requirement = raw;
    }

    if (at.name === null || at.name === "") {
      at.error = "cannot tell which package this is";
      at.name = null;
    } else if (at.error === null) {
      at.key = normalizeName(at.name);
    }
    entries.push(at);
  }
  return entries;
}

/**
 * Everything wrong with a set of entries, as sentences a dialog can show.
 *
 * Two rules, and both refuse rather than resolve. The custom field *adds*
 * packages; it does not modify the ones the application declares. Merging the
 * two was considered and dropped, because uv intersects duplicate declarations
 * rather than letting the later one win - so `ocp-tessellate>3.4.0,<3.5` beside
 * a frozen `ocp_tessellate==3.4.1` silently resolves to 3.4.1, and the user's
 * entry does nothing at all. Measured, not assumed. Refusing says so.
 *
 * @param entries from parseRequirements
 * @param declared normalised names the application declares itself
 */
export function findProblems(entries, declared) {
  const problems = [];
  const seen = new Map();
  const reserved = new Set(declared.map(normalizeName));

  for (const entry of entries) {
    if (entry.error !== null) {
      problems.push(`Line ${entry.line}: ${entry.error} - ${entry.raw}`);
      continue;
    }
    if (reserved.has(entry.key)) {
      problems.push(
        `Line ${entry.line}: ${entry.name} is already part of the application and cannot be set here.`,
      );
      continue;
    }
    const first = seen.get(entry.key);
    if (first !== undefined) {
      problems.push(`Line ${entry.line}: ${entry.name} is already given on line ${first}.`);
      continue;
    }
    seen.set(entry.key, entry.line);
  }
  return problems;
}

/**
 * Why a package redirected to a local checkout cannot be applied, or null.
 *
 * The picker's rule rather than this field's, kept here because it is the same
 * rule and `relative` and `looksLikePath` are the definition of "absolute
 * enough" - two copies of that would eventually disagree about `~/src`.
 *
 * An empty path is tolerated at startup on purpose: `renderPyproject` drops a
 * source it has no path for, so the declared version applies and a half-made
 * setting cannot stop the application starting. In the dialog it is a question
 * still being answered, and saving it would store a choice that silently does
 * nothing - the user picks "local checkout", presses Apply, and gets PyPI.
 *
 * @param {string} label  the package name, for the message
 * @param {string} path   the folder as typed
 * @returns {string|null}
 */
export function localSourceProblem(label, path) {
  const chosen = path.trim();
  if (chosen === "") {
    return `${label}: choose a folder for the local checkout, or put it back on PyPI`;
  }
  if (relative(chosen) || !looksLikePath(chosen)) {
    return `${label}: give the full path - a relative one has nothing to be relative to here`;
  }
  return null;
}

/**
 * Escape a value for a TOML basic string.
 *
 * This is the whole of what this module owes the file's integrity. A line
 * carrying a quote must not be able to close the string it sits in, end the
 * dependencies array and open a table of its own - which is how free text in a
 * generated file redirects a frozen package. It makes no judgement about the
 * content: `nonsense-!!!` is escaped faithfully and uv says what is wrong with
 * it.
 */
export function tomlString(value) {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}


/**
 * The dependency lines and the [tool.uv.sources] entries a set of entries needs.
 *
 * `editables` names the ones installed from a local checkout, which need one
 * more thing said about them - see editableBuildFlags.
 *
 * @returns {{dependencies: string[], sources: string[], editables: string[], names: string[]}}
 *          all already escaped
 */
export function renderRequirements(entries) {
  const dependencies = [];
  const sources = [];
  const editables = [];
  const names = [];
  for (const entry of entries) {
    if (entry.error !== null) {
      continue;
    }
    names.push(entry.name);
    dependencies.push(`    ${tomlString(entry.requirement)},`);
    if (entry.source === null) {
      continue;
    }
    if (entry.source.editable === true) {
      editables.push(entry.name);
    }
    const fields = Object.entries(entry.source)
      .map(([key, value]) =>
        // A TOML boolean is bare; only strings are quoted. `editable = "true"`
        // is a string and uv rejects it.
        typeof value === "boolean" ? `${key} = ${value}` : `${key} = ${tomlString(value)}`,
      )
      .join(", ");
    sources.push(`${entry.name} = { ${fields} }`);
  }
  return { dependencies, sources, editables, names };
}

/**
 * Tell uv to install local checkouts the way a static analyser can follow.
 *
 * setuptools has two editable layouts and picks between them by project shape.
 * For a src-layout checkout it writes a .pth holding one directory. For a
 * flat-layout one - a repository with tests/ and doc/ beside the package - it
 * refuses to put that root on the path and installs an import hook instead,
 * whose mapping of module to directory exists only while Python is running.
 *
 * basedpyright reads .pth files and executes nothing, so the second kind
 * imports perfectly in the kernel and is an unresolved import in the editor -
 * the same checkout, correct at runtime and underlined on screen.
 *
 * On the command line rather than in the generated pyproject.toml, where
 * `[tool.uv.config-settings-package.<name>]` says exactly this and is the
 * documented place for it. Measured: uv runs here with UV_NO_CONFIG=1, which
 * keeps the user's own uv configuration out of the application's environment
 * and, in the same stroke, makes uv ignore that table - it reports "Checked"
 * and leaves the hook in place. The flag is not configuration, so it survives.
 *
 * `compat` is setuptools' name for the older layout, which is always a path.
 * Per package rather than globally because it is a setuptools setting: a
 * checkout built by another backend has no use for it, and PEP 517 backends
 * ignore config settings they do not know. Measured on a src-layout checkout:
 * the .pth is identical either way, so this costs the ordinary case nothing.
 *
 * @param {string[]} names packages installed from a local checkout
 * @returns {string[]} arguments to append to a `uv sync`
 */
export function editableBuildFlags(names) {
  return names.flatMap((name) => ["--config-settings-package", `${name}:editable_mode=compat`]);
}


/**
 * Tell uv which packages an upgrade is allowed to move.
 *
 * "Upgrade packages" used to be a blanket `uv lock --upgrade`, on the reasoning
 * that the exact pins in runtime/pyproject.toml were already the guarantee and
 * a name list only restated them. That is true of the six packages this
 * application pins with `==`. It is not true of anything else, and the
 * environment is 84 packages against 8 declarations - so the reasoning covered
 * a twelfth of what the button touched.
 *
 * Measured on the shipped lock: `uv lock --upgrade` moved 23 packages and
 * neither of the two the button exists for, both already being newest. What
 * moved was jupyter-client, pyzmq, ipython, traitlets, tornado, numpy, scipy,
 * cffi and nodejs-wheel-binaries - the kernel's transport, the language
 * server's own Node runtime and the viewer's numerics, none of them named
 * anywhere, all of them landing on combinations no release ever tested.
 *
 * So the names are back, and they are every package somebody declared: the two
 * with a range of their own, plus whatever is in the additional-packages field.
 * The source does not have to be told apart, because uv already does the right
 * thing for each - measured: a version moves within its range, a git ref
 * re-resolves to the branch's current commit, and a local path is a no-op that
 * exits 0. Filtering to PyPI would only take the git case away, which is the
 * one source that genuinely drifts.
 *
 * What no longer moves is the 76 packages nobody declared. They move when a
 * release of this application moves them, which is the only place they were
 * ever tested.
 *
 * @param {string[]} names packages the user declared
 * @returns {string[]} arguments to append to a `uv lock`
 */
export function upgradeFlags(names) {
  return names.flatMap((name) => ["--upgrade-package", name]);
}


/**
 * The lines a user would have typed, given what the file records.
 *
 * The inverse of parseRequirements, and it exists because the two halves of a
 * line are stored apart: `/Users/me/src/cadquery` becomes `cadquery` in the
 * dependency group and a `{ path = ... }` entry in [tool.uv.sources]. Reading
 * back only the group put `cadquery` in the field where a path had been typed -
 * still installed from the checkout, because the source was untouched, but the
 * field no longer said so, and pressing Apply would then have written a plain
 * PyPI requirement over it.
 *
 * Only the group's own entries are looked up, so a source belonging to
 * build123d or ocp-viewer-core - which live in the same table - is never
 * mistaken for one of these.
 *
 * @param {string[]} entries the `user` group, as written
 * @param {Object<string, string>} sources from sourceEntries
 */
export function requirementLines(entries, sources) {
  return entries.map((requirement) => {
    const name = /^[A-Za-z0-9._-]+/.exec(requirement);
    const source = name === null ? undefined : sources[name[0]];
    if (source === undefined) {
      // Either a plain PyPI requirement or the `name @ url` form, which carries
      // its own source and never produced a [tool.uv.sources] entry.
      return requirement;
    }

    const path = /\bpath\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(source);
    if (path !== null) {
      // Unescaped, because tomlString wrote it - a Windows path is full of them.
      return path[1].replace(/\\(.)/g, "$1");
    }

    const git = /\bgit\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(source);
    if (git !== null) {
      const rev = /\brev\s*=\s*"([^"]*)"/.exec(source);
      return rev === null ? git[1] : `${git[1]}@${rev[1]}`;
    }

    // A source shape this cannot spell. Showing the requirement is honest -
    // it is what the group says - and Apply would rewrite the source from it,
    // which is why anything unusual belongs in the file rather than here.
    return requirement;
  });
}
