// Runner for the frontend suite, in tests/frontend.
//
// The third of three, and the split is about what each can see. `yarn test` is
// pure modules in node - no DOM, no Neutralino, no Monaco - and it is fast
// because of it. `yarn test:sidecar` reaches the Python classes directly and
// widens races on purpose. `yarn test:integration` drives the real sidecar and
// a real kernel over the socket, which is the right layer for ipc and the wrong
// one for "the dirty dot appeared on the tab".
//
// This one is the layer none of those reach: the application as a user meets
// it, in a real engine, with a real layout and the real stylesheet. It is the
// only suite that can answer whether something is *visible*.
//
// It builds first rather than assuming a build. The bundle goes to
// tests/frontend/build and never to resources/, which is Neutralino's
// documentRoot - building the test bundle over that would leave the packaged
// application wired to a stub, and the next `neu run` would look like a very
// confusing bug.

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, shell: false });
  if (result.error !== undefined) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

const built = run("npx", ["vite", "build", "--config", "vite.config.test.js"]);
if (built !== 0) {
  console.error("The test bundle did not build; the suite cannot say anything.");
  process.exit(built);
}

process.exit(run("npx", ["playwright", "test", ...process.argv.slice(2)]));
