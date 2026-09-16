// The two source-picker entries in src/packages.js, held at the level a test
// can reach: the module itself imports the bootstrap, which imports a JSON
// file without the attribute node insists on, so it cannot be loaded here.
// The invariant is about a string constant, and the source is where it lives.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = readFileSync(new URL("../../src/packages.js", import.meta.url), "utf8");

test("every repository is an https URL, because uv reads it as one", () => {
  // The scp-style `git@github.com:owner/repo` that git accepts is not a URL,
  // and uv refuses the whole pyproject.toml over it - "relative URL without a
  // base" - which is what choosing GitHub for ocp-viewer-core did. Both
  // repositories are public, so https needs no key on the user's machine.
  const found = [...SOURCE.matchAll(/repository:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(found.length, 2, `expected the two picker entries, found ${found.length}`);

  for (const repository of found) {
    let url = null;
    assert.doesNotThrow(() => {
      url = new URL(repository);
    }, `${repository} is not a URL at all`);
    assert.equal(url.protocol, "https:", `${repository} is not https`);
    assert.equal(url.hostname, "github.com");
  }
});
