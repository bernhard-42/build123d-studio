// The additional-packages field: what the user typed, and what it becomes.
//
// One entry per line, and the line itself says how the package is installed -
// there is no source picker for these, because the string is the source. Three
// forms, and which one a line is follows from how it starts:
//
//   ocp-widgets>=0.3                              PyPI, with or without a range
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
 * Insert lines at the end of pyproject.toml's `dependencies` array.
 *
 * This looked like a one-liner and was a bug: the first version inserted at the
 * file's last `]`, which is the one in `[tool.uv]`, not the end of the array.
 * It produced `[tool.uv` with the packages inside it and uv refused to parse the
 * file at all - on a real build, because the function lived in a module that
 * imports Neutralino and so had no tests. It lives here now for that reason.
 *
 * The array is found by scanning rather than by matching a shape, so it does not
 * depend on how the shipped file happens to be formatted: bracket depth from
 * `dependencies = [`, with quoted strings and `#` comments skipped so a bracket
 * inside either cannot end it early.
 *
 * @returns {string|null} the file with the lines inserted, or null if the array
 *   could not be found - which the caller must treat as a reason not to write
 */
export function insertDependencies(base, lines) {
  if (lines.length === 0) {
    return base;
  }
  const start = base.search(/^\s*dependencies\s*=\s*\[/m);
  if (start === -1) {
    return null;
  }

  let index = base.indexOf("[", start);
  let depth = 0;
  while (index < base.length) {
    const char = base[index];
    if (char === "#") {
      const newline = base.indexOf("\n", index);
      index = newline === -1 ? base.length : newline;
      continue;
    }
    if (char === '"' || char === "'") {
      index += 1;
      while (index < base.length && base[index] !== char) {
        index += base[index] === "\\" ? 2 : 1;
      }
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return `${base.slice(0, index)}${lines.join("\n")}\n${base.slice(index)}`;
      }
    }
    index += 1;
  }
  return null;
}

/**
 * The dependency lines and the [tool.uv.sources] entries a set of entries needs.
 *
 * @returns {{dependencies: string[], sources: string[]}} both already escaped
 */
export function renderRequirements(entries) {
  const dependencies = [];
  const sources = [];
  for (const entry of entries) {
    if (entry.error !== null) {
      continue;
    }
    dependencies.push(`    ${tomlString(entry.requirement)},`);
    if (entry.source === null) {
      continue;
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
  return { dependencies, sources };
}
