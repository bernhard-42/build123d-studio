// node --test tests/unit/envpath.test.mjs
//
// Where the Python environment goes. Two of the three answers only ever run on
// somebody else's machine - the Windows branch and the override a locked-down
// machine needs - which is exactly why the decision is a pure function.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ENV_ROOT_VARIABLE,
  chooseEnvRoot,
  envRootProblem,
  parentOf,
  strandedEnvRoot,
} from "../../src/bootstrap/envpath.js";

const MAC = {
  override: null,
  dataDir: "/Users/me/Library/Application Support/build123d-studio",
  localAppData: null,
  platform: "Darwin",
  appName: "build123d-studio",
};

const WINDOWS = {
  override: null,
  dataDir: "C:\\Users\\me\\AppData\\Roaming/build123d-studio",
  localAppData: "C:\\Users\\me\\AppData\\Local",
  platform: "Windows",
  appName: "build123d-studio",
};

// --- where it lands ---

test("macOS and Linux keep the environment under the app-data directory", () => {
  assert.deepEqual(chooseEnvRoot(MAC), {
    path: "/Users/me/Library/Application Support/build123d-studio/runtime",
    source: "data",
  });
  assert.deepEqual(
    chooseEnvRoot({ ...MAC, dataDir: "/home/me/.local/share/build123d-studio", platform: "Linux" }),
    { path: "/home/me/.local/share/build123d-studio/runtime", source: "data" },
  );
});

test("Windows uses the local half of AppData, not the roaming one", () => {
  // The whole point: a 38,000-file interpreter must not be copied at logon or
  // put on a redirected network share.
  const chosen = chooseEnvRoot(WINDOWS);
  assert.equal(chosen.path, "C:\\Users\\me\\AppData\\Local\\build123d-studio\\runtime");
  assert.equal(chosen.source, "local");
  assert.ok(!chosen.path.includes("Roaming"));
});

test("Windows without %LOCALAPPDATA% still starts, out of the roaming directory", () => {
  // Not a configuration anyone chooses, and refusing to start over a variable
  // standard since Vista would be worse than the location being second-best.
  for (const missing of [null, "", "   ", undefined]) {
    assert.deepEqual(chooseEnvRoot({ ...WINDOWS, localAppData: missing }), {
      path: "C:\\Users\\me\\AppData\\Roaming/build123d-studio/runtime",
      source: "data",
    });
  }
});

test("the override wins on every platform", () => {
  for (const base of [MAC, WINDOWS]) {
    assert.deepEqual(chooseEnvRoot({ ...base, override: "/opt/studio-env" }), {
      path: "/opt/studio-env",
      source: "override",
    });
  }
});

test("the override is taken as given, without a runtime directory added under it", () => {
  // Somebody naming a directory for this has already chosen where it goes; a
  // component appended silently is a path that does not match what they set.
  assert.equal(chooseEnvRoot({ ...WINDOWS, override: "D:\\studio" }).path, "D:\\studio");
});

test("a trailing separator on the override does not double up", () => {
  assert.equal(chooseEnvRoot({ ...MAC, override: "/opt/studio-env/" }).path, "/opt/studio-env");
  assert.equal(chooseEnvRoot({ ...WINDOWS, override: "D:\\studio\\" }).path, "D:\\studio");
});

test("surrounding whitespace in the override is not part of the path", () => {
  assert.equal(chooseEnvRoot({ ...MAC, override: "  /opt/studio-env  " }).path, "/opt/studio-env");
});

test("an override of nothing means the platform decides", () => {
  for (const nothing of ["", "   ", null, undefined]) {
    assert.equal(chooseEnvRoot({ ...MAC, override: nothing }).source, "data");
  }
});

test("a data directory with a trailing separator joins cleanly", () => {
  assert.equal(
    chooseEnvRoot({ ...MAC, dataDir: "/Users/me/Library/x/" }).path,
    "/Users/me/Library/x/runtime",
  );
});

// --- what the override may say ---

test("an absolute path is accepted, in every spelling a platform has", () => {
  for (const good of ["/opt/env", "C:\\env", "c:/env", "\\\\server\\share\\env"]) {
    assert.equal(envRootProblem(good), null, good);
  }
});

test("a relative path is refused, because this is not a shell", () => {
  // The bad case is not the one that fails, it is the one that resolves against
  // the environment directory and finds a different directory of the same name.
  for (const bad of ["env", "./env", "../env", "~/env"]) {
    const problem = envRootProblem(bad);
    assert.ok(problem !== null, bad);
    assert.match(problem, /full path/);
    assert.ok(problem.includes(ENV_ROOT_VARIABLE));
  }
});

test("an empty or non-string value is refused rather than treated as a path", () => {
  for (const bad of ["", "   ", null, undefined, 7]) {
    assert.ok(envRootProblem(bad) !== null);
  }
});

// --- walking upwards to create it ---

test("parentOf climbs one directory at a time", () => {
  assert.equal(parentOf("/opt/studio/env"), "/opt/studio");
  assert.equal(parentOf("/opt/studio"), "/opt");
  assert.equal(parentOf("C:\\Users\\me\\AppData\\Local\\x"), "C:\\Users\\me\\AppData\\Local");
});

test("parentOf stops at every kind of root, so creating cannot loop", () => {
  assert.equal(parentOf("/opt"), "/");
  assert.equal(parentOf("/"), null);
  assert.equal(parentOf("C:\\"), null);
  assert.equal(parentOf("C:"), null);
  assert.equal(parentOf("\\\\server\\share"), null);
  assert.equal(parentOf("env"), null);
});

test("parentOf ignores a trailing separator", () => {
  assert.equal(parentOf("/opt/studio/"), "/opt");
  assert.equal(parentOf("C:\\a\\b\\"), "C:\\a");
});

test("parentOf leaves a drive root usable rather than bare", () => {
  // "C:" alone is the current directory on that drive, not its root.
  assert.equal(parentOf("C:\\a"), "C:\\");
});

test("parentOf keeps a UNC share whole", () => {
  assert.equal(parentOf("\\\\server\\share\\env"), "\\\\server\\share");
});

// --- what an upgraded Windows install leaves behind ---

test("moving to the local directory names the roaming environment left behind", () => {
  assert.equal(
    strandedEnvRoot({ source: "local", dataDir: "C:\\Users\\me\\AppData\\Roaming\\build123d-studio" }),
    "C:\\Users\\me\\AppData\\Roaming\\build123d-studio\\runtime",
  );
});

test("nothing is stranded when the environment did not move", () => {
  assert.equal(strandedEnvRoot({ source: "data", dataDir: "/Users/me/x" }), null);
  assert.equal(strandedEnvRoot({ source: "override", dataDir: "/Users/me/x" }), null);
});
