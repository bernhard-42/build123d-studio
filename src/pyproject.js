// Reading and editing the environment's pyproject.toml, without a TOML parser.
//
// The file is the user's now. It is written once when an environment is built,
// and after that this application touches three regions and nothing else:
//
//   [project] and the `app` and `core_cad` groups   replaced by a new release
//   the `user` group                                written by Settings
//   [tool.uv.sources]                               written by Settings
//
// Everything else - a comment somebody wrote, an [[tool.uv.index]] pointing at
// a company mirror, a constraint they added - is theirs and survives all of it.
// That is the whole reason this module exists rather than a generator: the file
// used to be produced wholesale from settings on every start, so an edit lasted
// until the next launch. See the banner at the top of runtime/pyproject.toml.
//
// **No TOML parser, deliberately.** Not to avoid a dependency but because a
// parser that round-trips is the one thing that would let this module rewrite
// parts of the file nobody asked it to touch. Line surgery over named regions
// can only damage the region it was pointed at, and when it cannot find one it
// says so and the caller disables that control - see regionOf returning null.
//
// Pure, and tested, for the reason keys.js and quoting.js are: every function
// here is a decision about text, and the ways they go wrong are all silent.

/** The `version` under [project], or null when the file has none. */
export function projectVersion(text) {
  const table = regionOf(text, "[project]");
  if (table === null) {
    return null;
  }
  const found = /^\s*version\s*=\s*"([^"]*)"/m.exec(text.slice(table.start, table.end));
  return found === null ? null : found[1];
}

/**
 * Where a top-level table lives, or null.
 *
 * From its header to the next line that starts a table at the top level - a
 * `[name]` or `[[name]]` in column zero. Sub-tables belong to their parent and
 * are deliberately included: `[project.optional-dependencies]` is part of
 * [project], and replacing the one without the other would leave half a table
 * describing a release that is gone.
 *
 * @returns {{start: number, end: number}|null} offsets into `text`
 */
export function regionOf(text, header) {
  const lines = text.split("\n");
  let start = null;
  let offset = 0;
  let startOffset = 0;
  const prefix = `${header.slice(0, -1)}.`;

  for (const line of lines) {
    const isTable = /^\[\[?[^\]]+\]\]?\s*$/.test(line);
    if (start === null) {
      if (line.trimEnd() === header) {
        start = true;
        startOffset = offset;
      }
    } else if (isTable && line.trimEnd() !== header && !line.startsWith(prefix)) {
      return { start: startOffset, end: offset };
    }
    offset += line.length + 1;
  }
  return start === null ? null : { start: startOffset, end: text.length };
}

/**
 * The entries of one dependency group, as written.
 *
 * Returns the requirement strings only - the comments between them are the
 * user's and are not this application's to hand around. Null when the group is
 * not there at all, which is a different answer from an empty group and is what
 * tells Settings to disable the field rather than to show it empty.
 *
 * @returns {string[]|null}
 */
export function groupEntries(text, name) {
  const array = arrayOf(text, "[dependency-groups]", name);
  if (array === null) {
    return null;
  }
  return [...array.body.matchAll(/^\s*"([^"]*)"/gm)].map((m) => m[1]);
}

/**
 * Replace one dependency group's entries, leaving its comments in place above.
 *
 * The array is rewritten between its brackets and nothing outside them is
 * touched, so the section comment that says whose group it is survives - and so
 * does every other group in the table.
 */
export function replaceGroup(text, name, entries) {
  const array = arrayOf(text, "[dependency-groups]", name);
  if (array === null) {
    return null;
  }
  const written = entries.length === 0
    ? "[]"
    : `[\n${entries.map((entry) => `    "${entry}",`).join("\n")}\n]`;
  return text.slice(0, array.start) + `${name} = ${written}` + text.slice(array.end);
}

/**
 * The `key = [ ... ]` array of a named key inside a table.
 *
 * Bracket counting rather than a regex to the first `]`, because a requirement
 * can hold one: `foo[extra]>=1` is a perfectly ordinary line and matching
 * lazily would end the array in the middle of it.
 *
 * @returns {{start: number, end: number, body: string}|null}
 */
function arrayOf(text, header, key) {
  const table = regionOf(text, header);
  if (table === null) {
    return null;
  }
  const section = text.slice(table.start, table.end);
  const opening = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m").exec(section);
  if (opening === null) {
    return null;
  }

  const from = opening.index + opening[0].length;
  let depth = 1;
  let at = from;
  for (; at < section.length && depth > 0; at += 1) {
    if (section[at] === "[") {
      depth += 1;
    } else if (section[at] === "]") {
      depth -= 1;
    }
  }
  if (depth !== 0) {
    // An array nobody closed. Refusing is the only safe answer: writing into it
    // would append to whatever follows.
    return null;
  }
  return {
    start: table.start + opening.index + opening[0].indexOf(key),
    end: table.start + at,
    body: section.slice(from, at - 1),
  };
}

/**
 * The environment's file, brought up to what this release declares.
 *
 * Built by replacing the shipped file's regions in the user's - [project]'s
 * metadata, and the `app` and `core_cad` groups. [project].dependencies is
 * explicitly *not* one of them: see below. The direction matters:
 * everything not named here is carried over untouched, so a user's own
 * `[[tool.uv.index]]`, their `user` group and their comments all survive a
 * release. The alternative - build from the shipped file and copy the user's
 * regions across - loses whatever nobody thought to name.
 *
 * When the environment's file has no such region, the shipped one's is
 * appended rather than dropped: a file somebody deleted `[dependency-groups]`
 * out of should come back working, not come back missing the application.
 *
 * @param {string} envText the environment's pyproject.toml
 * @param {string} shippedText the one inside the application
 */
export function spliceRelease(envText, shippedText) {
  let text = replaceRegion(envText, shippedText, "[project]");

  // [project].dependencies comes back, and that is not a detail. This
  // application ships it empty and never puts anything in it, but `uv add` -
  // the obvious thing for a Python user to type - writes there rather than into
  // a group. Replacing [project] wholesale therefore discarded exactly what
  // somebody had just asked uv to record, silently, at the next update.
  const theirs = arrayOf(envText, "[project]", "dependencies");
  const ours = arrayOf(text, "[project]", "dependencies");
  if (theirs !== null && ours !== null) {
    text = text.slice(0, ours.start)
      + envText.slice(theirs.start, theirs.end)
      + text.slice(ours.end);
  }

  for (const group of ["app", "core_cad"]) {
    text = replaceGroupFrom(text, shippedText, group);
  }
  return text;
}

function replaceRegion(envText, shippedText, header) {
  const shipped = regionOf(shippedText, header);
  if (shipped === null) {
    return envText;
  }
  const replacement = shippedText.slice(shipped.start, shipped.end);
  const mine = regionOf(envText, header);
  if (mine === null) {
    return `${envText.trimEnd()}\n\n${replacement.trimEnd()}\n`;
  }
  return envText.slice(0, mine.start) + replacement + envText.slice(mine.end);
}

function replaceGroupFrom(envText, shippedText, name) {
  // The shipped array's *text*, not its entries rebuilt from them. These two
  // groups are the application's, so what a release ships is the formatting as
  // well as the requirements - the blank line inside `app` that separates the
  // exact pins from the capped ones is part of what it is saying. Rebuilding
  // them also made the splice non-idempotent, which is a property worth having:
  // splicing a file that is already current must return it unchanged.
  const shipped = arrayOf(shippedText, "[dependency-groups]", name);
  if (shipped === null) {
    return envText;
  }
  const replacement = shippedText.slice(shipped.start, shipped.end);

  const mine = arrayOf(envText, "[dependency-groups]", name);
  if (mine !== null) {
    return envText.slice(0, mine.start) + replacement + envText.slice(mine.end);
  }

  // The group is gone from the environment's file. Put it back at the foot of
  // the table, or the whole table back if that is missing too.
  const table = regionOf(envText, "[dependency-groups]");
  if (table === null) {
    return `${envText.trimEnd()}\n\n[dependency-groups]\n${replacement}\n`;
  }
  const end = envText.slice(0, table.end).trimEnd().length;
  return `${envText.slice(0, end)}\n${replacement}\n${envText.slice(end)}`;
}

/**
 * What [tool.uv.sources] says, as a map of package to its source line.
 *
 * The value is kept as written rather than parsed into fields: Settings only
 * needs to know which package is redirected and to what, and an inline table
 * somebody wrote by hand is theirs to keep the shape of.
 *
 * @returns {Object<string, string>} empty when the table is absent
 */
export function sourceEntries(text) {
  const table = regionOf(text, "[tool.uv.sources]");
  if (table === null) {
    return {};
  }
  const entries = {};
  const body = text.slice(table.start, table.end);
  for (const [, name, value] of body.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*(\{.*\})\s*$/gm)) {
    entries[name] = value;
  }
  return entries;
}

/**
 * Write [tool.uv.sources], or remove it when there is nothing to say.
 *
 * Removed rather than left empty, because an empty table is a thing a reader
 * has to work out the meaning of, and "no redirections" has a perfectly good
 * spelling already: no table.
 *
 * @param {Object<string, string>} entries package -> inline table, as written
 */
export function replaceSources(text, entries) {
  const table = regionOf(text, "[tool.uv.sources]");
  const names = Object.keys(entries);

  if (names.length === 0) {
    if (table === null) {
      return text;
    }
    return `${text.slice(0, table.start).trimEnd()}\n${text.slice(table.end)}`;
  }

  const written = `[tool.uv.sources]\n${names.map((n) => `${n} = ${entries[n]}`).join("\n")}\n`;
  if (table === null) {
    return `${text.trimEnd()}\n\n${written}`;
  }
  return text.slice(0, table.start) + written + text.slice(table.end);
}
