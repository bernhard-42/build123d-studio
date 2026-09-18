// Deciding whether a command-line tool is on this machine, from what a probe
// of it says. Pure: the spawn and the log come in as arguments, so the
// decisions are tested in node and tools.js is only the wiring.
//
// Written to be believed when it says yes and doubted when it says no. The
// first hasGit ran `git --version`, took a non-zero exit as absence and
// remembered that for the session - and once, with git plainly installed,
// Settings offered no GitHub sources until the application was restarted.
// Nothing was recorded, so which of the following it was is not known; each
// is real, and each is closed here:
//
// * A broken cmd AutoRun on Windows makes every spawn report exit code 1,
//   success included - measured, see the 0.7.0 first-start fix. The output is
//   still the tool's own, so the tool is *present* when its banner arrives
//   whatever the code says. The code alone decides only when nothing was
//   printed at all.
// * A probe that never exits - macOS's /usr/bin/git without the developer
//   tools opens a dialog and waits for it - would hold the caller for ever.
//   It is given a bounded wait, and past it the answer is "unknown".
// * A failure is not remembered. A probe can lose to the moment it runs in - a
//   spawn refused during startup, a shell still coming up - and one bad moment
//   must not decide the session. Only a yes is cached; anything else is asked
//   again the next time somebody wants to know, which is a right-click or a
//   dialog later and costs twenty milliseconds.

// How long a `--version` gets. Measured well under a second on every machine
// this has run on; ten seconds is for a shell that is slow to start, not for
// the tool.
export const PROBE_TIMEOUT = 10000;

/**
 * A prober over one `run`, remembering the tools it has found.
 *
 * @param {(command: string, options: {onLine: (line: string) => void}) => Promise<number>} run
 * @param {{info: Function, warn: Function}} log
 */
export function createProber(run, log) {
  const present = new Set();

  /**
   * What a probe found: the tool, its absence, or nothing it can vouch for.
   *
   * "unknown" is the honest answer for a probe that threw or timed out. A
   * caller that would *discard* something on "absent" - a stored choice - must
   * not act on it; one that only hides a menu entry can treat it as "not now".
   *
   * @param {string} name what is being asked about, for the cache and the log
   * @param {string} command the probe, e.g. "git --version"
   * @param {RegExp} banner what the tool prints when it is there
   * @param {number} [timeout]
   * @returns {Promise<"present"|"absent"|"unknown">}
   */
  async function probe(name, command, banner, timeout = PROBE_TIMEOUT) {
    if (present.has(name)) {
      return "present";
    }
    let output = "";
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeout);
    });
    let code;
    try {
      code = await Promise.race([
        run(command, { onLine: (line) => { output += `${line}\n`; } }),
        expired,
      ]);
    } catch (error) {
      log.warn(`Could not probe for ${name}:`, error);
      return "unknown";
    } finally {
      clearTimeout(timer);
    }

    if (banner.test(output) || code === 0) {
      // The banner is the tool's own word. A zero without it is a tool of
      // that name that said nothing this recognises - believed too, because
      // the one thing a zero cannot mean is "not installed".
      present.add(name);
      return "present";
    }
    if (code === "timeout") {
      log.warn(`${name} not found: ${command} did not answer within ${timeout} ms`);
      return "unknown";
    }
    log.info(`${name} not found: ${command} exited ${code}`);
    return "absent";
  }

  /** probe as a yes or no, where "unknown" is a no for now. */
  async function has(name, command, banner, timeout) {
    return (await probe(name, command, banner, timeout)) === "present";
  }

  return { probe, has, forget: () => present.clear() };
}
