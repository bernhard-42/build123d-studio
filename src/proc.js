import { events, os } from "@neutralinojs/lib";

// Thin wrappers over Neutralino's spawnProcess.
//
// Everything the app runs - uv, the sidecar - goes through here. Neutralino
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

/** Shell-quote a path so it survives spaces in the command string. */
export function quote(value) {
  if (NL_OS === "Windows") {
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

  const proc = await os.spawnProcess(command, { cwd, envs });

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

  const proc = await spawn(command, { cwd, envs, onStdOut: emit, onStdErr: emit });
  const code = await proc.exited;

  if (buffer.length > 0 && onLine !== undefined) {
    onLine(buffer);
  }
  return code;
}
