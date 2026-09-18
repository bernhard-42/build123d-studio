// Whether git and make are on this machine.
//
// Two answers from two places, because two PATHs are in play. This process
// has the launcher's - from the Finder, four system directories - and it is
// the one uv runs on when it shells out to git, so git is probed here, over
// the real spawn, with toolprobe.js deciding. The sidecar has the PATH a run
// gets - the environment's bin and the login shell's entries in front, see
// sidecar/shellpath.py - and make runs there, so make is the sidecar's to
// answer. The same rule for both: a yes is remembered, anything else is
// asked again.

import { run } from "./proc.js";
import * as ipc from "./ipc.js";
import * as log from "./log.js";
import { createProber } from "./toolprobe.js";

const prober = createProber(run, log);

const GIT = ["git", "git --version", /git version/i];

// Long enough for a sidecar that is busy, not for one that is gone; the row
// menu is waiting on this, and a Makefile with no Make entries is the
// harmless outcome.
const TOOL_TIMEOUT = 5000;
const sidecarHas = new Set();

/**
 * Is a git binary available?
 *
 * uv resolves git refs over HTTPS on its own, but `uv sync` shells out to git
 * to fetch and build - it fails with "Git executable not found" otherwise. The
 * PyPI sources never need it, so this only gates the GitHub option.
 */
export function hasGit() {
  return prober.has(...GIT);
}

/** hasGit with its doubt kept: "absent" is the only answer worth acting on. */
export function probeGit() {
  return prober.probe(...GIT);
}

/** Is make on the PATH a run gets? Gates the Make entries in a Makefile's row menu. */
export async function hasMake() {
  if (sidecarHas.has("make")) {
    return true;
  }
  try {
    const reply = await ipc.request("run.tool", { name: "make" }, { timeout: TOOL_TIMEOUT });
    if (reply?.present === true) {
      sidecarHas.add("make");
      return true;
    }
    log.info("make not found on the sidecar's PATH");
    return false;
  } catch (error) {
    log.warn("Could not ask the sidecar for make:", error);
    return false;
  }
}
