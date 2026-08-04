// node --test src/requirements.test.mjs
//
// This is the field where free user text reaches a generated file, so the tests
// that matter most are the ones about the file's structure rather than about
// parsing convenience. A line that can close the dependencies array and open a
// [tool.uv.sources] table of its own could redirect a frozen package, which is
// the one outcome nothing else would catch.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  findProblems,
  insertDependencies,
  normalizeName,
  parseRequirements,
  renderRequirements,
  tomlString,
} from "./requirements.js";

const DECLARED = ["ocp_vscode", "ipykernel", "build123d", "basedpyright"];

test("a PyPI requirement, with or without a range", () => {
  const [plain, ranged] = parseRequirements("ocp-widgets\nocp-widgets-extra>=0.3,<1.0");
  assert.equal(plain.name, "ocp-widgets");
  assert.equal(plain.requirement, "ocp-widgets");
  assert.equal(plain.source, null);
  assert.equal(ranged.name, "ocp-widgets-extra");
  assert.equal(ranged.requirement, "ocp-widgets-extra>=0.3,<1.0");
  assert.equal(ranged.source, null);
});

test("a local path becomes a named dependency plus a path source", () => {
  const [entry] = parseRequirements("/Users/bernhard/Development/CAD/mylib");
  assert.equal(entry.name, "mylib");
  assert.equal(entry.requirement, "mylib");
  assert.deepEqual(entry.source, { path: "/Users/bernhard/Development/CAD/mylib" });
});

test("a Windows path is recognised as a path, not a requirement", () => {
  const [entry] = parseRequirements("C:\\Users\\bernhard\\src\\mylib");
  assert.equal(entry.name, "mylib");
  assert.deepEqual(entry.source, { path: "C:\\Users\\bernhard\\src\\mylib" });
});

test("a git URL becomes a named dependency plus a git source", () => {
  const [entry] = parseRequirements("git+https://github.com/someone/mylib");
  assert.equal(entry.name, "mylib");
  assert.deepEqual(entry.source, { git: "git+https://github.com/someone/mylib" });
});

test("a git URL with a ref splits the ref out", () => {
  const [entry] = parseRequirements("git+https://github.com/someone/mylib@main");
  assert.equal(entry.name, "mylib");
  assert.deepEqual(entry.source, { git: "git+https://github.com/someone/mylib", rev: "main" });
});

test("a .git suffix is not part of the package name", () => {
  const [entry] = parseRequirements("https://github.com/someone/mylib.git");
  assert.equal(entry.name, "mylib");
});

test("an explicit name wins over the guess, and needs no source entry", () => {
  // The escape hatch for a repository whose distribution is named differently.
  const [entry] = parseRequirements("mylib @ git+https://github.com/someone/python-lib");
  assert.equal(entry.name, "mylib");
  assert.equal(entry.requirement, "mylib @ git+https://github.com/someone/python-lib");
  assert.equal(entry.source, null, "a PEP 508 direct reference is understood as written");
});

test("blank lines and comments are dropped, and line numbers still count them", () => {
  const entries = parseRequirements("\n# a note\n\nmylib\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].line, 4, "so an error message points at the right line");
});

test("a line with no usable name is reported rather than thrown on", () => {
  const [entry] = parseRequirements("!!!");
  assert.equal(entry.name, null);
  assert.notEqual(entry.error, null);
});

// --- the collision rules ---------------------------------------------------

test("a package the application declares is refused", () => {
  const problems = findProblems(parseRequirements("build123d>=0.12"), DECLARED);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /build123d is already part of the application/);
});

test("collision is by normalised name, so separators do not evade it", () => {
  // uv treats these as one package, so the rule has to as well.
  for (const spelling of ["ocp_vscode", "ocp-vscode", "OCP.VSCode", "OCP_VSCODE"]) {
    const problems = findProblems(parseRequirements(`${spelling}==5.0`), DECLARED);
    assert.equal(problems.length, 1, `${spelling} must be recognised as ocp_vscode`);
  }
});

test("a local path colliding with a declared package is refused too", () => {
  // The form that looks least like a collision and is one.
  const problems = findProblems(parseRequirements("/Users/me/src/build123d"), DECLARED);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /already part of the application/);
});

test("the same package given twice is refused, naming the earlier line", () => {
  // my_lib and my-lib are one package under PEP 503; mylib is a different one,
  // because normalisation collapses separators but does not remove them.
  const problems = findProblems(parseRequirements("my_lib==1.0\nmylib\nmy-lib==2.0"), DECLARED);
  assert.equal(problems.length, 1, "only the third line is a duplicate");
  assert.match(problems[0], /Line 3/);
  assert.match(problems[0], /line 1/);
});

test("a package that is only a transitive dependency is allowed", () => {
  // ocp_tessellate is no longer declared - ocp_vscode owns its range - so
  // constraining it here is the user's business, and uv enforces the parent's
  // range on top of whatever they write.
  assert.deepEqual(findProblems(parseRequirements("ocp-tessellate>3.4.0,<3.5"), DECLARED), []);
});

test("nothing wrong means nothing reported", () => {
  assert.deepEqual(findProblems(parseRequirements("a\nb>=1\n/tmp/c"), DECLARED), []);
});

// --- the file's structure --------------------------------------------------

test("a quote cannot escape the string it is written into", () => {
  // The attack this whole module exists to prevent: close the string, close the
  // array, open a table, redirect a frozen package.
  const hostile = 'x", ]\n[tool.uv.sources]\nocp_vscode = { git = "https://evil.example/x" }\n#';
  const rendered = tomlString(hostile);

  // TOML basic strings and JSON strings escape these the same way, so a
  // successful round-trip is the property worth asserting: had any quote ended
  // the string early, what came back would not be what went in.
  assert.equal(JSON.parse(rendered), hostile);
  assert.equal(rendered.includes("\n"), false, "no bare newline survives");
});

test("a backslash is escaped, so a Windows path cannot end the string", () => {
  // "C:\src\mylib\" would otherwise escape the closing quote.
  const rendered = tomlString("C:\\src\\mylib\\");
  assert.equal(rendered, '"C:\\\\src\\\\mylib\\\\"');
});

test("rendering produces dependency lines and source entries", () => {
  const entries = parseRequirements(
    ["ocp-widgets>=0.3", "/Users/me/src/mylib", "git+https://github.com/someone/other@main"].join("\n"),
  );
  const { dependencies, sources } = renderRequirements(entries);
  assert.deepEqual(dependencies, [
    '    "ocp-widgets>=0.3",',
    '    "mylib",',
    '    "other",',
  ]);
  assert.deepEqual(sources, [
    'mylib = { path = "/Users/me/src/mylib" }',
    'other = { git = "git+https://github.com/someone/other", rev = "main" }',
  ]);
});

test("an unusable line contributes nothing to the file", () => {
  const { dependencies, sources } = renderRequirements(parseRequirements("!!!\nmylib"));
  assert.deepEqual(dependencies, ['    "mylib",']);
  assert.deepEqual(sources, []);
});

// --- where the lines go --------------------------------------------------

// The shipped file, shortened but with the shape that matters: a `[tool.uv]`
// table *after* the dependencies array, so the array's `]` is not the last one.
const PYPROJECT = `[project]
name = "build123d-studio-runtime"
requires-python = "==3.14.*"

dependencies = [
    # --- frozen: moves only when the application is rebuilt and retested ---
    "ocp_vscode==4.0.1",
    "pywinpty==3.0.5; sys_platform == 'win32'",

    # --- floating: moved by "Upgrade packages", within this range ---
    "build123d>=0.11.1",
]

# This project exists only to pin an environment - there is no package to build.
[tool.uv]
package = false
`;

test("lines land inside the dependencies array, not in [tool.uv]", () => {
  // The bug this replaces: inserting at the file's last "]" put the packages
  // inside `[tool.uv`, and uv refused to parse the file at all.
  const out = insertDependencies(PYPROJECT, ['    "mylib",']);
  assert.match(out, /"build123d>=0\.11\.1",\n {4}"mylib",\n\]/);
  assert.match(out, /\n\[tool\.uv\]\npackage = false\n$/, "[tool.uv] must be intact");
});

test("a bracket inside a string does not end the array early", () => {
  const tricky = 'dependencies = [\n    "a; extra == \'x]\'",\n]\n\n[tool.uv]\n';
  const out = insertDependencies(tricky, ['    "mylib",']);
  assert.match(out, /"a; extra == 'x\]'",\n {4}"mylib",\n\]/);
});

test("a bracket inside a comment does not end the array early", () => {
  const tricky = 'dependencies = [\n    # a ] in a comment\n    "a",\n]\n\n[tool.uv]\n';
  const out = insertDependencies(tricky, ['    "mylib",']);
  assert.match(out, /"a",\n {4}"mylib",\n\]/);
});

test("nothing to insert leaves the file untouched", () => {
  assert.equal(insertDependencies(PYPROJECT, []), PYPROJECT);
});

test("a file with no dependencies array is refused rather than mangled", () => {
  // The caller has to treat null as "do not write", because writing a file we
  // could not understand is how the array ended up inside [tool.uv].
  assert.equal(insertDependencies("[project]\nname = \"x\"\n", ['    "mylib",']), null);
  assert.equal(insertDependencies("dependencies = [\n    \"a\",\n", ['    "x",']), null);
});

test("normalizeName follows PEP 503", () => {
  assert.equal(normalizeName("OCP_Tessellate"), "ocp-tessellate");
  assert.equal(normalizeName("a.._-.b"), "a-b");
});
