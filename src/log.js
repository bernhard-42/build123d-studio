import { filesystem } from "@neutralinojs/lib";

import { appDataDir } from "./bootstrap/envroot.js";
import { append, rotate } from "./logfile.js";

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

// Rotated rather than truncated past this. The old approach - drop everything
// and start again - cannot be made safe when two instances share the file, and
// a rename keeps the session that was interesting rather than deleting it.
const MAX_BYTES = 1024 * 1024;

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
// Serialised, like the settings store: appends fired in parallel interleave
// mid-line.
let pending = Promise.resolve();

function write(line) {
  if (path === null) {
    buffered.push(line);
    return;
  }
  // Serialised within this process so two appends cannot interleave mid-line.
  // Across processes that is the operating system's job, and append is the only
  // operation for which it does it - see logfile.js.
  pending = pending.then(() => append(filesystem, path, line));
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
  return `${new Date().toISOString()} ${instanceId} ${level} ${text}\n`;
}

/** Resolve the log path and flush everything buffered before now. */
export async function initLog() {
  const resolved = `${await appDataDir()}/${FILE_NAME}`;
  await rotate(filesystem, resolved, MAX_BYTES);

  // Appended, never rewritten. This is the whole fix: a process only ever adds
  // its own lines, so it cannot remove anybody else's.
  const flush = buffered.join("");
  buffered = [];
  path = resolved;
  await append(filesystem, resolved, flush);
  return resolved;
}

/** Where the log is, for the info dialog. Null before initLog() has run. */
export function logPath() {
  return path;
}

export function info(...parts) {
  console.log(...parts);
  write(format("INFO", parts));
}

export function warn(...parts) {
  console.warn(...parts);
  write(format("WARNING", parts));
}

export function error(...parts) {
  console.error(...parts);
  write(format("ERROR", parts));
}

/** Route uncaught errors and rejected promises to the log too. */
export function installGlobalHandlers() {
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
