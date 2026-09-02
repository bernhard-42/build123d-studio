// node --test tests/unit/editor/safewrite.test.mjs
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

import { writeFileSafely } from "../../../src/editor/safewrite.js";

/**
 * A filesystem that records what happened and fails where told to.
 *
 * `files` is the disk. `fail` names operations that should reject: "write:path"
 * for one particular write, "write" for all of them, and so on.
 */
function fakeFilesystem({ files = {}, fail = [], truncateThenFail = [], permissions = null, resolve = null } = {}) {
  const calls = [];
  // Identity, because that is the property at stake and a text-only disk cannot
  // be wrong about it. A write keeps the number; a move carries the source's
  // number to the destination, which is what a rename does and what replacing a
  // file through a temporary costs.
  let nextInode = 1;
  const inodes = {};
  for (const path of Object.keys(files)) {
    inodes[path] = nextInode;
    nextInode += 1;
  }
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
    inodes,
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
      if (!(path in files)) {
        inodes[path] = nextInode;
        nextInode += 1;
      }
      files[path] = data;
    },
    move: async (source, destination) => {
      guard("move", source);
      files[destination] = files[source];
      inodes[destination] = inodes[source];
      delete files[source];
      delete inodes[source];
    },
    remove: async (path) => {
      guard("remove", path);
      delete files[path];
      delete inodes[path];
    },
  };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const deps = (filesystem) => ({ filesystem, log: silent });

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

test("when nothing could be written at all, the original survives and nothing is left", async () => {
  const filesystem = fakeFilesystem({
    files: { "/w/part.py": "old" },
    fail: ["write"],
  });

  await assert.rejects(() => writeFileSafely(deps(filesystem), "/w/part.py", "new"));
  assert.equal(filesystem.files["/w/part.py"], "old");
  assert.equal(filesystem.files["/w/part.py.abcd1234.b123d-tmp"], undefined);
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

test("an unresolvable path falls back to the one the user gave", async () => {
  const filesystem = fakeFilesystem({ files: { "/w/part.py": "old" }, fail: ["resolve"] });
  const written = await writeFileSafely(deps(filesystem), "/w/part.py", "new");

  assert.equal(written, "/w/part.py");
  assert.equal(filesystem.files["/w/part.py"], "new");
});

// --- the file stays the file ------------------------------------------------

test("a save keeps the file it saved, rather than putting a new one there", async () => {
  // The property this module was changed for. Writing a temporary and renaming
  // it over the target replaces the inode, and what goes with it is not
  // abstract: a hard link keeps the old contents for ever, and extended
  // attributes - Finder tags among them - are gone. Measured on a real file
  // before the change: part.py and a hard link to it ended up with different
  // inodes and different text.
  const filesystem = fakeFilesystem({ files: { "/p/part.py": "old" } });
  const before = filesystem.inodes["/p/part.py"];

  await writeFileSafely(deps(filesystem), "/p/part.py", "new");

  assert.equal(filesystem.files["/p/part.py"], "new");
  assert.equal(filesystem.inodes["/p/part.py"], before, "the file was replaced rather than written");
});

test("nothing is written beside the target, and nothing is moved", async () => {
  // The same claim from the other side: a temporary that is renamed into place
  // would leave both a write to another path and a move in the record.
  const filesystem = fakeFilesystem({ files: { "/p/part.py": "old" } });

  await writeFileSafely(deps(filesystem), "/p/part.py", "new");

  const writes = filesystem.calls.filter((c) => c.operation === "write");
  assert.deepEqual(writes.map((c) => c.path), ["/p/part.py"]);
  assert.equal(filesystem.calls.some((c) => c.operation === "move"), false);
  assert.deepEqual(Object.keys(filesystem.files), ["/p/part.py"], "something was left beside it");
});

test("the mode is left alone, because the file was never replaced", async () => {
  // A fresh temporary carries the default mode, so the old path had to put the
  // target's permissions back after every save. Writing into the file keeps
  // them, and touching them anyway is a way to get them wrong.
  const filesystem = fakeFilesystem({ files: { "/p/part.py": "old" }, permissions: { r: true } });

  await writeFileSafely(deps(filesystem), "/p/part.py", "new");

  assert.equal(
    filesystem.calls.some((c) => c.operation === "setPermissions"),
    false,
    "the save changed permissions it had no reason to touch",
  );
});

test("a new file is created, and only where it was asked for", async () => {
  const filesystem = fakeFilesystem({ files: {} });

  const written = await writeFileSafely(deps(filesystem), "/p/fresh.py", "b = Box(1, 2, 3)");

  assert.equal(written, "/p/fresh.py");
  assert.deepEqual(Object.keys(filesystem.files), ["/p/fresh.py"]);
});
