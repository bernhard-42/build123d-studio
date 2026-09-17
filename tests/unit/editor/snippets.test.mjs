// node --test tests/unit/editor/snippets.test.mjs
//
// User snippets, and the one piece of arithmetic that makes them work.
//
// The prefixes these files use start with punctuation - `?bdp`, `>ext` - so
// they cannot collide with an identifier basedpyright would also suggest. That
// is exactly what Monaco's own filtering cannot cope with: its word separators
// include `?` and `>`, so the word under a caret typing `?bd` is `bd`. Every
// case below about ranges is about that gap: the range is what says both what
// an accepted item replaces and what the list is filtered against.
//
// The sample is the real thing: build123d-portable's build123d-OCP snippet set,
// which is a JSONC file and is read as one - copied in unedited, comments and
// all, because that is what a `.code-snippets` file is.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  loadSnippets,
  parseSnippets,
  prefixBeing,
  snippetCompletions,
  snippetsPath,
} from "../../../src/editor/snippets.js";

const KINDS = { Snippet: 27 };
const RULES = { InsertAsSnippet: 4 };

const SET = JSON.stringify({
  BuildPart: { scope: "python", prefix: "?bdp", body: ["with BuildPart() as p$1:", "    $0"] },
  BuildSketch: { scope: "python", prefix: "?bds", body: ["with BuildSketch($1) as s$2:", "    $0"] },
  Extrude: { scope: "python", prefix: ">ext", body: ["extrude(amount=$1)"] },
});

test("a document reads back as its snippets", () => {
  const { snippets, problems } = parseSnippets(SET);

  assert.equal(problems.length, 0);
  assert.deepEqual(snippets.map((s) => s.prefix), ["?bdp", "?bds", ">ext"]);
  // The body's lines are joined, because that is what Monaco inserts.
  assert.equal(snippets[0].body, "with BuildPart() as p$1:\n    $0");
});

test("a body given as one string is taken as it is", () => {
  const { snippets } = parseSnippets(JSON.stringify({ One: { prefix: "?x", body: "a$1" } }));
  assert.equal(snippets[0].body, "a$1");
});

test("a .code-snippets file is read as VS Code reads it", () => {
  // Comments, trailing commas, comments *after* an array element - all of which
  // the sets in circulation are full of, and all of which JSON.parse refuses.
  // The point of the dependency is that such a file can be copied in unedited.
  const { snippets, problems } = parseSnippets(`{
  // build123d speedmodelling snippets
  "BuildPart": {
    "scope": "python",
    "prefix": "?bdp", // the shortcut
    "body": [
      "with BuildPart() as p$1:",
      "    $0",
    ],
  },
}`);

  assert.deepEqual(problems, []);
  assert.deepEqual(snippets.map((s) => s.prefix), ["?bdp"]);
  assert.equal(snippets[0].body, "with BuildPart() as p$1:\n    $0");
});

test("and a file that is genuinely broken says where", () => {
  const { snippets, problems } = parseSnippets('{ "A": ');

  assert.equal(snippets.length, 0);
  assert.match(problems[0], /at character \d+/);
});

test("one unusable entry does not cost the others", () => {
  const { snippets, problems } = parseSnippets(JSON.stringify({
    Good: { prefix: "?g", body: ["ok"] },
    NoPrefix: { body: ["ok"] },
    NoBody: { prefix: "?n" },
    NotAnObject: "nonsense",
  }));

  assert.deepEqual(snippets.map((s) => s.prefix), ["?g"]);
  assert.equal(problems.length, 3, problems.join(" | "));
});

test("a file that is not a set of snippets says so rather than throwing", () => {
  assert.equal(parseSnippets("[]").snippets.length, 0);
  assert.match(parseSnippets("[]").problems[0], /not an object/);
  assert.match(parseSnippets("null").problems[0], /not an object/);
});

// --- what is being typed ---------------------------------------------------

test("the prefix being typed includes its mark, which Monaco's word does not", () => {
  // The whole reason this function exists.
  assert.deepEqual(prefixBeing("?bd", 4), { typed: "?bd", startColumn: 1 });
  assert.deepEqual(prefixBeing("    ?bd", 8), { typed: "?bd", startColumn: 5 });
  assert.deepEqual(prefixBeing(">ex", 4), { typed: ">ex", startColumn: 1 });
});

test("a mark on its own is a prefix with nothing typed after it yet", () => {
  assert.deepEqual(prefixBeing("?", 2), { typed: "?", startColumn: 1 });
});

test("an ordinary word is not a prefix", () => {
  // Otherwise every identifier in the file would offer snippets.
  assert.equal(prefixBeing("extrude", 8), null);
  assert.equal(prefixBeing("", 1), null);
});

test("a mark inside a name or after a value is not one either", () => {
  // `foo?bd` is not somebody typing `?bd`, and offering there would put a
  // snippet in the middle of a name. `a >b` is a comparison.
  assert.equal(prefixBeing("foo?bd", 7), null);
  assert.equal(prefixBeing("a>b", 4), null);
  assert.equal(prefixBeing("f()>x", 6), null);
  assert.equal(prefixBeing('"s">x', 6), null);
});

// --- what is offered -------------------------------------------------------

const { snippets } = parseSnippets(SET);
const at = (column) => ({ lineNumber: 3, column });

test("typing a mark offers every snippet with it", () => {
  const items = snippetCompletions(snippets, "?", at(2), KINDS, RULES);
  assert.deepEqual(items.map((i) => i.label), ["?bdp", "?bds"]);
});

test("and the list narrows as more is typed", () => {
  assert.deepEqual(
    snippetCompletions(snippets, "?bdp", at(5), KINDS, RULES).map((i) => i.label),
    ["?bdp"],
  );
  assert.deepEqual(
    snippetCompletions(snippets, ">", at(2), KINDS, RULES).map((i) => i.label),
    [">ext"],
  );
});

test("the item replaces the mark as well as the letters", () => {
  // Without this the snippet is inserted beside the `?`, leaving
  // `?with BuildPart() as p:` in the file.
  const [item] = snippetCompletions(snippets, "    ?bdp", at(9), KINDS, RULES);

  // The range is what does both jobs: it decides what the insertion replaces,
  // and it is the text Monaco filters the list against.
  assert.equal(item.range.startColumn, 5, "the range does not reach back to the mark");
  assert.equal(item.range.endColumn, 9);
  assert.equal(item.range.startLineNumber, 3);
});

test("what is inserted is the body, as a snippet rather than as text", () => {
  const [item] = snippetCompletions(snippets, "?bdp", at(5), KINDS, RULES);
  assert.equal(item.insertText, "with BuildPart() as p$1:\n    $0");
  assert.equal(item.insertTextRules, RULES.InsertAsSnippet);
  assert.equal(item.kind, KINDS.Snippet);
});

test("nothing is offered where no prefix is being typed", () => {
  assert.deepEqual(snippetCompletions(snippets, "extrude", at(8), KINDS, RULES), []);
});

test("the file sits beside the settings", () => {
  assert.equal(snippetsPath("/appdata/build123d-studio"), "/appdata/build123d-studio/snippets.json");
});

// --- the file is the truth ----------------------------------------------------
//
// Proof, at writing: with the writeFile call removed from loadSnippets, "a
// machine with no file gets the shipped set written" fails on `written` and
// "where the file cannot be written" on the missing warning; with a merge over
// the shipped set put back, "a snippet removed from the file is gone" fails on
// the count.

/** A filesystem holding one directory's files, which can be told to refuse writes. */
function fakeFilesystem(files, { readOnly = false } = {}) {
  const written = [];
  return {
    written,
    async readFile(path) {
      if (!Object.hasOwn(files, path)) {
        throw new Error(`NE_FS_FILRDER: ${path}`);
      }
      return files[path];
    },
    async writeFile(path, text) {
      if (readOnly) {
        throw new Error(`NE_FS_FILWRER: ${path}`);
      }
      files[path] = text;
      written.push(path);
    },
  };
}

const quiet = { info() {}, warn() {} };
const DIR = "/appdata/build123d-studio";

test("a machine with no file gets the shipped set written, and reads it", async () => {
  const files = {};
  const filesystem = fakeFilesystem(files);

  const snippets = await loadSnippets({ filesystem, log: quiet }, DIR, SET);

  assert.deepEqual(filesystem.written, [`${DIR}/snippets.json`]);
  assert.equal(files[`${DIR}/snippets.json`], SET);
  assert.deepEqual(snippets.map((s) => s.prefix), ["?bdp", "?bds", ">ext"]);
});

test("an existing file is read and never written over", async () => {
  const mine = JSON.stringify({ Mine: { prefix: "?bdp", body: ["MINE"] } });
  const files = { [`${DIR}/snippets.json`]: mine };
  const filesystem = fakeFilesystem(files);

  const snippets = await loadSnippets({ filesystem, log: quiet }, DIR, SET);

  assert.deepEqual(filesystem.written, []);
  assert.equal(files[`${DIR}/snippets.json`], mine);
  assert.equal(snippets.find((s) => s.prefix === "?bdp").body, "MINE");
});

test("a snippet removed from the file is gone - nothing is merged underneath", async () => {
  const files = { [`${DIR}/snippets.json`]: JSON.stringify({ Only: { prefix: "?zz", body: ["Z"] } }) };

  const snippets = await loadSnippets({ filesystem: fakeFilesystem(files), log: quiet }, DIR, SET);

  assert.deepEqual(snippets.map((s) => s.prefix), ["?zz"]);
});

test("where the file cannot be written, the shipped set still serves, and the log says so", async () => {
  const warnings = [];
  const log = { info() {}, warn: (...parts) => warnings.push(parts.join(" ")) };

  const snippets = await loadSnippets({ filesystem: fakeFilesystem({}, { readOnly: true }), log }, DIR, SET);

  assert.deepEqual(snippets.map((s) => s.prefix), ["?bdp", "?bds", ">ext"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not write .*snippets\.json/);
});
