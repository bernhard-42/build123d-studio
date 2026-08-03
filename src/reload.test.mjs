// node --test src/reload.test.mjs
//
// A reload discards the editor buffer, so the cost of getting this table wrong
// is the user's unsaved work - and it is wrong per platform, which is where a
// test earns its keep here: Cmd-R is only a reload on macOS and F5 only on
// Windows and Linux, but the guard has to cover all of them because the same
// build runs everywhere.
//
// The half that cannot be asserted here is whether the webview lets a page
// cancel its accelerators at all. That is a real build's answer, on each
// platform. What this pins down is that the guard recognises the right chords
// and - the part that would break the console - that it never claims to have
// consumed them.
//
// The context-menu guard at the end is the same shape of problem found by the
// same means: the browser's own menu offers a Reload item, so the keys were
// never the only way in. What can be asserted is that the guard cancels the
// default and nothing else; whether Monaco then draws its own menu is, again,
// the build's answer.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { guardAgainstReload, isReloadChord, suppressNativeContextMenu } from "./reload.js";

const chord = (key, modifiers = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

test("F5 is a reload, dressed however", () => {
  assert.equal(isReloadChord(chord("F5")), true);
  assert.equal(isReloadChord(chord("F5", { ctrlKey: true })), true);
  assert.equal(isReloadChord(chord("F5", { shiftKey: true })), true);
  assert.equal(isReloadChord(chord("F5", { ctrlKey: true, shiftKey: true })), true);
});

test("Ctrl-R and Cmd-R are reloads, and so are their Shift forms", () => {
  assert.equal(isReloadChord(chord("r", { ctrlKey: true })), true, "Windows and Linux");
  assert.equal(isReloadChord(chord("r", { metaKey: true })), true, "macOS");
  assert.equal(isReloadChord(chord("r", { ctrlKey: true, shiftKey: true })), true);
  assert.equal(isReloadChord(chord("r", { metaKey: true, shiftKey: true })), true);
  assert.equal(isReloadChord(chord("R", { ctrlKey: true })), true, "capital, as Shift sends it");
});

test("a bare R is typing, not a reload", () => {
  assert.equal(isReloadChord(chord("r")), false);
  assert.equal(isReloadChord(chord("r", { shiftKey: true })), false);
  assert.equal(isReloadChord(chord("r", { altKey: true })), false);
});

test("Alt is nobody's reload, so those chords stay bindable", () => {
  assert.equal(isReloadChord(chord("F5", { altKey: true })), false);
  assert.equal(isReloadChord(chord("r", { ctrlKey: true, altKey: true })), false);
});

test("the run shortcuts are untouched by the guard", () => {
  // If this ever fails, Run Cell has stopped working rather than the reload
  // guard having got slightly too keen - which is the more expensive mistake.
  assert.equal(isReloadChord(chord("Enter", { shiftKey: true })), false);
  assert.equal(isReloadChord(chord("Enter", { ctrlKey: true })), false);
  assert.equal(isReloadChord(chord("Enter", { metaKey: true, shiftKey: true })), false);
});

test("nonsense is not a reload", () => {
  assert.equal(isReloadChord({}), false);
  assert.equal(isReloadChord({ key: null }), false);
  assert.equal(isReloadChord(null), false);
  assert.equal(isReloadChord(undefined), false);
});

// --- what the guard does with one ---

/** Enough of an EventTarget to see how the listener was registered. */
function fakeTarget() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    removeEventListener(type, handler, options) {
      const at = listeners.findIndex(
        (entry) => entry.type === type && entry.handler === handler
          && entry.options?.capture === options?.capture,
      );
      if (at >= 0) {
        listeners.splice(at, 1);
      }
    },
    fire(event) {
      for (const { handler } of listeners) {
        handler(event);
      }
    },
  };
}

function fakeEvent(key, modifiers = {}) {
  const event = chord(key, modifiers);
  event.defaultPrevented = false;
  event.propagationStopped = false;
  event.preventDefault = () => {
    event.defaultPrevented = true;
  };
  event.stopPropagation = () => {
    event.propagationStopped = true;
  };
  return event;
}

test("the guard listens in the capture phase", () => {
  // So it runs before anything that might stopPropagation on the way past and
  // leave the browser free to reload behind us.
  const target = fakeTarget();
  guardAgainstReload(target);
  assert.equal(target.listeners.length, 1);
  assert.equal(target.listeners[0].type, "keydown");
  assert.equal(target.listeners[0].options.capture, true);
});

test("a reload chord is cancelled but still delivered", () => {
  // The whole point. Ctrl-R is readline's reverse-i-search, so the console pane
  // must still receive it; only the browser's reaction is cancelled. Consuming
  // the key here would break searching the console history on every platform to
  // fix a reload that only happens on two.
  const target = fakeTarget();
  guardAgainstReload(target);

  const event = fakeEvent("r", { ctrlKey: true });
  target.fire(event);
  assert.equal(event.defaultPrevented, true, "the browser must not reload");
  assert.equal(event.propagationStopped, false, "the application must still see it");
});

test("F5 is cancelled but still reaches Run File", () => {
  const target = fakeTarget();
  guardAgainstReload(target);

  const event = fakeEvent("F5");
  target.fire(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, false, "Monaco's Run File must still fire");
});

test("everything else passes through untouched", () => {
  const target = fakeTarget();
  guardAgainstReload(target);

  const event = fakeEvent("Enter", { shiftKey: true });
  target.fire(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.propagationStopped, false);
});

test("the guard can be removed", () => {
  const target = fakeTarget();
  const remove = guardAgainstReload(target);
  remove();
  assert.equal(target.listeners.length, 0);

  const event = fakeEvent("F5");
  target.fire(event);
  assert.equal(event.defaultPrevented, false);
});

// --- the context menu, which carries a Reload item of its own ---

/** A right-click, which has no chord to it - only somewhere it happened. */
function rightClick() {
  const event = { defaultPrevented: false, propagationStopped: false };
  event.preventDefault = () => {
    event.defaultPrevented = true;
  };
  event.stopPropagation = () => {
    event.propagationStopped = true;
  };
  return event;
}

test("the native context menu is cancelled", () => {
  const target = fakeTarget();
  suppressNativeContextMenu(target);

  const event = rightClick();
  target.fire(event);
  assert.equal(event.defaultPrevented, true, "no browser menu, so no Reload item");
});

test("the event still propagates, so Monaco can draw its own menu", () => {
  // preventDefault cancels the browser's menu and nothing else. Monaco's is
  // HTML it renders itself in response to this same event, and stopping the
  // event would take that away along with the one being suppressed.
  const target = fakeTarget();
  suppressNativeContextMenu(target);

  const event = rightClick();
  target.fire(event);
  assert.equal(event.propagationStopped, false);
});

test("this guard bubbles, unlike the keydown one", () => {
  // Deliberately the opposite choice, and the tests say so because the two sit
  // in one file and look like an inconsistency. Capture is right for keydown so
  // it beats anything that would stopPropagation; bubbling is right here so a
  // pane gets to show its own menu before the event is called dealt with.
  const target = fakeTarget();
  suppressNativeContextMenu(target);
  assert.equal(target.listeners.length, 1);
  assert.equal(target.listeners[0].type, "contextmenu");
  assert.equal(target.listeners[0].options, undefined);
});

test("the context-menu guard can be removed", () => {
  const target = fakeTarget();
  const remove = suppressNativeContextMenu(target);
  remove();
  assert.equal(target.listeners.length, 0);

  const event = rightClick();
  target.fire(event);
  assert.equal(event.defaultPrevented, false);
});
