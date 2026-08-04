// One debug session, from Shift-F5 to the process exiting.
//
// The sidecar spawns the process and relays DAP; everything about what the
// protocol *means* is here, because the UI needs the same facts - which line is
// current, which frame is selected, whether anything is running - and a second
// copy in the sidecar would be a second thing to keep in step.
//
// Two worlds: none of this touches the kernel. The console keeps working
// throughout, the namespace is the same afterwards as before, and the objects
// the debugged file made die with it.

import { configure, createClient, setBreakpoints } from "./dap.js";
import * as breakpoints from "./breakpoints.js";
import { onStopBreakpointsOnly, onStopExpression } from "./settings.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";

// How long to wait for the process to spawn and dial back. Measured at 0.71 s;
// this is the bound on "something is wrong" rather than an expectation, and the
// sidecar has its own thirty seconds underneath it.
const START_TIMEOUT = 40000;

let client = null;
let running = false;
let stoppedAt = null;
// What the session was started on, so it can be started again the same way.
let target = null;
const watchers = new Set();

/** Tell the UI that something about the session changed. */
function announce() {
  for (const watcher of watchers) {
    try {
      watcher(state());
    } catch (error) {
      log.error("Debug watcher failed:", error);
    }
  }
}

/** Subscribe to session changes. Returns an unsubscribe function. */
export function onDebugChange(watcher) {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** What the UI draws from: is anything running, and where is it stopped. */
export function state() {
  return { running, stoppedAt };
}

export function isDebugging() {
  return running;
}

/**
 * Start debugging a file that is already on disk.
 *
 * The caller saves first. Debugging runs the file rather than the buffer -
 * that is what makes a breakpoint land on the line the user put it on, with no
 * mapping to be wrong about - so an unsaved buffer would debug yesterday's
 * code, which is worse than refusing.
 *
 * @param {string} path the file to run
 * @param {Array<{path: string, lines: number[]}>} files every marked file
 */
export async function start(path, files, options = {}) {
  if (running) {
    return false;
  }
  target = { path, files, options };
  running = true;
  stoppedAt = null;
  announce();

  const started = ipc.awaitOutcome("debug.started", ["debug.failed"], {
    timeout: START_TIMEOUT,
    what: "The debugger",
  });
  try {
    ipc.send("debug.start", { path });
    await started;
  } catch (error) {
    log.error("Could not start debugging:", error);
    running = false;
    announce();
    return false;
  }

  client = createClient({
    send: (message) => {
      try {
        ipc.send("debug.send", { message });
      } catch (error) {
        log.warn("Could not reach the debug adapter:", error);
      }
    },
  });

  client.on("stopped", (message) => {
    stoppedAt = {
      threadId: message.body?.threadId ?? null,
      // "breakpoint", "step", "exception"… - what the hook below decides on.
      reason: message.body?.reason ?? null,
      frame: null,
    };
    announce();
    void locate();
  });
  client.on("continued", () => {
    stoppedAt = null;
    announce();
  });
  client.on("terminated", () => void stop());
  client.on("exited", () => void stop());

  const marked = files.reduce((total, file) => total + file.lines.length, 0);
  const { verified } = await configure(client, files, options);
  log.info(`Debugging ${path}, ${verified} of ${marked} breakpoints set`);
  return true;
}

/**
 * Ask where execution is, once it has stopped.
 *
 * The `stopped` event says only which thread; the line comes from the stack,
 * and the top frame is what the editor highlights.
 */
async function locate() {
  if (client === null || stoppedAt === null) {
    return;
  }
  const reply = await client.request("stackTrace", { threadId: stoppedAt.threadId });
  const frames = reply?.body?.stackFrames ?? [];
  if (frames.length === 0 || stoppedAt === null) {
    return;
  }
  stoppedAt = {
    ...stoppedAt,
    frame: {
      id: frames[0].id,
      path: frames[0].source?.path ?? null,
      line: frames[0].line,
    },
    // Kept whole, because the call stack is the next commit's and asking twice
    // for something already in hand would be a second round trip per step.
    frames,
  };
  announce();
  await runOnStop();
}

/**
 * Run the on-stop expression, if there is one.
 *
 * After the frame is known and after the UI has been told, in that order: the
 * expression is evaluated *in* the frame, and it can take seconds - a
 * tessellation of a whole assembly - so the editor and the panes must already
 * show where execution is rather than waiting for a picture.
 *
 * Its result is not shown. A failure goes to the debug console, because an
 * expression that raises every time somebody steps needs saying once in a place
 * they are already looking, and silently doing nothing is how a setting gets
 * blamed on the debugger.
 */
async function runOnStop() {
  const expression = onStopExpression();
  if (client === null || expression === "") {
    return;
  }
  if (onStopBreakpointsOnly() && stoppedAt?.reason !== "breakpoint") {
    return;
  }
  const { success, output } = await evaluate(expression);
  if (!success) {
    announceOutput(`${expression} failed: ${output}`);
  }
}

/**
 * Carry on, or move by one line.
 *
 * The four share everything but the DAP command. Each clears the stopped state
 * before asking, because the mark in the gutter has to go the moment the user
 * presses the button - the adapter answers a step in milliseconds and a line
 * that stays highlighted while execution moves is the pane lying about where it
 * is. The next `stopped` event puts it back.
 */
async function proceed(command) {
  if (client === null || stoppedAt === null) {
    return;
  }
  const threadId = stoppedAt.threadId;
  stoppedAt = null;
  announce();
  await client.request(command, { threadId });
}

export const resume = () => proceed("continue");
export const stepOver = () => proceed("next");
export const stepInto = () => proceed("stepIn");
export const stepOut = () => proceed("stepOut");

/**
 * A file's marks changed while the session is running.
 *
 * DAP replaces a source's breakpoints wholesale rather than adding or removing
 * one, so the whole list goes each time - including an empty one, which is how
 * the last mark in a file is taken away. Without this a breakpoint added after
 * the session started is drawn in the gutter and honoured by nothing, and one
 * removed still stops.
 */
export async function updateBreakpoints(path, lines) {
  if (client === null || path === null) {
    return;
  }
  await setBreakpoints(client, path, lines);
}

/** Evaluate an expression in the frame the user is looking at. */
export async function evaluate(expression) {
  if (client === null) {
    return { success: false, output: "Not debugging." };
  }
  const frameId = stoppedAt?.frame?.id;
  const reply = await client.request("evaluate", {
    expression,
    // Without a frame the adapter evaluates in the global scope of the paused
    // thread, which is the right answer when execution is between frames.
    ...(frameId === undefined ? {} : { frameId }),
    context: "repl",
  });
  return {
    success: reply?.success === true,
    output: reply?.body?.result ?? reply?.message ?? "",
  };
}

/** The scopes of the selected frame, for the variable pane. */
export async function scopes() {
  const frameId = stoppedAt?.frame?.id;
  if (client === null || frameId === undefined) {
    return [];
  }
  const reply = await client.request("scopes", { frameId });
  return reply?.body?.scopes ?? [];
}

/** One level of variables, by the reference a scope or a variable gave. */
export async function variables(reference) {
  if (client === null) {
    return [];
  }
  const reply = await client.request("variables", { variablesReference: reference });
  return reply?.body?.variables ?? [];
}

/**
 * Stop and start again on the same file.
 *
 * The breakpoints are re-read rather than reused: the point of restarting is
 * usually that they have been moved since, and a restart that honoured the old
 * ones would be the one thing somebody did not ask for.
 */
export async function restart(files) {
  const previous = target;
  if (previous === null) {
    return;
  }
  await stop();
  await start(previous.path, files ?? previous.files, previous.options);
}

/** End the session. Safe to call when there is none. */
export async function stop() {
  if (!running) {
    return;
  }
  running = false;
  stoppedAt = null;
  if (client !== null) {
    client.close();
    client = null;
  }
  try {
    ipc.send("debug.stop");
  } catch (error) {
    log.warn("Could not stop the debug session:", error);
  }
  announce();
}

const outputWatchers = new Set();

/** Put a line in the debug console, wherever it came from. */
function announceOutput(text) {
  for (const watcher of outputWatchers) {
    try {
      watcher(text);
    } catch (error) {
      log.error("Debug output watcher failed:", error);
    }
  }
}

/** Subscribe to what the debugged process prints. */
export function onDebugOutput(watcher) {
  outputWatchers.add(watcher);
  return () => outputWatchers.delete(watcher);
}

/** Wire the session to the sidecar. Called once, at startup. */
export function initDebug() {
  ipc.on("debug.message", (frame) => {
    if (client !== null) {
      client.handle(frame.message);
    }
  });

  ipc.on("debug.output", (frame) => announceOutput(frame.text ?? ""));

  // The process is gone, however it went - ran to the end, raised, or was
  // killed. The frontend cannot tell those apart from the socket falling
  // silent, which is why the sidecar says so explicitly.
  ipc.on("debug.exited", () => void stop());

  // A backend that dies takes the debuggee with it, and the session state has
  // to follow or the tab strip keeps offering to step through nothing.
  ipc.on("sidecar.restarting", () => void stop());

  ipc.on("sidecar.disconnected", () => void stop());
}

/** The breakpoint store, re-exported so callers need one import for debugging. */
export { breakpoints };
