// node --test tests/unit/allowlist.test.mjs
//
// Every native method the source calls is granted in neutralino.config.json.
//
// The runtime refuses a call outside nativeAllowList with "Missing permission
// to execute the native method", and the frontend harness's stub enforces no
// such list - so a call that is not granted passes every test and fails on a
// user's machine. computer.getDisplays did exactly that: caught, logged as
// "restoring the window anyway", and never once able to read a display.
//
// Proof, at writing: with "computer.getDisks" removed from the list, this
// fails naming src/bootstrap/diagnostics.js.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;
const CONFIG = JSON.parse(readFileSync(join(ROOT, "neutralino.config.json"), "utf8"));

// The namespaces the client library exposes as native calls. `window` is left
// out because the source imports it as neuWindow and the bare name is the DOM.
const NAMESPACES = [
  "app",
  "os",
  "filesystem",
  "events",
  "clipboard",
  "computer",
  "storage",
  "debug",
  "updater",
  "extensions",
  "resources",
  "server",
  "neuWindow",
];

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sources(path);
    } else if (entry.name.endsWith(".js")) {
      yield path;
    }
  }
}

/** Every `namespace.method(` in the source, as "namespace.method" -> files. */
function nativeCalls() {
  const calls = new Map();
  const pattern = new RegExp(`\\b(${NAMESPACES.join("|")})\\.(\\w+)\\(`, "g");
  for (const file of sources(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const namespace = match[1] === "neuWindow" ? "window" : match[1];
      const key = `${namespace}.${match[2]}`;
      if (!calls.has(key)) {
        calls.set(key, new Set());
      }
      calls.get(key).add(file.slice(ROOT.length));
    }
  }
  return calls;
}

function granted(call) {
  const [namespace] = call.split(".");
  return CONFIG.nativeAllowList.some((entry) => entry === call || entry === `${namespace}.*`);
}

test("every native method the source calls is in nativeAllowList", () => {
  const missing = [];
  for (const [call, files] of nativeCalls()) {
    if (!granted(call)) {
      missing.push(`${call} (${[...files].join(", ")})`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the list is not simply everything", () => {
  assert.ok(!CONFIG.nativeAllowList.includes("computer.*"));
});
