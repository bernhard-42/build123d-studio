import { filesystem } from "@neutralinojs/lib";

import { appDataDir } from "./bootstrap/envroot.js";
import { append, rotate } from "./logfile.js";
import { emit, repeater } from "./logrepeat.js";

// The webview has no visible console when the app runs outside a dev browser,
// so anything worth diagnosing goes to a file.
//
// Not Neutralino's own debug.log: that appends to neutralinojs.log *inside the
// application's directory*, which a read-only installation cannot have. The log
// lives beside the environment instead, where it is also somewhere a user can
// be pointed at.
//
// Logging starts before the app-data directory has been resolved - the first
// line is written during module initialisation - so lines are buffered until
// initLog() supplies the path.
//
// Append-only, and every line names the instance that wrote it. Both matter
// because more than one instance can run at once. initLog used to read the
// whole file and write it back with the new lines appended, which meant two
// instances starting near each other each kept their own copy and whichever
// wrote last silently discarded the other's - so the file misrepresented what
// happened at exactly the moment something interesting was happening. Measured
// on one machine: of fifteen launches, four looked broken in the log and only
// one actually was; the rest were lines another instance had removed. That is
// worse than a missing log, because it is a log that lies.

const FILE_NAME = "build123d-studio.log";

// The browser's own output goes beside it rather than into it. What this
// application says about itself is a narrative - the kernel started, a model
// rendered, uv resolved this - and it is what a user is asked for; the console
// is a firehose the moment anything is turned up past errors. Mixing them costs
// the narrative, and it costs it exactly when something is being reproduced.
const CONSOLE_FILE_NAME = "console.log";

// And the measurement backend's own, for the same reason again. It runs in a
// process of its own - it must never start a thread, because importing OCP
// holds the Windows loader lock - and what it says is a different subject from
// what the application is doing: which shape id was clicked, what it indexed,
// why a measurement could not be taken. In OCP CAD Viewer that stream is a
// terminal the user can watch; here it is a file.
const BACKEND_FILE_NAME = "backend.log";

// Rotated at every start, and rotated rather than truncated.
//
// Truncating cannot be made safe when two instances share a file, and a rename
// keeps the session that was interesting instead of deleting it. Rotating on
// *start* is what stops these accumulating for ever: three files appended to by
// every session leaves what happened this time buried under months of previous
// ones, and gigabytes of it. Each file now holds this session, and `.1` holds
// the last - which is what a report after a crash needs. Nothing older is worth
// keeping.
//
// A second instance started while the first is running keeps writing into the
// file it already opened, which is now named `.1`: it loses nothing and its
// lines stay together. That is the price of bounding the growth, and it is
// smaller than a log that is mostly history.
const ROTATE_ON_START = 0;

/**
 * Which instance wrote a line.
 *
 * Two instances append to one file, so without this an interleaved log cannot
 * be read at all: the timestamps alone put lines in an order no single process
 * ever saw. Eight hex characters is enough to tell a handful of concurrent
 * windows apart and short enough not to crowd the line.
 *
 * Generated from getRandomValues rather than crypto.randomUUID, which needs a
 * secure context. Phase 4's per-instance directory wants an identity too, and
 * it should be this one.
 */
export const instanceId = Array.from(crypto.getRandomValues(new Uint8Array(4)))
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

let path = null;
let buffered = [];
let consoleFilePath = null;
let consoleBuffered = [];
let backendFilePath = null;
let backendBuffered = [];
// Serialised, like the settings store: appends fired in parallel interleave
// mid-line.
let pending = Promise.resolve();

// Whoever wants to show the log as it happens. The Backend tab does: to a user
// there is no difference between the sidecar, the measurement process and this
// window - it is all "the machinery" - so one pane carries what any of them has
// to say, and this is the single point they all already pass through.
//
// A callback rather than a DOM write here, because this module must stay
// importable by everything, including code with no window at all.
const watchers = new Set();

/** Watch every line as it is written. Returns a function that stops watching. */
export function onLine(watcher) {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

const streams = { app: repeater(), console: repeater(), backend: repeater() };

function notify(entry) {
  for (const watcher of watchers) {
    try {
      watcher(entry.line, entry.key);
    } catch {
      // A watcher that throws must not cost the log its line.
    }
  }
}

function write(entry) {
  notify(entry);
  emit(streams.app, entry, (text) => {
    if (path === null) {
      buffered.push(text);
      return;
    }
    appendToApp(text);
  });
}

function appendToApp(text) {
  // Serialised within this process so two appends cannot interleave mid-line.
  // Across processes that is the operating system's job, and append is the only
  // operation for which it does it - see logfile.js.
  pending = pending.then(() => append(filesystem, path, text));
}

function format(level, parts) {
  const text = parts
    .map((part) => {
      if (part instanceof Error) {
        return `${part.message}\n${part.stack ?? ""}`;
      }
      if (typeof part === "object" && part !== null) {
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      }
      return String(part);
    })
    .join(" ");
  return { line: `${new Date().toISOString()} ${instanceId} ${level} ${text}`, key: `${level} ${text}` };
}



/** The console mirror, which is a second file with the same rules. */
function writeConsole(entry) {
  emit(streams.console, entry, (text) => {
    if (consoleFilePath === null) {
      consoleBuffered.push(text);
      return;
    }
    pending = pending.then(() => append(filesystem, consoleFilePath, text));
  });
}

/** The measurement backend's own stream, which is a third file, same rules. */
function writeBackend(entry) {
  emit(streams.backend, entry, (text) => {
    if (backendFilePath === null) {
      backendBuffered.push(text);
      return;
    }
    pending = pending.then(() => append(filesystem, backendFilePath, text));
  });
}

/**
 * One line from the measurement backend, as it printed it.
 *
 * Two destinations, and they answer different questions: its own file, which is
 * what a report attaches when measurements are the subject, and the watchers -
 * the Backend tab - where it appears beside everything else the machinery said,
 * because on screen a user is not sorting output by which process produced it.
 */
export function backend(...parts) {
  notify(format("INFO", ["measurement:", ...parts]));
  writeBackend(format("INFO", parts));
}

/** Resolve every path and flush everything buffered before now. */
export async function initLog() {
  const directory = await appDataDir();
  const resolved = `${directory}/${FILE_NAME}`;
  const resolvedConsole = `${directory}/${CONSOLE_FILE_NAME}`;
  const resolvedBackend = `${directory}/${BACKEND_FILE_NAME}`;
  // ROTATE_ON_START rather than MAX_BYTES: every start begins each file anew,
  // with the previous session kept beside it as `.1`.
  await rotate(filesystem, resolved, ROTATE_ON_START);
  await rotate(filesystem, resolvedConsole, ROTATE_ON_START);
  await rotate(filesystem, resolvedBackend, ROTATE_ON_START);

  // Appended, never rewritten. This is the whole fix: a process only ever adds
  // its own lines, so it cannot remove anybody else's.
  const flush = buffered.join("");
  buffered = [];
  path = resolved;
  await append(filesystem, resolved, flush);

  const flushConsole = consoleBuffered.join("");
  consoleBuffered = [];
  consoleFilePath = resolvedConsole;
  await append(filesystem, resolvedConsole, flushConsole);

  const flushBackend = backendBuffered.join("");
  backendBuffered = [];
  backendFilePath = resolvedBackend;
  await append(filesystem, resolvedBackend, flushBackend);
  return resolved;
}

/** Where the log is, for the info dialog. Null before initLog() has run. */
export function logPath() {
  return path;
}

/** Where the console mirror is. Null before initLog() has run. */
export function consolePath() {
  return consoleFilePath;
}

/** Where the measurement backend's log is. Null before initLog() has run. */
export function backendPath() {
  return backendFilePath;
}

// The console's own methods, kept before anything wraps them. Everything here
// prints through these rather than through `console`, so mirroring the console
// into the log cannot become a loop.
const console_ = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export function info(...parts) {
  console_.log(...parts);
  write(format("INFO", parts));
}

export function warn(...parts) {
  console_.warn(...parts);
  write(format("WARNING", parts));
}

export function error(...parts) {
  console_.error(...parts);
  write(format("ERROR", parts));
}

/**
 * Send what the libraries print to the log as well as to the console.
 *
 * There is no developer console to read on macOS, and there never will be with
 * this toolkit: Safari lists a WKWebView only when its `isInspectable` is set,
 * which macOS has required since 13.3, and that symbol appears in no
 * Neutralino release. So the log file *is* the console - for support, and for
 * this application's own developers.
 *
 * It matters because the interesting messages are the ones nobody here wrote.
 * three-cad-viewer and three.js report a malformed model, a NaN bounding
 * sphere or a dropped option through `console.error`, and until now every one
 * of those was written to a console with no reader.
 *
 * The originals are called first and unchanged, so a console that *is* being
 * watched behaves exactly as before.
 */
// How much of the browser console reaches the log, chosen in Settings. Errors
// only by default: those are what a fault report needs, and a library that
// chatters on `console.log` would otherwise evict them - the file rotates at a
// megabyte with a single backup, so noise costs signal rather than space.
//
// It governs the *mirror* and nothing else. What this application logs itself -
// the kernel's lifecycle, a model rendered, uv's output - is written whatever
// this says, because that is the half a user is asked for.
const CONSOLE_LEVELS = ["off", "error", "warning", "everything"];
const MIRRORED = {
  error: ["error"],
  warning: ["error", "warn"],
  everything: ["error", "warn", "log", "info", "debug"],
};
const AS_LEVEL = { error: "ERROR", warn: "WARNING", log: "INFO", info: "INFO", debug: "DEBUG" };

let mirrored = "error";

/** The levels a person can choose between, for the Settings dialog. */
export function consoleLevels() {
  return [...CONSOLE_LEVELS];
}

/** How much of the console is being mirrored. */
export function consoleLevel() {
  return mirrored;
}

/**
 * Change how much of the console is mirrored, now rather than at the next start.
 *
 * Every level is wrapped once at startup and the wrapper consults this, so a
 * change takes effect immediately and turning it back off leaves nothing
 * wrapped twice - which is what a second call to `mirrorConsole` would do.
 */
export function setConsoleLevel(level) {
  mirrored = CONSOLE_LEVELS.includes(level) ? level : "error";
  return mirrored;
}

function mirrorConsole() {
  for (const method of ["error", "warn", "log", "info", "debug"]) {
    const original = console_[method] ?? console[method].bind(console);
    console[method] = (...parts) => {
      original(...parts);
      if (MIRRORED[mirrored]?.includes(method)) {
        writeConsole(format(AS_LEVEL[method], [`console.${method}:`, ...parts]));
      }
    };
  }
}

/** Route uncaught errors and rejected promises to the log too. */
export function installGlobalHandlers() {
  mirrorConsole();
  window.addEventListener("error", (event) => {
    error("Uncaught error:", event.message, event.filename, event.lineno, event.error);
  });
  window.addEventListener("unhandledrejection", (event) => {
    error("Unhandled rejection:", event.reason);
  });

  // A Content-Security-Policy that is too tight does not announce itself: the
  // blocked worker, stylesheet or connection simply never happens, and the pane
  // that needed it looks broken for no stated reason. Logging violations turns
  // that into a line naming the directive and the URL that tripped it - the
  // difference between "the viewer is blank" and "worker-src blocked
  // blob:...". Worth keeping after the policy settles, because the next
  // dependency upgrade can introduce one.
  window.addEventListener("securitypolicyviolation", (event) => {
    error(
      "CSP violation:",
      `${event.violatedDirective} blocked ${event.blockedURI || "(inline)"}`,
      `in ${event.sourceFile ?? "?"}:${event.lineNumber ?? "?"}`,
    );
  });
}
