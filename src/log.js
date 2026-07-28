import { filesystem } from "@neutralinojs/lib";

import { appDataDir } from "./bootstrap/envroot.js";

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

const FILE_NAME = "build123d-studio.log";
// Dropped at startup past this, so a long-lived install does not accumulate an
// unbounded file. Rotation would be more machinery than the problem deserves:
// what has ever been useful is the current session and the one before it.
const MAX_BYTES = 1024 * 1024;

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
  pending = pending.then(() => filesystem.appendFile(path, line)).catch(() => {
    // Logging must never break the caller, and a failure here has nowhere left
    // to be reported anyway.
  });
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
  return `${new Date().toISOString()} ${level} ${text}\n`;
}

/** Resolve the log path and flush everything buffered before now. */
export async function initLog() {
  const resolved = `${await appDataDir()}/${FILE_NAME}`;

  let previous = "";
  try {
    const stats = await filesystem.getStats(resolved);
    if (stats.size <= MAX_BYTES) {
      previous = await filesystem.readFile(resolved);
    }
  } catch {
    // No log yet.
  }

  const flush = buffered.join("");
  buffered = [];
  // One write rather than truncate-then-append, so the file is never briefly
  // empty and a crash during startup cannot lose the lines explaining it.
  await filesystem.writeFile(resolved, `${previous}${flush}`);
  path = resolved;
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
}
