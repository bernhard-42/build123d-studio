// node --test src/editor/safewrite.test.mjs
//
// These exist because the branches in writeFileSafely only run when something
// has already gone wrong - a full disk, a read-only directory, a rename that
// Windows will not do - and the thing at stake in every one of them is a file
// the user may have no other copy of. Reaching them through the application
// means arranging a filesystem failure by hand and then trusting a dialog.
//
// The fake below fails exactly where a real one might, and each test asserts
// what was left on disk afterwards, because that is what the user is left with.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { writeFileSafely } from "./safewrite.js";

/**
 * A filesystem that records what happened and fails where told to.
 *
 * `files` is the disk. `fail` names operations that should reject: "write:path"
 * for one particular write, "write" for all of them, and so on.
 */
function fakeFilesystem({ files = {}, fail = [], permissions = null, resolve = null } = {}) {
  const calls = [];
  const refuses = (operation, path) => fail.includes(operation) || fail.includes(`${operation}:${path}`);
  const guard = (operation, path) => {
    calls.push({ operation, path });
    if (refuses(operation, path)) {
      throw new Error(`refused: ${operation} ${path}`);
    }
  };

  return {
    calls,
    files,
    getJoinedPath: async (path) => {
      guard("resolve", path);
      return resolve === null ? path : resolve;
    },
    getPermissions: async (path) => {
      guard("getPermissions", path);
      if (permissions === null) {
        throw new Error("no such file");
      }
      return permissions;
    },
    setPermissions: async (path, value, mode) => {
      calls.push({ operation: "setPermissions", path, value, mode });
      if (refuses("setPermissions", path)) {
        throw new Error("refused");
      }
    },
    writeFile: async (path, data) => {
      guard("write", path);
      files[path] = data;
    },
    move: async (source, destination) => {
      guard("move", source);
      files[destination] = files[source];
      delete files[source];
    },
    remove: async (path) => {
      guard("remove", path);
      delete files[path];
    },
  };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const deps = (filesystem) => ({ filesystem, log: silent });

test("writes through a temporary and moves it into place", async () => {
  const filesystem = fakeFilesystem({ files: { "/w/part.py": "old" } });
  const written = await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(written, "/w/part.py");
  assert.equal(filesystem.files["/w/part.py"], "new");
  assert.deepEqual(Object.keys(filesystem.files), ["/w/part.py"], "no temporary left behind");
  // The order is the guarantee: the target is never opened for writing.
  assert.deepEqual(
    filesystem.calls.filter((c) => c.operation === "write" || c.operation === "move"),
    [{ operation: "write", path: "/w/part.py.b123d-tmp" },
      { operation: "move", path: "/w/part.py.b123d-tmp" }],
  );
});

test("follows a symlink instead of replacing it", async () => {
  // The link is /w/part.py; the real file is /repo/part.py. Writing the link
  // would turn it into an ordinary file and orphan the real one.
  const filesystem = fakeFilesystem({
    files: { "/repo/part.py": "old" },
    resolve: "/repo/part.py",
  });
  const written = await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(written, "/repo/part.py");
  assert.equal(filesystem.files["/repo/part.py"], "new");
  assert.equal(filesystem.files["/w/part.py"], undefined, "the link must be untouched");
  for (const call of filesystem.calls) {
    assert.notEqual(call.path, "/w/part.py.b123d-tmp",
      "the temporary belongs beside the real file, not beside the link");
  }
});

test("falls back to a direct write when the move is refused", async () => {
  // Windows: rename onto an existing file is not guaranteed.
  const filesystem = fakeFilesystem({ files: { "/w/part.py": "old" }, fail: ["move"] });
  await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(filesystem.files["/w/part.py"], "new");
  assert.deepEqual(Object.keys(filesystem.files), ["/w/part.py"],
    "the duplicate temporary is cleaned up");
});

test("falls back when the temporary itself cannot be written", async () => {
  // A writable file in a non-writable directory. This is the case the atomic
  // write broke and the fallback now covers.
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["write:/w/part.py.b123d-tmp"],
  });
  await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(filesystem.files["/w/part.py"], "new");
});

test("a partial temporary is cleaned up rather than left as a fake backup", async () => {
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["write:/w/part.py.b123d-tmp"],
  });
  await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.ok(filesystem.calls.some((c) => c.operation === "remove"),
    "the fragment must be removed");
  assert.equal(filesystem.files["/w/part.py.b123d-tmp"], undefined);
});

test("when both writes fail, the error names the temporary holding the work", async () => {
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["move", "write:/w/part.py"],
  });

  await assert.rejects(
    () => writeFileSafely(deps(filesystem), "/w/part.py", "new"),
    /Your content is in \/w\/part\.py\.b123d-tmp/,
  );
  assert.equal(filesystem.files["/w/part.py.b123d-tmp"], "new",
    "the only copy of the work must survive");
  assert.equal(filesystem.files["/w/part.py"], "old", "the original is untouched");
});

test("when nothing could be written at all, the original survives and nothing is left", async () => {
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["write"],
  });

  await assert.rejects(() => writeFileSafely(deps(filesystem), "/w/part.py", "new"));
  assert.equal(filesystem.files["/w/part.py"], "old");
  assert.equal(filesystem.files["/w/part.py.b123d-tmp"], undefined);
});

test("the target's permissions survive the replacement", async () => {
  const mode = { ownerRead: true, ownerWrite: true, ownerExec: true, othersRead: false };
  const filesystem = fakeFilesystem({ files: { "/w/part.py": "old" }, permissions: mode });
  await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  const restored = filesystem.calls.find((c) => c.operation === "setPermissions");
  assert.notEqual(restored, undefined, "an executable script must not become 0644");
  assert.deepEqual(restored.value, mode);
  assert.equal(restored.mode, "REPLACE");
});

test("a new file is left with whatever the platform gives it", async () => {
  const filesystem = fakeFilesystem({ files: {} });
  await writeFileSafely(deps(filesystem), "/w/new.py", "content");

  assert.equal(filesystem.files["/w/new.py"], "content");
  assert.equal(filesystem.calls.find((c) => c.operation === "setPermissions"), undefined);
});

test("a save still succeeds when the permissions cannot be put back", async () => {
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    permissions: { ownerRead: true },
    fail: ["setPermissions"],
  });

  await writeFileSafely(deps(filesystem), "/w/part.py", "new");
  assert.equal(filesystem.files["/w/part.py"], "new", "a lost mode must not fail the save");
});

test("an unresolvable path falls back to the one the user gave", async () => {
  const filesystem = fakeFilesystem({ files: { "/w/part.py": "old" }, fail: ["resolve"] });
  const written = await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(written, "/w/part.py");
  assert.equal(filesystem.files["/w/part.py"], "new");
});
