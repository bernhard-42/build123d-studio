// node --test tests/unit/editor/workspace.test.mjs
//
// Reading the remembered session. This runs once per start, against a file an
// older version wrote, and when it is wrong the symptom is "my tabs are gone
// after the upgrade" - which is exactly the class of thing that has to be
// tested rather than tried once by hand and assumed.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { chooseActive, readWorkspace } from "../../../src/editor/workspace.js";

const settings = (overrides = {}) => ({
  workspace: undefined,
  lastFile: undefined,
  lastPosition: undefined,
  lastScrollTop: undefined,
  ...overrides,
});

// --- what this version writes ---

test("tabs come back in order, with their carets and the active path", () => {
  const read = readWorkspace(settings({
    workspace: {
      tabs: [
        { path: "/p/a.py", caret: { line: 12, column: 3, scrollTop: 240 } },
        { path: "/p/b.py", caret: null },
      ],
      active: "/p/b.py",
    },
  }));
  assert.deepEqual(read.tabs.map((t) => t.path), ["/p/a.py", "/p/b.py"]);
  assert.deepEqual(read.tabs[0].caret, { line: 12, column: 3, scrollTop: 240 });
  assert.equal(read.tabs[1].caret, null);
  assert.equal(read.active, "/p/b.py");
});

test("an empty workspace is an answer, not a missing one", () => {
  // Somebody closed every tab and quit. Falling through to the legacy keys here
  // would reopen a file they had deliberately closed, possibly versions ago.
  const read = readWorkspace(settings({ workspace: { tabs: [], active: null }, lastFile: "/p/old.py" }));
  assert.deepEqual(read.tabs, []);
  assert.equal(read.active, null);
});

// --- upgrading from before tabs ---

test("the single remembered file becomes a one-tab workspace", () => {
  const read = readWorkspace(settings({
    lastFile: "/p/bracket.py",
    lastPosition: { line: 380, column: 5 },
    lastScrollTop: 9000,
  }));
  assert.deepEqual(read.tabs, [
    { path: "/p/bracket.py", caret: { line: 380, column: 5, scrollTop: 9000 } },
  ]);
  assert.equal(read.active, "/p/bracket.py");
});

test("a remembered file with no remembered position still opens", () => {
  const read = readWorkspace(settings({ lastFile: "/p/bracket.py" }));
  assert.deepEqual(read.tabs, [{ path: "/p/bracket.py", caret: null }]);
});

test("the new key wins over the old ones, so migration happens once", () => {
  const read = readWorkspace(settings({
    workspace: { tabs: [{ path: "/p/new.py" }], active: "/p/new.py" },
    lastFile: "/p/old.py",
  }));
  assert.deepEqual(read.tabs.map((t) => t.path), ["/p/new.py"]);
});

test("a first-ever start has nothing to reopen", () => {
  assert.equal(readWorkspace(settings()), null);
});

// --- files written by something that went wrong ---

test("damaged entries are dropped rather than taking the session with them", () => {
  const read = readWorkspace(settings({
    workspace: {
      tabs: [
        { path: "/p/a.py" },
        null,
        { path: "" },
        { caret: { line: 1 } },
        "not a tab",
        { path: "/p/b.py" },
      ],
      active: "/p/b.py",
    },
  }));
  assert.deepEqual(read.tabs.map((t) => t.path), ["/p/a.py", "/p/b.py"]);
});

test("a workspace that is not a workspace falls back to the old keys", () => {
  for (const workspace of [null, 42, "tabs", { tabs: "no" }, {}]) {
    const read = readWorkspace(settings({ workspace, lastFile: "/p/old.py" }));
    assert.deepEqual(read.tabs.map((t) => t.path), ["/p/old.py"], JSON.stringify(workspace));
  }
});

test("a caret without a usable line is no caret", () => {
  const read = readWorkspace(settings({
    workspace: {
      tabs: [
        { path: "/p/a.py", caret: { column: 3 } },
        { path: "/p/b.py", caret: "somewhere" },
        { path: "/p/c.py", caret: { line: "12" } },
      ],
      active: null,
    },
  }));
  assert.deepEqual(read.tabs.map((t) => t.caret), [null, null, null]);
});

test("a caret missing its column or scroll keeps the part that is there", () => {
  const read = readWorkspace(settings({
    workspace: { tabs: [{ path: "/p/a.py", caret: { line: 40 } }], active: null },
  }));
  assert.deepEqual(read.tabs[0].caret, { line: 40, column: 1, scrollTop: null });
});

test("an active path that is not a string is no active path", () => {
  for (const active of [null, 3, "", { path: "/p/a.py" }]) {
    const read = readWorkspace(settings({ workspace: { tabs: [{ path: "/p/a.py" }], active } }));
    assert.equal(read.active, null);
  }
});

// --- choosing what to show ---

test("the remembered tab is shown when it opened", () => {
  assert.equal(chooseActive(["/p/a.py", "/p/b.py"], "/p/b.py"), "/p/b.py");
});

test("a remembered tab that did not open falls back to the first", () => {
  // Deleted between sessions: the index it used to sit at now belongs to
  // another file, which is why this is done by path.
  assert.equal(chooseActive(["/p/a.py", "/p/c.py"], "/p/b.py"), "/p/a.py");
});

test("nothing open is nothing to show", () => {
  assert.equal(chooseActive([], "/p/a.py"), null);
  assert.equal(chooseActive([], null), null);
});
