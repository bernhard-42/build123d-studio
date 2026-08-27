// node --test tests/unit/csp.test.mjs
//
// The content security policy, asserted as data.
//
// It is not containment - nativeAllowList grants this page os.*, so a script
// that achieves execution here can spawn a process whatever the policy says.
// What it buys is that the hosts this application talks to stay few and
// enumerable, and that only holds if widening the list is a deliberate act
// rather than something that happens while chasing a feature that will not
// load. So the list lives here too, and a new entry has to be written twice.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HTML = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

/** The policy from index.html's meta tag, as directive -> sources. */
function policy() {
  const match = HTML.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(match !== null, "no Content-Security-Policy meta tag in index.html");
  const directives = {};
  for (const part of match[1].split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/).filter((token) => token !== "");
    if (name !== undefined) {
      directives[name] = sources;
    }
  }
  return directives;
}

test("connect-src names exactly the hosts this application talks to", () => {
  // Poly Haven is three-cad-viewer's environment-map CDN and was added
  // deliberately; see the reasoning in index.html. Anything else appearing here
  // is a question to answer, not a line to update.
  assert.deepEqual(policy()["connect-src"], [
    "'self'",
    "ws://127.0.0.1:*",
    "http://127.0.0.1:*",
    "https://dl.polyhaven.org",
  ]);
});

test("nothing is opened to the whole web", () => {
  // The failure this prevents is a directive quietly becoming a wildcard while
  // somebody is making a feature work: `*`, or a bare scheme, allows every host
  // there is and reads almost the same as a real entry.
  const forbidden = new Set(["*", "http:", "https:", "data:", "'unsafe-eval'"]);
  const allowed = { "img-src": new Set(["data:"]) };
  for (const [directive, sources] of Object.entries(policy())) {
    for (const source of sources) {
      if (allowed[directive]?.has(source)) {
        continue;
      }
      assert.ok(
        !forbidden.has(source),
        `${directive} allows ${source}, which is every host or every script`,
      );
    }
  }
});

test("the directives that close doors are still closed", () => {
  const csp = policy();
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'self'"]);
  assert.deepEqual(csp["form-action"], ["'none'"]);
});

test("scripts come from this application, or from a blob it made", () => {
  // 'unsafe-inline' here would be the one that matters: every value rendered
  // into the page - a file name, a docstring, a model label - becomes a script
  // the moment it can carry one.
  assert.deepEqual(policy()["script-src"], ["'self'", "blob:"]);
});
