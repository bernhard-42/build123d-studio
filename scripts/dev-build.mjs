// Increment the local development build number.
//
// Two builds of the same version are indistinguishable once they are installed,
// which has already cost real time: a Windows fix was tested twice against a
// package that turned out to predate it, and the only way to tell was to
// compare checksums by hand. A number that goes up on every package makes
// "0.2.0.dev17 is the one" a sentence that can be said and checked.
//
// The counter lives in .dev-build, which is gitignored, and that is the whole
// mechanism for keeping it out of releases: a CI checkout does not have the
// file, so vite finds nothing to inject and the version stays exactly
// package.json's. There is no CI branch to get wrong, and a tagged build cannot
// accidentally call itself a development one.
//
// Monotonic, and never reset when the version changes. The point is to name one
// build unambiguously, and a counter that restarts produces two 0.1.4.dev1s.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COUNTER = join(dirname(dirname(fileURLToPath(import.meta.url))), ".dev-build");

/** The current number, or 0 when there has never been a development build. */
export function current() {
  if (!existsSync(COUNTER)) {
    return 0;
  }
  const parsed = Number.parseInt(readFileSync(COUNTER, "utf8").trim(), 10);
  // A corrupted counter must not stop a build, and starting again from zero is
  // more honest than guessing what it was.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

if (process.argv.includes("--next")) {
  const next = current() + 1;
  writeFileSync(COUNTER, `${next}\n`);
  console.log(`development build ${next}`);
}
