// node --test src/editor/journal.test.mjs
//
// The journal exists for the ends that ask nobody - a webview that dies, a
// kill, a power cut - so none of its behaviour can be reached by using the
// application normally. What is held here is the decision table: what gets a
// copy, what removes one, what is deliberately not copied, and above all what
// must never happen on the typing path.
//
// The scheduler is injected for that last one. "A burst of typing costs one
// copy" is a property, not a delay to sit through.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  clearJournal,
  createRecorder,
  forgetBuffer,
  journalRoot,
  MAX_RECORDED_CHARS,
  recordBuffer,
  worthRecording,
} from "./journal.js";

function fakeFilesystem({ files = {} } = {}) {
  const calls = [];
  return {
    calls,
    files,
    getJoinedPath: async (path) => path,
    getPermissions: async () => { throw new Error("no file"); },
    setPermissions: async () => {},
    readFile: async (path) => {
      if (!(path in files)) {
        throw new Error("no such file");
      }
      return files[path];
    },
    writeFile: async (path, data) => {
      calls.push({ operation: "write", path });
      files[path] = data;
    },
    move: async (from, to) => {
      calls.push({ operation: "move", from, to });
      files[to] = files[from];
      delete files[from];
    },
    remove: async (path) => {
      calls.push({ operation: "remove", path });
      if (!(path in files)) {
        throw new Error("no such file");
      }
      delete files[path];
    },
    createDirectory: async (path) => {
      calls.push({ operation: "createDirectory", path });
    },
  };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ROOT = "/appdata/build123d-studio/recovery/abcd1234";
const deps = (filesystem) => ({ filesystem, log: silent, root: ROOT, instanceId: "abcd1234" });

test("the copy is one instance's own", () => {
  // Two windows must not write into each other's, for the same reason they get
  // a kernel connection file each.
  assert.equal(journalRoot("/data", "abcd1234"), "/data/recovery/abcd1234");
  assert.notEqual(journalRoot("/data", "abcd1234"), journalRoot("/data", "99887766"));
});

test("the copy is the document, not a wrapper around it", async () => {
  // Reading it back must not need parsing, and the file somebody finds in there
  // should be openable in any editor.
  const filesystem = fakeFilesystem();
  await recordBuffer(deps(filesystem), 7, { path: "/p/part.py", text: "b = Box(1)\n" });

  assert.equal(filesystem.files[`${ROOT}/7.py`], "b = Box(1)\n");
});

test("and it says which file it belongs to, separately", async () => {
  const filesystem = fakeFilesystem();
  await recordBuffer(deps(filesystem), 7, { path: "/p/part.py", text: "x\n" });

  assert.deepEqual(JSON.parse(filesystem.files[`${ROOT}/7.json`]), { path: "/p/part.py" });
});

test("an untitled buffer is copied too, and says it has no path", async () => {
  // The one with no other copy anywhere on disk.
  const filesystem = fakeFilesystem();
  await recordBuffer(deps(filesystem), 3, { path: null, text: "scratch\n" });

  assert.equal(filesystem.files[`${ROOT}/3.py`], "scratch\n");
  assert.deepEqual(JSON.parse(filesystem.files[`${ROOT}/3.json`]), { path: null });
});

test("the label can be left alone when it has not changed", async () => {
  // It changes on a Save As and at no other time, so writing it on every burst
  // of typing would be an extra round trip per second for sixty bytes.
  const filesystem = fakeFilesystem();
  await recordBuffer(deps(filesystem), 7, { path: "/p/part.py", text: "one\n" });
  const before = filesystem.calls.length;
  await recordBuffer(deps(filesystem), 7, { path: "/p/part.py", text: "two\n", withPath: false });

  assert.equal(filesystem.files[`${ROOT}/7.py`], "two\n");
  const written = filesystem.calls.slice(before).filter((c) => c.operation === "write");
  assert.equal(written.some((c) => c.path.endsWith(".json")), false,
    "the label was rewritten for a buffer whose path had not changed");
});

test("forgetting a buffer takes both its files", async () => {
  const filesystem = fakeFilesystem();
  await recordBuffer(deps(filesystem), 7, { path: "/p/part.py", text: "x\n" });

  await forgetBuffer(deps(filesystem), ROOT, 7);

  assert.equal(filesystem.files[`${ROOT}/7.py`], undefined);
  assert.equal(filesystem.files[`${ROOT}/7.json`], undefined);
});

test("forgetting one that was never recorded is not an error", async () => {
  // Every caller would otherwise have to know which buffers were ever dirty.
  const filesystem = fakeFilesystem();
  await forgetBuffer(deps(filesystem), ROOT, 99);
});

test("a graceful quit throws the whole journal away", async () => {
  const filesystem = fakeFilesystem({ files: { [ROOT]: "" } });
  await clearJournal(deps(filesystem), ROOT);

  assert.ok(filesystem.calls.some((c) => c.operation === "remove" && c.path === ROOT));
});

test("and failing to clear it is not fatal", async () => {
  // It runs on the way out. A journal left behind costs a prompt, not work.
  const filesystem = fakeFilesystem();
  await clearJournal(deps(filesystem), ROOT);
});

// --- what it must not cost -------------------------------------------------

test("a burst of typing costs one copy", async () => {
  const written = [];
  const timers = new Map();
  let next = 1;
  const recorder = createRecorder({
    schedule: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    cancel: (id) => timers.delete(id),
  });

  for (let i = 0; i < 20; i += 1) {
    recorder.schedule(7, () => written.push(i));
  }
  assert.equal(recorder.pending(), 1, "each keystroke booked its own copy");

  for (const fn of timers.values()) {
    fn();
  }
  assert.equal(written.length, 1, "twenty keystrokes wrote twenty copies");
});

test("two buffers are booked separately", async () => {
  const recorder = createRecorder({ schedule: () => 1, cancel: () => {} });
  recorder.schedule(1, () => {});
  recorder.schedule(2, () => {});
  assert.equal(recorder.pending(), 2);
});

test("a save drops a booking the typing left behind", () => {
  // Otherwise a copy lands just after the file it copies has been written, and
  // the journal claims unsaved work that is on disk.
  const recorder = createRecorder({ schedule: () => 1, cancel: () => {} });
  recorder.schedule(7, () => {});

  assert.equal(recorder.drop(7), true);
  assert.equal(recorder.pending(), 0);
  assert.equal(recorder.drop(7), false, "dropping twice must be harmless");
});

test("a buffer too large to copy cheaply is not copied", () => {
  // Files over ten megabytes only ask before opening rather than being refused,
  // so without this the worst case is a stringify and an IPC payload of
  // whatever somebody said yes to, on every burst of typing.
  assert.equal(worthRecording("x".repeat(1000)), true);
  assert.equal(worthRecording("x".repeat(MAX_RECORDED_CHARS)), true);
  assert.equal(worthRecording("x".repeat(MAX_RECORDED_CHARS + 1)), false);
});

test("and two megabytes is far above any plausible source file", () => {
  // Forty thousand lines of Python is about one megabyte, so this bounds the
  // pathological case and nothing anybody would actually be editing.
  const fortyThousandLines = "x = 1\n".repeat(40000);
  assert.equal(worthRecording(fortyThousandLines), true);
});
