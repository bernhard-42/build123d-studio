import assert from "node:assert/strict";
import { test } from "node:test";

import { createProber } from "../../src/toolprobe.js";

const quiet = { info: () => {}, warn: () => {} };
const GIT = /git version/;

function answering(code, lines = []) {
  const calls = [];
  const run = async (command, { onLine }) => {
    calls.push(command);
    for (const line of lines) {
      onLine(line);
    }
    return code;
  };
  return { run, calls };
}

test("a banner is the tool, whatever the exit code says", async () => {
  // The broken-AutoRun case: cmd reports 1 for every spawn, success included.
  const { run } = answering(1, ["git version 2.45.0"]);
  const prober = createProber(run, quiet);
  assert.equal(await prober.probe("git", "git --version", GIT), "present");
});

test("exit 0 without a banner is still the tool", async () => {
  const { run } = answering(0, []);
  const prober = createProber(run, quiet);
  assert.equal(await prober.probe("git", "git --version", GIT), "present");
});

test("a non-zero exit with nothing recognisable is absence", async () => {
  const { run } = answering(127, ["sh: git: command not found"]);
  const prober = createProber(run, quiet);
  assert.equal(await prober.probe("git", "git --version", GIT), "absent");
  assert.equal(await prober.has("git", "git --version", GIT), false);
});

test("a probe that throws is unknown, not absent", async () => {
  const run = async () => { throw new Error("spawn refused"); };
  const prober = createProber(run, quiet);
  assert.equal(await prober.probe("git", "git --version", GIT), "unknown");
});

test("a probe that never answers is unknown after the wait, not for ever", async () => {
  const run = () => new Promise(() => {});
  const prober = createProber(run, quiet);
  assert.equal(await prober.probe("git", "git --version", GIT, 20), "unknown");
});

test("a yes is remembered and asked once; a no is asked again", async () => {
  let code = 127;
  const calls = [];
  const run = async (command) => { calls.push(command); return code; };
  const prober = createProber(run, quiet);

  assert.equal(await prober.probe("make", "make --version", /make/), "absent");
  assert.equal(await prober.probe("make", "make --version", /make/), "absent");
  assert.equal(calls.length, 2, "an absence was cached");

  code = 0;
  assert.equal(await prober.probe("make", "make --version", /make/), "present");
  assert.equal(await prober.probe("make", "make --version", /make/), "present");
  assert.equal(calls.length, 3, "a presence was probed again");
});

test("tools are remembered by name, not by each other", async () => {
  const { run } = answering(0);
  const prober = createProber(run, quiet);
  assert.equal(await prober.has("git", "git --version", GIT), true);
  const absent = createProber(answering(1).run, quiet);
  assert.equal(await absent.has("make", "make --version", /make/), false);
});
