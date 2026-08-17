// Is another window of this application still running?
//
// One question, asked of the operating system, which is the only party that
// knows the answer through a kill, a crash, a suspend or a pulled plug. It
// exists for the recovery journal and for nothing else: a leftover journal
// belongs either to a session that died - offer its unsaved work back, then
// delete the copies - or to a window somebody is typing in this minute, whose
// work is not ours to take. Nothing in the copies distinguishes those.
//
// **Nothing here is hardcoded about this application's name.** `ps -o comm=`
// reports the full executable path on macOS and a name truncated to fifteen
// characters on Linux - `build123d-studio` is sixteen, so it arrives there as
// `build123d-studi` - while Windows reports `build123d-studio.exe`. Measured on
// all three. So this looks up its *own* pid in the same listing and takes
// whatever name the platform gave it: every row is then truncated, pathed or
// suffixed identically, and plain equality is right everywhere. It is also
// correct when the binary is not the packaged one, which is what `yarn start`
// runs.
//
// Pure, apart from the one call that runs the command, for quoting.js's reason:
// what is worth testing is the parsing and the matching, and neither needs a
// process to exist.

/**
 * The command that lists every process, as (pid, name).
 *
 * `tasklist` rather than PowerShell's Get-Process because it is present on
 * every Windows since XP and needs no execution policy; `/NH /FO CSV` is asked
 * for so that neither the header nor the column widths have to be parsed, and
 * because both are localised and the CSV is not.
 *
 * No filter by image name on either, which would be faster and is exactly what
 * this must not do: the name is what we are trying to learn.
 */
export function processListCommand(platform) {
  return platform === "Windows" ? "tasklist /NH /FO CSV" : "ps -A -o pid=,comm=";
}

/**
 * That command's output as pid -> name.
 *
 * Anything that does not parse is skipped rather than failing the lot. Both
 * commands emit lines that are not processes - tasklist prints a localised
 * "no tasks match" sentence when a filter finds nothing, ps prints nothing but
 * a caller may still hand us stderr - and one unreadable row must not cost the
 * answer.
 */
export function parseProcessList(platform, output) {
  const processes = new Map();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const entry = platform === "Windows" ? windowsRow(line) : posixRow(line);
    if (entry !== null) {
      processes.set(entry.pid, entry.name);
    }
  }
  return processes;
}

/** `"build123d-studio.exe","1234","Console","1","50,000 K"` */
function windowsRow(line) {
  // Deliberately not a general CSV parse: only the first two fields are wanted,
  // and both are quoted values without embedded quotes - a process name cannot
  // contain one, because Windows forbids it in a filename.
  const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
  if (match === null) {
    return null;
  }
  return { pid: Number(match[2]), name: match[1] };
}

/** `  62079 /Applications/build123d Studio.app/Contents/MacOS/build123d-studio` */
function posixRow(line) {
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
  if (match === null) {
    return null;
  }
  // The name is the rest of the line, spaces and all: a macOS bundle path
  // contains them, and comm is the last column, so nothing follows it.
  return { pid: Number(match[1]), name: match[2] };
}

/**
 * The pids running the same program as us, ourselves included.
 *
 * Null when the answer is not knowable - our own pid is not in the listing, so
 * either the command failed or it produced something this cannot read. Null is
 * not an empty set, and callers must not treat it as one: "nobody else is
 * alive" and "I could not find out" lead to opposite decisions about somebody's
 * unsaved work.
 *
 * Matching on the name as well as the number is what makes a recycled pid
 * harmless. A pid that now belongs to some unrelated program is not in this
 * set, so its journal is correctly dead; a pid that now belongs to *another*
 * window of this application is in it, so that journal is left for the next
 * start - deferred rather than taken, which is the safe way round.
 */
export function siblingPids(processes, ourPid) {
  const ours = processes.get(ourPid);
  if (ours === undefined) {
    return null;
  }
  const live = new Set();
  for (const [pid, name] of processes) {
    if (name === ours) {
      live.add(pid);
    }
  }
  return live;
}

/**
 * Ask the operating system which windows of this application are running.
 *
 * @param {{os: object, log: object, platform: string}} services
 * @param {number} ourPid this process, as NL_PID says
 * @returns {Promise<Set<number>|null>} null when it could not be established
 */
export async function liveWindows({ os, log, platform }, ourPid) {
  const command = processListCommand(platform);
  let result;
  try {
    result = await os.execCommand(command);
  } catch (error) {
    log.warn(`Could not list processes with \`${command}\`:`, error);
    return null;
  }
  if (result.exitCode !== 0) {
    log.warn(`\`${command}\` exited ${result.exitCode}: ${result.stdErr}`);
    return null;
  }
  const live = siblingPids(parseProcessList(platform, result.stdOut), ourPid);
  if (live === null) {
    log.warn(`\`${command}\` did not list this process (${ourPid}), so it cannot be trusted`);
  }
  return live;
}
