// node --test tests/unit/editor/tree.test.mjs
//
// The sidebar's ordering, its filtering, and the path arithmetic underneath it.
// The last of those is the one that bites: a child path built with the wrong
// separator, or a containment test done with startsWith, produces a tree that
// looks right and opens the same file under two names.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { baseName, isHidden, isInside, joinPath, separatorOf, visibleEntries } from "../../../src/editor/tree.js";

const dir = (name) => ({ name, isDirectory: true });
const file = (name) => ({ name, isDirectory: false });
const names = (entries) => visibleEntries(entries).map((entry) => entry.name);

// --- order ---

test("directories come before files", () => {
  assert.deepEqual(names([file("a.py"), dir("z-parts"), file("b.py"), dir("a-jigs")]),
    ["a-jigs", "z-parts", "a.py", "b.py"]);
});

test("each group is alphabetical, ignoring case", () => {
  assert.deepEqual(names([file("Zeta.py"), file("alpha.py"), file("Beta.py")]),
    ["alpha.py", "Beta.py", "Zeta.py"]);
});

test("names differing only in case keep a stable order", () => {
  // Both exist on a case-sensitive filesystem. A comparison that called them
  // equal would let them swap places between one refresh and the next.
  const once = names([file("readme"), file("README")]);
  const again = names([file("README"), file("readme")]);
  assert.deepEqual(once, again);
});

test("an empty directory sorts to nothing rather than throwing", () => {
  assert.deepEqual(names([]), []);
});

// --- what is not shown ---

test("machine-written directories are hidden", () => {
  assert.deepEqual(names([dir("__pycache__"), dir(".git"), dir("parts")]), ["parts"]);
  assert.equal(isHidden("__pycache__"), true);
  assert.equal(isHidden(".git"), true);
  assert.equal(isHidden(".DS_Store"), true);
});

test("every other file is shown, including the ones that are not Python", () => {
  assert.deepEqual(
    names([file("bracket.step"), file("notes.md"), file("photo.png"), file("part.py")]),
    ["bracket.step", "notes.md", "part.py", "photo.png"],
  );
});

test("ordinary dotfiles stay, because people open them", () => {
  assert.deepEqual(names([file(".gitignore"), file(".python-version")]),
    [".gitignore", ".python-version"]);
});

test("a file that merely contains a hidden name is not hidden", () => {
  assert.deepEqual(names([file("git.py"), dir("my__pycache__helpers")]),
    ["my__pycache__helpers", "git.py"]);
});

// --- building child paths ---

test("children are joined with the separator the parent already uses", () => {
  assert.equal(joinPath("/home/b/cad", "part.py"), "/home/b/cad/part.py");
  assert.equal(joinPath("C:\\cad\\parts", "part.py"), "C:\\cad\\parts\\part.py");
});

test("a trailing separator does not produce a doubled one", () => {
  assert.equal(joinPath("/home/b/cad/", "part.py"), "/home/b/cad/part.py");
  assert.equal(joinPath("C:\\cad\\", "part.py"), "C:\\cad\\part.py");
  assert.equal(joinPath("/", "part.py"), "/part.py");
});

test("a Windows path with a forward slash in it still uses backslashes", () => {
  // Mixed spellings reach us from settings files carried between machines.
  assert.equal(separatorOf("C:\\cad\\parts"), "\\");
  assert.equal(separatorOf("/home/b/cad"), "/");
  assert.equal(separatorOf("C:/cad/parts"), "/");
});

// --- naming the root ---

test("the root row is named after its last segment", () => {
  assert.equal(baseName("/home/b/cad/suspension"), "suspension");
  assert.equal(baseName("/home/b/cad/suspension/"), "suspension");
  assert.equal(baseName("C:\\cad\\suspension"), "suspension");
  assert.equal(baseName("suspension"), "suspension");
});

// --- what belongs to the open folder ---

test("a file inside the folder is inside it, however deep", () => {
  assert.equal(isInside("/proj", "/proj/a.py"), true);
  assert.equal(isInside("/proj", "/proj/parts/jigs/a.py"), true);
  assert.equal(isInside("/proj/", "/proj/a.py"), true);
  assert.equal(isInside("C:\\proj", "C:\\proj\\a.py"), true);
});

test("a sibling whose name merely starts the same is not inside", () => {
  // /proj/parts against /proj/part - both real directory names, and startsWith
  // would file every tab of one under the other.
  assert.equal(isInside("/proj/part", "/proj/parts/a.py"), false);
  assert.equal(isInside("/proj", "/project/a.py"), false);
});

test("the folder itself is not inside itself, and nothing is inside nothing", () => {
  assert.equal(isInside("/proj", "/proj"), false);
  assert.equal(isInside(null, "/proj/a.py"), false);
  assert.equal(isInside("/proj", null), false);
});
