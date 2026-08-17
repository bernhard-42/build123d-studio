import { events, os } from "@neutralinojs/lib";

import { quoteFor } from "./quoting.js";
import { createRegistry } from "./running.js";
import * as log from "./log.js";

// Thin wrappers over Neutralino's spawnProcess.
//
// Everything the app runs - uv, the sidecar - goes through here, and what is
// started through run() is also recorded so a quit can collect it: see
// running.js. Neutralino
// delivers a spawned process's output as "spawnedProcess" events keyed by
// process id, so a single global listener fans them back out to the right
// caller.

const handlers = new Map();
let listening = false;

function ensureListener() {
  if (listening) {
    return;
  }
  listening = true;
  events.on("spawnedProcess", (evt) => {
    const { id, action, data } = evt.detail;
    const handler = handlers.get(id);
    if (handler === undefined) {
      return;
    }
    if (action === "stdOut") {
      handler.onStdOut(data);
    } else if (action === "stdErr") {
      handler.onStdErr(data);
    } else if (action === "exit") {
      // "exit" is what the native layer emits on process termination; data is
      // the exit code. (Confusingly it is also the action name used to *ask*
      // updateSpawnedProcess to terminate a process.)
      handlers.delete(id);
      handler.onExit(Number(data));
    }
  });
}

/**
 * Shell-quote a value for the command string.
 *
 * EVERY value interpolated into a command goes through this - not only the ones
 * that might contain a space. spawnProcess hands the string to a shell, so an
 * unquoted value is a command injection rather than a formatting bug.
 *
 * The rules live in quoting.js, apart from Neutralino, so they can be tested:
 * the Windows half is the half that matters and this is not a Windows machine.
 */
export function quote(value) {
  return quoteFor(NL_OS, value);
}

/**
 * Put our variables where a child will inherit them, and never use
 * spawnProcess's envs parameter.
 *
 * That parameter cannot be used on Windows at all. Neutralino's vendored
 * tiny-process-library builds the environment block as UTF-16 under #ifdef
 * UNICODE and then calls CreateProcess without CREATE_UNICODE_ENVIRONMENT
 * (lib/tinyprocess/process_win.cpp - the flag appears nowhere in the file), so
 * Windows reads a wide block as ANSI, sees nonsense, and refuses to create the
 * process. Every spawn carrying any environment at all returns pid 0 and exit
 * code -1 with no output, whatever the variables are: measured, then confirmed
 * against the source.
 *
 * It is also wrong everywhere else, if less fatally: given an envs map
 * Neutralino builds the child's whole environment from it and inherits nothing,
 * so the sidecar has been running on macOS with exactly two variables - no
 * PATH, no HOME - and the kernel inherited that.
 *
 * Setting them on this process fixes both. Children inherit them natively,
 * which is what an empty envs map already asks Neutralino to do. The variables
 * are ours (UV_*, PYTHON*), they are the same for every spawn that wants them,
 * and the only processes this application starts are the ones they are meant
 * for.
 */
async function exportEnvironment(envs) {
  if (envs === undefined || Object.keys(envs).length === 0) {
    return;
  }
  for (const [name, value] of Object.entries(envs)) {
    try {
      await os.setEnv(name, value);
    } catch (error) {
      log.warn(`Could not set ${name} for child processes:`, error);
    }
  }
  log.info(`spawn environment: exported ${Object.keys(envs).length} variables to inherit`);
}

/**
 * Start a long-lived process and keep a handle on it.
 *
 * @returns {Promise<{id: number, pid: number, write: (s: string) => Promise<void>,
 *                    closeStdin: () => Promise<void>, kill: () => Promise<void>,
 *                    exited: Promise<number>}>}
 */
export async function spawn(command, { cwd, envs, onStdOut, onStdErr } = {}) {
  ensureListener();

  let settleExit;
  const exited = new Promise((resolve) => {
    settleExit = resolve;
  });

  // Logged either side of the call, because "exited with -1" cannot distinguish
  // a process that was never created from one that started and died: both look
  // identical from the exit handler, and on Windows the first is what a bad
  // command line, a rejected working directory or a malformed environment block
  // all produce.
  await exportEnvironment(envs);

  log.info(`spawn: cwd=${cwd ?? "(inherited)"} command=${command.slice(0, 300)}`);
  let proc;
  try {
    // Deliberately no envs: see exportEnvironment. Passing one is fatal on
    // Windows and lossy everywhere else.
    proc = await os.spawnProcess(command, { cwd });
  } catch (error) {
    log.error("spawnProcess refused to start the process:", error);
    throw error;
  }
  log.info(`spawned: id=${proc.id} pid=${proc.pid}`);

  handlers.set(proc.id, {
    onStdOut: onStdOut ?? (() => {}),
    onStdErr: onStdErr ?? (() => {}),
    onExit: (code) => settleExit(code),
  });

  return {
    id: proc.id,
    pid: proc.pid,
    write: (data) => os.updateSpawnedProcess(proc.id, "stdIn", data),
    closeStdin: () => os.updateSpawnedProcess(proc.id, "stdInEnd"),
    kill: () => os.updateSpawnedProcess(proc.id, "exit"),
    exited,
  };
}

/**
 * Run a process to completion, streaming its output line-wise to onLine.
 *
 * stdout and stderr are merged, because for uv the interesting progress
 * reporting arrives on stderr.
 *
 * @returns {Promise<number>} exit code
 */
// Everything run() starts, so that a quit can collect whatever is still going.
//
// Deliberately here and not in spawn(). The sidecar is spawned directly and is
// the one child that must never be killed - its teardown is its own, reached by
// closing its stdin - so tracking a layer lower captures exactly the
// fire-and-forget processes that had no teardown at all, and nothing else.
const live = createRegistry();

/**
 * Kill anything still running, and say how many that was.
 *
 * For the way out, and it has to be awaited: app.exit() immediately afterwards
 * would otherwise beat the kill requests to the native side. See running.js for
 * why any of this exists.
 */
export async function stopRunning() {
  return live.stopAll({
    onError: (handle, error) => log.warn(`Could not stop pid ${handle.pid}:`, error),
  });
}

export async function run(command, { cwd, envs, onLine } = {}) {
  let buffer = "";

  const emit = (chunk) => {
    if (onLine === undefined) {
      return;
    }
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  };

  const proc = live.track(
    await spawn(command, { cwd, envs, onStdOut: emit, onStdErr: emit })
  );
  let code;
  try {
    code = await proc.exited;
  } finally {
    // Whether it ended or threw. A handle left behind here would be killed at
    // quit long after its process had gone, and on a reused id that is somebody
    // else's process.
    live.forget(proc);
  }

  if (buffer.length > 0 && onLine !== undefined) {
    onLine(buffer);
  }
  return code;
}
