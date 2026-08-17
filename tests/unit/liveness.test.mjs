// node --test tests/unit/liveness.test.mjs
//
// Whether another window of this application is running, which is the whole of
// what the recovery journal needs and the whole of what a heartbeat could not
// tell it. Every sample below is real output, captured from the machines named:
// macOS 15 and Ubuntu on x86_64. The Windows rows are the documented shape of
// `tasklist /NH /FO CSV` and are the one part waiting on a real machine - see
// tests/manual.md, M28.
//
// The property that matters here is the one that would have broken Linux
// silently: `ps -o comm=` truncates to fifteen characters there, and
// "build123d-studio" is sixteen. Nothing compares against a literal name.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  liveWindows,
  parseProcessList,
  processListCommand,
  siblingPids,
} from "../../src/liveness.js";

// Captured from this machine. Names carry spaces, parentheses and full paths.
const MACOS = `    1 /sbin/launchd
  200 /Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Versions/150.1.92.140/Helpers/Brave Browser Helper (Renderer).app/Contents/MacOS/Brave Browser Helper (Renderer)
62079 /Applications/build123d Studio.app/Contents/MacOS/build123d-studio
62480 /Applications/build123d Studio.app/Contents/MacOS/build123d-studio
`;

// Captured from banach, an Ubuntu x86_64 box. Note the name: comm is capped at
// fifteen characters there, so the sixteenth is simply gone.
const LINUX = `      1 systemd
      2 kthreadd
  31337 build123d-studi
  31402 build123d-studi
`;

const WINDOWS = `"System Idle Process","0","Services","0","8 K"
"build123d-studio.exe","1234","Console","1","50,000 K"
"build123d-studio.exe","5678","Console","1","48,120 K"
`;

test("a macOS listing reads back with its paths and spaces intact", () => {
  const processes = parseProcessList("Darwin", MACOS);
  assert.equal(processes.get(1), "/sbin/launchd");
  assert.equal(
    processes.get(62079),
    "/Applications/build123d Studio.app/Contents/MacOS/build123d-studio",
  );
  assert.ok(processes.get(200).endsWith("Brave Browser Helper (Renderer)"));
});

test("a Linux listing reads back with the name the kernel actually kept", () => {
  const processes = parseProcessList("Linux", LINUX);
  // Fifteen characters, because that is all comm holds. A constant compared
  // against "build123d-studio" would never match here, on any Linux.
  assert.equal(processes.get(31337), "build123d-studi");
  assert.equal(processes.get(31337).length, 15);
  assert.equal(processes.get(1), "systemd");
});

test("a Windows listing reads back from the quoted columns", () => {
  const processes = parseProcessList("Windows", WINDOWS);
  assert.equal(processes.get(1234), "build123d-studio.exe");
  assert.equal(processes.get(0), "System Idle Process");
});

test("rows that are not processes are skipped rather than failing the answer", () => {
  // tasklist prints a localised sentence when a filter matches nothing, and a
  // caller may hand us a stray line from stderr. One unreadable row must not
  // cost the whole listing.
  const processes = parseProcessList(
    "Windows",
    `INFO: No tasks are running which match the specified criteria.\n${WINDOWS}`,
  );
  assert.equal(processes.size, 3);
  assert.equal(parseProcessList("Darwin", "ps: something went wrong\n").size, 0);
});

test("our siblings are the processes sharing the name the platform gave us", () => {
  // Never a literal. Whatever this platform calls us - a path, a truncation, an
  // .exe - every row was written the same way, so equality is exact.
  assert.deepEqual([...siblingPids(parseProcessList("Darwin", MACOS), 62079)], [62079, 62480]);
  assert.deepEqual([...siblingPids(parseProcessList("Linux", LINUX), 31337)], [31337, 31402]);
  assert.deepEqual([...siblingPids(parseProcessList("Windows", WINDOWS), 1234)], [1234, 5678]);
});

test("a recycled pid belonging to something else is not one of us", () => {
  // The reason the name is matched at all rather than the number alone: a dead
  // session's pid can be handed to any program on the machine, and its journal
  // would then look alive for ever.
  const live = siblingPids(parseProcessList("Darwin", MACOS), 62079);
  assert.equal(live.has(1), false, "launchd was counted as a window of this application");
  assert.equal(live.has(200), false);
});

test("not finding ourselves is null, which is not an empty set", () => {
  // "nobody else is running" and "I could not find out" lead to opposite
  // decisions about somebody's unsaved work, so they cannot share a value.
  assert.equal(siblingPids(parseProcessList("Darwin", MACOS), 99999), null);
  assert.equal(siblingPids(new Map(), 1), null);
});

test("each platform is asked in the way that platform answers", () => {
  assert.equal(processListCommand("Windows"), "tasklist /NH /FO CSV");
  assert.equal(processListCommand("Darwin"), "ps -A -o pid=,comm=");
  assert.equal(processListCommand("Linux"), "ps -A -o pid=,comm=");
});

const quiet = { warn() {}, info() {}, error() {} };

test("a command that cannot be run answers null rather than nobody", () => {
  const os = { execCommand: () => Promise.reject(new Error("no such command")) };
  return liveWindows({ os, log: quiet, platform: "Darwin" }, 1)
    .then((live) => assert.equal(live, null));
});

test("a command that fails answers null too", async () => {
  const os = {
    execCommand: () => Promise.resolve({ stdOut: "", stdErr: "boom", exitCode: 1 }),
  };
  assert.equal(await liveWindows({ os, log: quiet, platform: "Darwin" }, 1), null);
});

test("and a good answer is the set of windows", async () => {
  const os = {
    execCommand: () => Promise.resolve({ stdOut: MACOS, stdErr: "", exitCode: 0 }),
  };
  const live = await liveWindows({ os, log: quiet, platform: "Darwin" }, 62079);
  assert.deepEqual([...live], [62079, 62480]);
});
