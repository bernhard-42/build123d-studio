// What a Makefile offers, as data: which file counts as one, and the targets
// written in it. Pure, so the parsing is tested without a window or a disk.
//
// The targets are read with a regular expression rather than asked of make
// (`make -qp` prints the database, implicit rules and all): the rule is what
// somebody sees when they open the file, and that is the list they expect to
// find in the menu. A target that needs a variable - `bump part=minor` - is
// listed too, and runs without one; make prints the target's own usage line,
// which is the answer the file gives at a prompt as well.

const NAMES = new Set(["Makefile", "makefile", "GNUmakefile"]);

/** Whether a path is a Makefile, by the names make itself looks for. */
export function isMakefile(path) {
  if (typeof path !== "string") {
    return false;
  }
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return NAMES.has(path.slice(slash + 1));
}

// A rule line: one or more names, a colon or two, and not the `=` of an
// assignment (`CC := gcc`, `DIR ::= out`) behind them. Nothing that starts
// with a tab is a rule - that is a recipe, and skipped before this is tried -
// and nothing in a name may be a `%`, `$` or `=`: pattern rules, expansions
// and assignments are make's business, not a menu's.
const RULE = /^\s*([^\s:#=%$][^:#=%$]*?)\s*::?(?![:=])/;

/**
 * The targets a Makefile names, in the order it names them, each once.
 *
 * Dot targets - `.PHONY`, `.DEFAULT_GOAL`, `.SUFFIXES` - are make's own
 * vocabulary and are left out; so is anything a person did not write as a
 * word, which the pattern above already refuses.
 *
 * @param {string} text the file
 * @returns {string[]}
 */
export function makeTargets(text) {
  if (typeof text !== "string") {
    return [];
  }
  const seen = new Set();
  const targets = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("\t")) {
      continue;
    }
    const match = RULE.exec(line);
    if (match === null) {
      continue;
    }
    for (const name of match[1].trim().split(/\s+/)) {
      if (name === "" || name.startsWith(".") || seen.has(name)) {
        continue;
      }
      seen.add(name);
      targets.push(name);
    }
  }
  return targets;
}
