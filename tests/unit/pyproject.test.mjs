// node --test tests/unit/pyproject.test.mjs
//
// The environment's pyproject.toml is the user's file. Every function here can
// damage it, and every way it does so is quiet: a splice that drops somebody's
// package index, a group rewrite that eats the comment above it, a version read
// that returns null and makes a release apply on every single start.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  groupEntries,
  projectVersion,
  regionOf,
  replaceGroup,
  replaceSources,
  sourceEntries,
  spliceRelease,
} from "../../src/pyproject.js";

const SHIPPED = readFileSync(new URL("../../runtime/pyproject.toml", import.meta.url), "utf8");

/** A file as a user might have left it, with their own things in it. */
const THEIRS = `# their own note at the top

[project]
name = "build123d-studio-runtime"
version = "0.4.9"
requires-python = "==3.14.*"
dependencies = []

[dependency-groups]
app = [
    "ruff==0.16.1",
]
core_cad = [
    "build123d>=0.11.0",
]
# the comment above their own group
user = [
    "cadquery",
    "mylib[extra]>=0.3",
]

[tool.uv]
package = false
default-groups = ["app", "core_cad", "user"]

[[tool.uv.index]]
name = "company"
url = "https://packages.example.com/simple"
`;

// --- reading ---------------------------------------------------------------

test("the version stamp is read from [project]", () => {
  assert.equal(projectVersion(THEIRS), "0.4.9");
  assert.equal(projectVersion(SHIPPED), JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).version);
});

test("a file without [project] has no version rather than a wrong one", () => {
  // Null is what makes the caller leave the file alone. A guess would make a
  // release re-apply itself on every start, for ever.
  assert.equal(projectVersion("[dependency-groups]\nuser = []\n"), null);
});

test("a group's entries are read as written", () => {
  assert.deepEqual(groupEntries(THEIRS, "user"), ["cadquery", "mylib[extra]>=0.3"]);
  assert.deepEqual(groupEntries(THEIRS, "core_cad"), ["build123d>=0.11.0"]);
});

test("a group that is not there is null, which is not the same as empty", () => {
  assert.equal(groupEntries(THEIRS, "nosuch"), null);
  assert.deepEqual(groupEntries("[dependency-groups]\nuser = []\n", "user"), []);
});

test("an extra in brackets does not end the array early", () => {
  // `foo[extra]>=1` is an ordinary requirement, and a lazy match to the first
  // "]" would cut the group in half at it.
  const entries = groupEntries('[dependency-groups]\nuser = [\n    "a[b]>=1",\n    "c",\n]\n', "user");
  assert.deepEqual(entries, ["a[b]>=1", "c"]);
});

test("a table runs to the next top-level table, and swallows its own sub-tables", () => {
  const region = regionOf(THEIRS, "[tool.uv]");
  const text = THEIRS.slice(region.start, region.end);
  assert.ok(text.includes("default-groups"));
  assert.ok(!text.includes("[[tool.uv.index]]"), "a separate table is not part of it");
});

// --- writing ---------------------------------------------------------------

test("replacing a group leaves the comment above it alone", () => {
  const written = replaceGroup(THEIRS, "user", ["cadquery", "numpy"]);
  assert.ok(written.includes("# the comment above their own group"));
  assert.deepEqual(groupEntries(written, "user"), ["cadquery", "numpy"]);
});

test("emptying a group writes an empty array rather than removing it", () => {
  const written = replaceGroup(THEIRS, "user", []);
  assert.deepEqual(groupEntries(written, "user"), []);
});

test("replacing one group does not touch the others", () => {
  const written = replaceGroup(THEIRS, "user", []);
  assert.deepEqual(groupEntries(written, "app"), ["ruff==0.16.1"]);
  assert.deepEqual(groupEntries(written, "core_cad"), ["build123d>=0.11.0"]);
});

// --- the release splice ----------------------------------------------------

test("a release replaces its own regions", () => {
  const spliced = spliceRelease(THEIRS, SHIPPED);
  assert.equal(projectVersion(spliced), projectVersion(SHIPPED));
  assert.deepEqual(groupEntries(spliced, "app"), groupEntries(SHIPPED, "app"));
  assert.deepEqual(groupEntries(spliced, "core_cad"), groupEntries(SHIPPED, "core_cad"));
});

test("and keeps everything that is the user's", () => {
  const spliced = spliceRelease(THEIRS, SHIPPED);
  assert.deepEqual(groupEntries(spliced, "user"), ["cadquery", "mylib[extra]>=0.3"]);
  assert.ok(spliced.includes("# their own note at the top"));
  assert.ok(spliced.includes("# the comment above their own group"));
  assert.ok(spliced.includes("[[tool.uv.index]]"), "their own package index survives a release");
  assert.ok(spliced.includes("https://packages.example.com/simple"));
});

test("a source Settings wrote survives a release", () => {
  const withSource = `${THEIRS}\n[tool.uv.sources]\nbuild123d = { path = "/Users/me/src/build123d", editable = true }\n`;
  const spliced = spliceRelease(withSource, SHIPPED);
  assert.ok(spliced.includes('build123d = { path = "/Users/me/src/build123d", editable = true }'));
});

test("a group somebody deleted comes back rather than staying gone", () => {
  const gutted = THEIRS.replace(/app = \[[\s\S]*?\]\n/, "");
  assert.equal(groupEntries(gutted, "app"), null);
  const spliced = spliceRelease(gutted, SHIPPED);
  assert.deepEqual(groupEntries(spliced, "app"), groupEntries(SHIPPED, "app"));
  assert.deepEqual(groupEntries(spliced, "user"), ["cadquery", "mylib[extra]>=0.3"]);
});

test("splicing a file that is already current changes nothing at all", () => {
  assert.equal(spliceRelease(SHIPPED, SHIPPED), SHIPPED);
});

// --- [tool.uv.sources] -----------------------------------------------------

test("sources are read as the package and the line it was given", () => {
  const text = `${THEIRS}\n[tool.uv.sources]\nbuild123d = { path = "/src/b", editable = true }\n`;
  assert.deepEqual(sourceEntries(text), {
    build123d: '{ path = "/src/b", editable = true }',
  });
});

test("no sources table means no redirections, not an error", () => {
  assert.deepEqual(sourceEntries(THEIRS), {});
});

test("writing sources adds the table when it is absent", () => {
  const written = replaceSources(THEIRS, { build123d: '{ path = "/src/b", editable = true }' });
  assert.deepEqual(sourceEntries(written), { build123d: '{ path = "/src/b", editable = true }' });
  // and leaves what was already there
  assert.ok(written.includes("[[tool.uv.index]]"));
  assert.deepEqual(groupEntries(written, "user"), ["cadquery", "mylib[extra]>=0.3"]);
});

test("clearing every source removes the table rather than leaving it empty", () => {
  const with_ = replaceSources(THEIRS, { build123d: '{ path = "/src/b" }' });
  const without = replaceSources(with_, {});
  assert.ok(!without.includes("[tool.uv.sources]"));
  assert.deepEqual(sourceEntries(without), {});
});

test("a source written then spliced by a release is still there", () => {
  const with_ = replaceSources(THEIRS, { build123d: '{ path = "/src/b", editable = true }' });
  assert.deepEqual(sourceEntries(spliceRelease(with_, SHIPPED)), {
    build123d: '{ path = "/src/b", editable = true }',
  });
});

// --- what the dialog reads back --------------------------------------------
//
// selectionFromSources lives in packages.js, which imports Neutralino, so the
// rule is restated here against the same strings sourceEntries produces. What
// it decides is which radio is lit when Settings opens; getting it wrong means
// a dialog that says PyPI over an environment running a local checkout.

function selectionFrom(entries, names) {
  const selection = {};
  const localPaths = {};
  for (const name of names) {
    const written = entries[name];
    if (written === undefined) {
      selection[name] = "pypi";
      continue;
    }
    if (/\bgit\s*=/.test(written)) {
      selection[name] = "github";
      continue;
    }
    const path = /\bpath\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(written);
    if (path === null) {
      selection[name] = "pypi";
      continue;
    }
    selection[name] = "local";
    localPaths[name] = path[1].replace(/\\(.)/g, "$1");
  }
  return { selection, localPaths };
}

test("no source entry means the package comes from PyPI", () => {
  const { selection } = selectionFrom(sourceEntries(THEIRS), ["build123d"]);
  assert.equal(selection.build123d, "pypi");
});

test("a git source reads as the branch option", () => {
  const text = replaceSources(THEIRS, {
    build123d: '{ git = "https://github.com/gumyr/build123d", branch = "dev" }',
  });
  const { selection } = selectionFrom(sourceEntries(text), ["build123d"]);
  assert.equal(selection.build123d, "github");
});

test("a path source reads as a local checkout, with its folder", () => {
  const text = replaceSources(THEIRS, {
    build123d: '{ path = "/Users/me/src/build123d", editable = true }',
  });
  const { selection, localPaths } = selectionFrom(sourceEntries(text), ["build123d"]);
  assert.equal(selection.build123d, "local");
  assert.equal(localPaths.build123d, "/Users/me/src/build123d");
});

test("a Windows path comes back unescaped, as it was typed", () => {
  // tomlString doubles every backslash on the way in; reading it back has to
  // undo that or the folder shown is not the folder chosen.
  const text = replaceSources(THEIRS, {
    build123d: '{ path = "C:\\\\Users\\\\me\\\\src", editable = true }',
  });
  const { localPaths } = selectionFrom(sourceEntries(text), ["build123d"]);
  assert.equal(localPaths.build123d, "C:\\Users\\me\\src");
});

test("what `uv add` recorded survives a release", () => {
  // uv add writes into [project].dependencies rather than into a group, so a
  // release that replaced [project] wholesale threw away the one thing a
  // Python user's most obvious command had just put there.
  const added = THEIRS.replace("dependencies = []", 'dependencies = [\n    "cadquery",\n]');
  const spliced = spliceRelease(added, SHIPPED);

  assert.match(spliced, /dependencies = \[\n\s+"cadquery",\n\]/);
  // and the release still arrived
  assert.equal(projectVersion(spliced), projectVersion(SHIPPED));
  assert.deepEqual(groupEntries(spliced, "app"), groupEntries(SHIPPED, "app"));
});

test("an empty dependencies array on both sides is still idempotent", () => {
  assert.equal(spliceRelease(SHIPPED, SHIPPED), SHIPPED);
});
