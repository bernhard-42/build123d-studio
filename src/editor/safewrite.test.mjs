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
function fakeFilesystem({ files = {}, fail = [], truncateThenFail = [], permissions = null, resolve = null } = {}) {
  const calls = [];
  const noRoomOnce = new Set(truncateThenFail);
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
    readFile: async (path) => {
      guard("read", path);
      if (!(path in files)) {
        throw new Error("no such file");
      }
      return files[path];
    },
    writeFile: async (path, data) => {
      calls.push({ operation: "write", path });
      // Two different failures, and the difference is the whole of D4.
      //
      // A write refused because the file or its directory cannot be opened
      // fails before anything is touched - that is `fail`, and it is what a
      // permission problem looks like. A write that gets as far as opening the
      // target has already emptied it, and only then discovers there is no
      // room for the new content - that is `truncateThenFail`, and it is what
      // a full disk looks like. The fake only ever modelled the first, which
      // is why the destructive branch could sit here unnoticed behind tests
      // asserting the original survived.
      if (noRoomOnce.has(path)) {
        // Once, because emptying the file is what frees the room: the disk had
        // no space for a second copy beside the original, and has space for the
        // original again the moment the original is gone. That is what makes
        // putting it back possible, and it is the case that matters - a disk
        // that can never accept anything again cannot be recovered from here.
        noRoomOnce.delete(path);
        files[path] = "";
        throw new Error(`no space: write ${path}`);
      }
      if (refuses("write", path)) {
        throw new Error(`refused: write ${path}`);
      }
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
const deps = (filesystem) => ({ filesystem, log: silent, instanceId: "abcd1234" });

test("writes through a temporary and moves it into place", async () => {
  const filesystem = fakeFilesystem({ files: { "/w/part.py": "old" } });
  const written = await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(written, "/w/part.py");
  assert.equal(filesystem.files["/w/part.py"], "new");
  assert.deepEqual(Object.keys(filesystem.files), ["/w/part.py"], "no temporary left behind");
  // The order is the guarantee: the target is never opened for writing.
  assert.deepEqual(
    filesystem.calls.filter((c) => c.operation === "write" || c.operation === "move"),
    [{ operation: "write", path: "/w/part.py.abcd1234.b123d-tmp" },
      { operation: "move", path: "/w/part.py.abcd1234.b123d-tmp" }],
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
    assert.notEqual(call.path, "/w/part.py.abcd1234.b123d-tmp",
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
    fail: ["write:/w/part.py.abcd1234.b123d-tmp"],
  });
  await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(filesystem.files["/w/part.py"], "new");
});

test("a partial temporary is cleaned up rather than left as a fake backup", async () => {
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["write:/w/part.py.abcd1234.b123d-tmp"],
  });
  await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.ok(filesystem.calls.some((c) => c.operation === "remove"),
    "the fragment must be removed");
  assert.equal(filesystem.files["/w/part.py.abcd1234.b123d-tmp"], undefined);
});

test("when both writes fail, the error names the temporary holding the work", async () => {
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["move", "write:/w/part.py"],
  });

  await assert.rejects(
    () => writeFileSafely(deps(filesystem), "/w/part.py", "new"),
    /Your content is in \/w\/part\.py\.abcd1234\.b123d-tmp/,
  );
  assert.equal(filesystem.files["/w/part.py.abcd1234.b123d-tmp"], "new",
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
  assert.equal(filesystem.files["/w/part.py.abcd1234.b123d-tmp"], undefined);
});

test("two instances do not share a scratch name", async () => {
  // Both windows have part.py open and both save. With one shared temporary
  // the second overwrites the first's and then moves it into place, so a save
  // that reported success wrote the other window's content.
  const filesystem = fakeFilesystem({ files: { "/w/part.py": "old" }, fail: ["move"] });
  const other = { filesystem, log: silent, instanceId: "99887766" };

  await writeFileSafely(other, "/w/part.py", "theirs");

  const written = filesystem.calls.filter((c) => c.operation === "write").map((c) => c.path);
  assert.ok(written.includes("/w/part.py.99887766.b123d-tmp"),
    `the scratch name must name the instance: ${written.join(", ")}`);
  assert.ok(!written.includes("/w/part.py.abcd1234.b123d-tmp"));
});

test("a new file that cannot be written leaves nothing behind", async () => {
  // Save As onto a full disk. There is no original to put back, and an empty
  // file where the user asked for one is worse than no file: it looks saved.
  const filesystem = fakeFilesystem({ files: {}, fail: ["write"] });

  await assert.rejects(() => writeFileSafely(deps(filesystem), "/w/new.py", "new"));
  assert.equal(filesystem.files["/w/new.py"], undefined,
    "an empty file was left where the save failed");
});

test("a write that empties the file and then fails puts it back", async () => {
  // The full disk. The temporary needs room for a second copy and is refused;
  // the direct write gets as far as opening the target - which empties it -
  // and then finds there is no room either. Before this, that left the user
  // with an empty file and their only remaining copy in the editor.
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["write:/w/part.py.abcd1234.b123d-tmp"],
    truncateThenFail: ["/w/part.py"],
  });

  await assert.rejects(() => writeFileSafely(deps(filesystem), "/w/part.py", "new"));
  assert.equal(filesystem.files["/w/part.py"], "old",
    "a failed save must leave the file as it was, not empty it");
});

test("and when the move failed too, the work is still named", async () => {
  // Same, but the temporary was written before the disk filled: the original
  // goes back and the new content is in the temporary the message names.
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["move"],
    truncateThenFail: ["/w/part.py"],
  });

  await assert.rejects(
    () => writeFileSafely(deps(filesystem), "/w/part.py", "new"),
    /Your content is in \/w\/part\.py\.abcd1234\.b123d-tmp/,
  );
  assert.equal(filesystem.files["/w/part.py"], "old", "the original is put back");
  assert.equal(filesystem.files["/w/part.py.abcd1234.b123d-tmp"], "new",
    "the only copy of the work must survive");
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
