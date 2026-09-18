import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isMakefile, makeTargets } from "../../../src/editor/makefile.js";

test("the names make looks for are Makefiles, and nothing else is", () => {
  assert.equal(isMakefile("/p/Makefile"), true);
  assert.equal(isMakefile("/p/makefile"), true);
  assert.equal(isMakefile("/p/GNUmakefile"), true);
  assert.equal(isMakefile("C:\\p\\Makefile"), true);
  assert.equal(isMakefile("/p/Makefile.bak"), false);
  assert.equal(isMakefile("/p/makefile.py"), false);
  assert.equal(isMakefile("/p/Makefiles"), false);
  assert.equal(isMakefile(null), false);
});

test("targets come out in file order, once each, without make's dot targets", () => {
  const text = [
    ".PHONY: build test",
    "CC := gcc",
    "VERSION ?= 1",
    "all: build",
    "build: src/a.c",
    "\tgcc -o a src/a.c",
    "test:",
    "\tpytest",
    "build: extra.c",
    "",
  ].join("\n");
  assert.deepEqual(makeTargets(text), ["all", "build", "test"]);
});

test("recipes, comments, assignments and pattern rules are not targets", () => {
  const text = [
    "# a comment: with a colon",
    "\techo not: a target",
    "FLAGS = -O2",
    "DIR ::= out",
    "%.o: %.c",
    "$(NAME): deps",
    "clean::",
    "  indented-with-spaces: still a rule",
  ].join("\n");
  assert.deepEqual(makeTargets(text), ["clean", "indented-with-spaces"]);
});

test("two targets on one line are two entries, and Windows line ends are fine", () => {
  assert.deepEqual(makeTargets("one two: x\r\nthree:\r\n"), ["one", "two", "three"]);
});

test("nothing to read is nothing", () => {
  assert.deepEqual(makeTargets(""), []);
  assert.deepEqual(makeTargets(undefined), []);
});

test("this project's own Makefile lists its targets and none of its variables", () => {
  const targets = makeTargets(readFileSync(new URL("../../../Makefile", import.meta.url), "utf8"));
  for (const expected of ["help", "tests", "build", "package", "bump", "release"]) {
    assert.ok(targets.includes(expected), `${expected} missing from ${targets}`);
  }
  assert.ok(!targets.includes("VERSION"));
  assert.ok(!targets.some((t) => t.startsWith(".")));
});
