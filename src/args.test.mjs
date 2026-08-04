// node --test src/args.test.mjs
//
// NL_ARGS carries Neutralino's own flags as well as ours, so the risk this
// guards against is picking up one of theirs. The value decides whether the
// window restores the previous session or resets to a project, so a wrong
// answer is not cosmetic.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { openTarget } from "./args.js";

// What Neutralino actually puts in front of our own flag.
const RUNTIME = [
  "/Applications/build123d Studio.app/Contents/MacOS/build123d-studio",
  "--load-dir-res",
  "--path=/Applications/build123d Studio.app/Contents/MacOS",
];

test("no argument means a double-click, which restores the session", () => {
  assert.equal(openTarget(RUNTIME), null);
});

test("the requested path is found among the runtime's own flags", () => {
  assert.equal(openTarget([...RUNTIME, "--open=/Users/b/CAD/bracket"]), "/Users/b/CAD/bracket");
});

test("--path is not mistaken for --open", () => {
  // The one that would actually happen: both end in a path, and --path is the
  // application's own directory. Opening it would show the user the bundle.
  assert.equal(openTarget(RUNTIME), null);
  assert.equal(
    openTarget([...RUNTIME, "--open=/Users/b/CAD"]),
    "/Users/b/CAD",
    "the runtime's --path must not win",
  );
});

test("a path with spaces survives", () => {
  assert.equal(
    openTarget([...RUNTIME, "--open=/Users/b/CAD projects/bracket.py"]),
    "/Users/b/CAD projects/bracket.py",
  );
});

test("a Windows path keeps its drive letter and backslashes", () => {
  const windows = "C:\\Users\\bernhard\\CAD\\bracket.py";
  assert.equal(openTarget([`--open=${windows}`]), windows);
});

test("an equals sign inside the path is not a second separator", () => {
  assert.equal(openTarget(["--open=/tmp/a=b/main.py"]), "/tmp/a=b/main.py");
});

test("an empty value is a script bug, not a request for the current directory", () => {
  // Opening whatever the working directory happens to be would be the worst
  // possible reading of it.
  assert.equal(openTarget([...RUNTIME, "--open="]), null);
});

test("the last one wins", () => {
  assert.equal(openTarget(["--open=/one", "--open=/two"]), "/two");
});

test("a missing or malformed argv is answered, not thrown on", () => {
  for (const nonsense of [undefined, null, "not an array", 7, {}]) {
    assert.equal(openTarget(nonsense), null);
  }
});
