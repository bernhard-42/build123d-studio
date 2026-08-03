// node --test src/editor/buffers.test.mjs
//
// The bookkeeping behind many open files, with a fake model in place of Monaco's.
// What can be wrong here without a window: a buffer keeping another buffer's
// dirty flag, a closed model never being disposed, and a key outliving the
// buffer it named. The last two are the ones that hurt later - the leak is
// invisible until forty files have been opened, and a reused key hands one
// buffer's edits to another.
//
// Whether Monaco's alternative version id really returns to its earlier value on
// undo is Monaco's business and is documented; what is tested here is that this
// module compares against the right one.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  active,
  activate,
  activeKeyOf,
  close,
  get,
  initBuffers,
  isDirty,
  keys,
  markSaved,
  open,
  setPath,
  setViewState,
  viewState,
} from "./buffers.js";

/**
 * Monaco stands in as a counter with a disposed flag.
 *
 * A real model's alternative version id moves on every edit and comes back on
 * undo, which is exactly a number the test can set - so `edit` and `undoTo` are
 * enough to reproduce every case this module has an opinion about.
 */
function fakeModels() {
  const created = [];
  const api = {
    create(text) {
      const model = { text, version: 1, disposed: false };
      created.push(model);
      return model;
    },
    dispose(model) {
      model.disposed = true;
    },
    versionOf(model) {
      return model.version;
    },
  };
  return { api, created };
}

const edit = (model) => {
  model.version += 1;
};
const undoTo = (model, version) => {
  model.version = version;
};

// --- identity ---

test("two buffers on the same path are still two buffers", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const first = open({ path: "/p/a.py", text: "" });
  const second = open({ path: "/p/a.py", text: "" });

  assert.notEqual(first, second);
  assert.equal(keys().length, 2);
});

test("a key is never reused, so a stale one names nothing", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const first = open({ path: "/p/a.py", text: "" });
  close(first);
  const second = open({ path: "/p/b.py", text: "" });

  assert.notEqual(second, first);
  assert.equal(get(first), null);
});

test("Save As renames the buffer rather than replacing it", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const key = open({ path: null, text: "part = Box(1, 1, 1)" });
  const model = get(key).model;
  setPath(key, "/p/bracket.py");

  assert.equal(get(key).path, "/p/bracket.py");
  // The same model, so the undo history survives being given a name.
  assert.equal(get(key).model, model);
});

// --- dirtiness, per buffer ---

test("a freshly opened buffer is clean, however much text it has", () => {
  const { api } = fakeModels();
  initBuffers(api);

  assert.equal(isDirty(open({ path: "/p/a.py", text: "x = 1\n" })), false);
  assert.equal(isDirty(open({ path: null, text: "from build123d import *\n" })), false);
});

test("editing one buffer does not make another dirty", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const edited = open({ path: "/p/a.py", text: "" });
  const untouched = open({ path: "/p/b.py", text: "" });
  edit(get(edited).model);

  assert.equal(isDirty(edited), true);
  assert.equal(isDirty(untouched), false);
});

test("saving one buffer does not clean another", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const saved = open({ path: "/p/a.py", text: "" });
  const other = open({ path: "/p/b.py", text: "" });
  edit(get(saved).model);
  edit(get(other).model);

  markSaved(saved);

  assert.equal(isDirty(saved), false);
  assert.equal(isDirty(other), true);
});

test("undoing back to the saved version is clean again", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const key = open({ path: "/p/a.py", text: "" });
  const model = get(key).model;
  const atSave = model.version;
  edit(model);
  assert.equal(isDirty(key), true);

  undoTo(model, atSave);
  assert.equal(isDirty(key), false);
});

test("a buffer that is gone is not dirty, so quitting is never blocked by one", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const key = open({ path: "/p/a.py", text: "" });
  edit(get(key).model);
  close(key);

  assert.equal(isDirty(key), false);
});

// --- disposal ---

test("closing disposes the model", () => {
  const { api, created } = fakeModels();
  initBuffers(api);

  const key = open({ path: "/p/a.py", text: "" });
  assert.equal(created[0].disposed, false);

  close(key);
  assert.equal(created[0].disposed, true);
  assert.equal(keys().length, 0);
});

test("closing the same buffer twice disposes nothing a second time", () => {
  const { api, created } = fakeModels();
  initBuffers(api);

  const key = open({ path: "/p/a.py", text: "" });
  assert.notEqual(close(key), null);
  created[0].disposed = false;

  assert.equal(close(key), null);
  assert.equal(created[0].disposed, false);
});

test("closing the active buffer leaves nothing active", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const key = open({ path: "/p/a.py", text: "" });
  activate(key);
  close(key);

  assert.equal(activeKeyOf(), null);
  assert.equal(active(), null);
});

test("closing an inactive buffer leaves the active one alone", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const shown = open({ path: "/p/a.py", text: "" });
  const other = open({ path: "/p/b.py", text: "" });
  activate(shown);
  close(other);

  assert.equal(activeKeyOf(), shown);
});

// --- what the editor is showing ---

test("nothing is active until something is activated", () => {
  const { api } = fakeModels();
  initBuffers(api);

  open({ path: "/p/a.py", text: "" });
  assert.equal(activeKeyOf(), null);
  assert.equal(active(), null);
});

test("activating a buffer that does not exist is a bug, not a silent no-op", () => {
  const { api } = fakeModels();
  initBuffers(api);

  assert.throws(() => activate(99), /No such buffer/);
});

test("the view state is remembered per buffer", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const first = open({ path: "/p/a.py", text: "" });
  const second = open({ path: "/p/b.py", text: "" });
  setViewState(first, { line: 380 });
  setViewState(second, { line: 4 });

  assert.deepEqual(viewState(first), { line: 380 });
  assert.deepEqual(viewState(second), { line: 4 });
});

test("a buffer that has never been shown has no view state", () => {
  const { api } = fakeModels();
  initBuffers(api);

  assert.equal(viewState(open({ path: "/p/a.py", text: "" })), null);
});

// --- order ---

test("keys come back in the order the buffers were opened", () => {
  const { api } = fakeModels();
  initBuffers(api);

  const a = open({ path: "/p/a.py", text: "" });
  const b = open({ path: "/p/b.py", text: "" });
  const c = open({ path: "/p/c.py", text: "" });
  close(b);

  assert.deepEqual(keys(), [a, c]);
});

test("initBuffers starts a window with nothing open", () => {
  const { api } = fakeModels();
  initBuffers(api);
  const key = open({ path: "/p/a.py", text: "" });
  activate(key);

  initBuffers(api);
  assert.deepEqual(keys(), []);
  assert.equal(activeKeyOf(), null);
});
