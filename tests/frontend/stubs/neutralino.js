/** The native half of the application, in memory.
 *
 * Aliased over `@neutralinojs/lib` by vite.config.test.js, so every module that
 * imports it - twelve of them, and everything they pull in - loads and runs
 * unchanged. Nothing about the application is mocked: the real main.js boots,
 * the real Monaco is constructed, the real stylesheet is applied by the real
 * engine. Only the boundary the browser genuinely cannot cross is faked.
 *
 * That boundary is small and knowable. The application uses about thirty of
 * Neutralino's functions and they are enumerated below; anything it grows later
 * lands here as an explicit "not stubbed" failure rather than as undefined,
 * because a native call that silently answers undefined is how a harness comes
 * to certify a path it never ran.
 *
 * The filesystem is a Map of absolute paths. It is deliberately not a real one:
 * a test that has to clean up after itself eventually does not, and a suite
 * that shares a directory between cases fails in an order-dependent way that
 * nobody can reproduce from the report.
 */

/** Every call that crossed the boundary, in order, for a test to assert on. */
export const calls = [];

/** Paths to contents. Directories are the entries of `dirs`. */
const files = new Map();
// When each file was last written. A real stat carries one and the
// changed-on-disk check compares it, so a stub without one would quietly
// exercise only the degraded, size-only half of that check. Counted rather
// than clocked, so a test never depends on how fast it runs.
const times = new Map();
let tick = 1;
const dirs = new Set(["/"]);

/** Where the harness is told to answer a dialog from, one answer per call. */
const dialogAnswers = [];

// How long a native focus call takes; see window.focus below.
let focusDelayMs = 0;

// What this window's own process looks like to `ps`, and which other pids a
// test says are windows of this application too. Recovery asks the operating
// system which pids are live rather than reading a clock, so this is where a
// test says "that journal belongs to somebody who is still running".
const APP_PATH = "/Applications/build123d Studio.app/Contents/MacOS/build123d-studio";
const alsoRunning = new Set(
  (globalThis.__HARNESS_PROCESSES__?.running ?? []).map(Number),
);
let processListingWorks = globalThis.__HARNESS_PROCESSES__?.brokenListing !== true;
let trashBroken = globalThis.__HARNESS_PROCESSES__?.trashFails === true;

/** Exit codes queued for the next spawned commands. */
const exitCodes = [];

let spawnCounter = 0;

function record(name, args) {
  calls.push({ name, args });
}

function parent(path) {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function ensureParents(path) {
  let at = parent(path);
  while (at !== "/" && !dirs.has(at)) {
    dirs.add(at);
    at = parent(at);
  }
}

/** Neutralino rejects with an object carrying a `code`; callers switch on it. */
function missing(path) {
  const error = new Error(`NE_FS_NOPATHE: ${path}`);
  error.code = "NE_FS_NOPATHE";
  throw error;
}

// --- what a test drives it with -------------------------------------------

/** Seed a file before the application starts. */
export function given(path, contents) {
  ensureParents(path);
  files.set(path, contents);
  times.set(path, ++tick);
}

/** Seed a directory. */
export function givenDirectory(path) {
  ensureParents(path);
  dirs.add(path);
}

/** What the application wrote. */
export function wrote(path) {
  return files.get(path);
}

/** Answer the next dialog with this, rather than with a cancel. */
export function focusDelay(ms) {
  focusDelayMs = ms;
}

export function answerDialogWith(value) {
  dialogAnswers.push(value);
}

/** Make the next spawned command exit with this code rather than with 0. */
export function exitNextSpawnWith(code) {
  exitCodes.push(code);
}

// The bridge a test drives this from. Playwright runs in node and the stub runs
// in the page, so everything a test wants to seed or read has to cross through
// page.evaluate - which needs a name on the window rather than a module export.
globalThis.__NEUTRALINO_STUB__ = {
  given: (path, contents) => given(path, contents),
  givenDirectory: (path) => givenDirectory(path),
  wrote: (path) => wrote(path),
  // Every path written or seeded, for a test that has to wait for a write it
  // cannot name - the recovery journal's directory carries a random instance
  // id, and waiting for the wrong thing is how a test comes to pass against
  // the bug it was written for.
  paths: () => [...files.keys()],
  answerDialogWith: (value) => answerDialogWith(value),
  focusDelay: (ms) => focusDelay(ms),
  exitNextSpawnWith: (code) => exitNextSpawnWith(code),
  emit: (name, detail) => emit(name, detail),
  // Stop answering, the way a half-open socket does.
  goSilent: () => goSilent(),
  // Deleting from outside the application, which is what a terminal does and
  // what left the tree remembering folders that were gone.
  removePath: (path) => {
    files.delete(path);
    dirs.delete(path);
    for (const key of [...files.keys()]) {
      if (key.startsWith(`${path}/`)) {
        files.delete(key);
      }
    }
    for (const key of [...dirs]) {
      if (key.startsWith(`${path}/`)) {
        dirs.delete(key);
      }
    }
  },
  // Set a file's modification time directly. The clock here is a counter so
  // that no test depends on how fast it runs, which leaves no way to say "this
  // was written recently" - and the recovery journal's whole liveness test is
  // exactly that. A window still beating must never have its unsaved work
  // offered to somebody else.
  touch: (path, modifiedAt) => times.set(path, modifiedAt),
  // Say that a pid is a running window of this application, so the journal it
  // owns must be left alone. Without this every recorded owner is dead, which
  // is what a crashed session's is.
  alsoRunning: (pid) => alsoRunning.add(Number(pid)),
  // Make the process listing fail, which is the one case where the application
  // cannot know whether a journal is live - and must therefore offer it without
  // deleting it.
  breakProcessListing: () => { processListingWorks = false; },
  // No trash on this volume, which is the second question's case.
  trashFails: () => { trashBroken = true; },
  calls: () => calls.map((call) => ({ ...call })),
  reset: () => reset(),
};

// What the harness seeded before the page loaded. Read at module scope rather
// than through a call, because store.js and log.js read the filesystem during
// main()'s first two lines and there is nowhere earlier for a test to reach.
for (const [path, contents] of Object.entries(globalThis.__HARNESS_FILES__ ?? {})) {
  ensureParents(path);
  files.set(path, contents);
  times.set(path, ++tick);
}
// After the seeding, so a test's own time wins over the counter.
for (const [path, modifiedAt] of Object.entries(globalThis.__HARNESS_TIMES__ ?? {})) {
  times.set(path, modifiedAt);
}
if (globalThis.__HARNESS_SETTINGS__ != null) {
  ensureParents("/appdata/build123d-studio/settings.json");
  files.set(
    "/appdata/build123d-studio/settings.json",
    JSON.stringify(globalThis.__HARNESS_SETTINGS__),
  );
}

/** Forget everything, so one test cannot reach another. */
export function reset() {
  calls.length = 0;
  files.clear();
  times.clear();
  tick = 1;
  dirs.clear();
  dirs.add("/");
  dialogAnswers.length = 0;
  focusDelayMs = 0;
  alsoRunning.clear();
  processListingWorks = true;
  trashBroken = false;
  listeners.clear();
}

// --- events ----------------------------------------------------------------

const listeners = new Map();

export const events = {
  on(name, handler) {
    if (!listeners.has(name)) {
      listeners.set(name, new Set());
    }
    listeners.get(name).add(handler);
    return Promise.resolve();
  },
};

/** Deliver a native event, which is how a spawned process reports output. */
export function emit(name, detail) {
  for (const handler of listeners.get(name) ?? []) {
    handler({ detail });
  }
}

// --- filesystem ------------------------------------------------------------

let watcherId = 0;

export const filesystem = {
  async readFile(path) {
    record("readFile", [path]);
    if (!files.has(path)) {
      missing(path);
    }
    return files.get(path);
  },

  // Honours { pos, size }, because the application uses it to look at the front
  // of a file without reading the rest - and a stub that quietly returned the
  // whole thing would let a guard that reads too much pass.
  async readBinaryFile(path, options = null) {
    record("readBinaryFile", [path, options]);
    if (!files.has(path)) {
      missing(path);
    }
    const contents = files.get(path);
    const bytes = typeof contents === "string"
      ? new TextEncoder().encode(contents).buffer
      : contents;
    if (options === null) {
      return bytes;
    }
    const pos = options.pos ?? 0;
    return bytes.slice(pos, pos + (options.size ?? bytes.byteLength - pos));
  },

  // Watching a folder. Recorded rather than simulated - there is no filesystem
  // here to change behind the application's back - and a test drives the change
  // itself: seed the file, then emit the event the platform would have.
  async createWatcher(path) {
    record("createWatcher", [path]);
    watcherId += 1;
    return watcherId;
  },

  async removeWatcher(id) {
    record("removeWatcher", [id]);
    return true;
  },

  async writeFile(path, contents) {
    record("writeFile", [path, contents]);
    ensureParents(path);
    files.set(path, contents);
    times.set(path, ++tick);
  },

  async appendFile(path, contents) {
    record("appendFile", [path, contents]);
    ensureParents(path);
    files.set(path, (files.get(path) ?? "") + contents);
  },

  async remove(path) {
    record("remove", [path]);
    // Recursive, as the real one is: Neutralino removes a directory with its
    // contents, and this application already relies on that - bootstrap/uv.js
    // removes its whole download directory on every exit path, on all three
    // platforms. A stub that removed only an exact name made clearing the
    // recovery journal look like it worked while leaving every copy behind.
    files.delete(path);
    dirs.delete(path);
    times.delete(path);
    const prefix = `${path}/`;
    for (const key of [...files.keys()]) {
      if (key.startsWith(prefix)) {
        files.delete(key);
        times.delete(key);
      }
    }
    for (const key of [...dirs]) {
      if (key.startsWith(prefix)) {
        dirs.delete(key);
      }
    }
  },

  async move(from, to) {
    record("move", [from, to]);
    if (!files.has(from)) {
      missing(from);
    }
    ensureParents(to);
    files.set(to, files.get(from));
    // The destination is newly written as far as anyone looking at it is
    // concerned, which is what an atomic save is: every save lands through here.
    times.set(to, ++tick);
    files.delete(from);
    times.delete(from);
  },

  async createDirectory(path) {
    record("createDirectory", [path]);
    ensureParents(path);
    dirs.add(path);
  },

  async getStats(path) {
    record("getStats", [path]);
    if (dirs.has(path)) {
      return { isFile: false, isDirectory: true, size: 0, createdAt: 1, modifiedAt: 1 };
    }
    if (!files.has(path)) {
      missing(path);
    }
    const contents = files.get(path);
    return {
      isFile: true,
      isDirectory: false,
      createdAt: 1,
      modifiedAt: times.get(path) ?? 1,
      // Bytes, as the real one reports, rather than the string's length - the
      // two differ the moment a file has a character outside ASCII in it, and a
      // size threshold measured in the wrong unit is a threshold in the wrong
      // place.
      size: typeof contents === "string"
        ? new TextEncoder().encode(contents).byteLength
        : contents.byteLength,
    };
  },

  // Returns { entry, type } and no path field - the real one does not have one
  // either, which is why the sidebar joins children by hand.
  async readDirectory(path) {
    record("readDirectory", [path]);
    if (!dirs.has(path)) {
      missing(path);
    }
    const prefix = path === "/" ? "/" : `${path}/`;
    const seen = new Map();
    for (const each of [...files.keys(), ...dirs]) {
      if (each === path || !each.startsWith(prefix)) {
        continue;
      }
      const rest = each.slice(prefix.length);
      const name = rest.split("/")[0];
      const isDirectory = rest.includes("/") || dirs.has(prefix + name);
      seen.set(name, isDirectory ? "DIRECTORY" : "FILE");
    }
    return [...seen].map(([entry, type]) => ({ entry, type }));
  },

  async getJoinedPath(...parts) {
    return parts.join("/").replace(/\/+/g, "/");
  },

  async getNormalizedPath(path) {
    return path.replace(/\/+/g, "/");
  },

  async getAbsolutePath(path) {
    return path.startsWith("/") ? path : `/${path}`;
  },

  async getPathParts(path) {
    return {
      parentPath: parent(path),
      filename: path.slice(path.lastIndexOf("/") + 1),
      extension: path.includes(".") ? path.slice(path.lastIndexOf(".")) : "",
    };
  },

  async getPermissions(path) {
    if (!files.has(path) && !dirs.has(path)) {
      missing(path);
    }
    return { all: { read: true, write: true, execute: false } };
  },

  async setPermissions() {},
};

// --- os --------------------------------------------------------------------

const paths = {
  data: "/appdata",
  documents: "/documents",
  temp: "/tmp",
  config: "/config",
};

export const os = {
  async getPath(name) {
    record("getPath", [name]);
    return paths[name] ?? "/appdata";
  },

  /**
   * The system trash, which is where a delete goes.
   *
   * It removes the file here rather than only recording the call: a test that
   * asserted on the call alone would pass against an application that trashed
   * the wrong path, or trashed one file and left another.
   *
   * Made to fail with trashFails(), because the application asks a second
   * question when there is no trash to move something to, and that branch has
   * to be reachable.
   */
  async trashItem(path) {
    record("trashItem", [path]);
    if (trashBroken) {
      const error = new Error(`NE_OS_TRASHER: ${path}`);
      error.code = "NE_OS_TRASHER";
      throw error;
    }
    if (!files.has(path) && !dirs.has(path)) {
      missing(path);
    }
    files.delete(path);
    dirs.delete(path);
    return "OK";
  },

  async getEnv(name) {
    return globalThis.__HARNESS__?.env?.[name] ?? "";
  },

  async setEnv() {},

  async showMessageBox(title, detail, choices, kind) {
    record("showMessageBox", [title, detail, choices, kind]);
    return dialogAnswers.length > 0 ? dialogAnswers.shift() : "OK";
  },

  async showOpenDialog(title, options) {
    record("showOpenDialog", [title, options]);
    return dialogAnswers.length > 0 ? dialogAnswers.shift() : [];
  },

  async showSaveDialog(title, options) {
    record("showSaveDialog", [title, options]);
    return dialogAnswers.length > 0 ? dialogAnswers.shift() : "";
  },

  /**
   * The save panel on macOS, which is a script rather than a dialog call.
   *
   * Neutralino's own save dialog puts the whole `defaultPath` into AppleScript's
   * `default name`, so a Save As opened asking whether to save a file called
   * "/Users/.../notes.py". The application runs its own `choose file name`
   * instead - see src/savedialog.js - and on this platform that is the path
   * every Save As takes.
   *
   * Answered from the same queue as showSaveDialog, and with the same meaning
   * for an empty one: `choose file name` reports a cancel by raising, and the
   * script turns that into an empty line. So a test queues a path exactly as it
   * did before and does not have to know which platform it is on.
   *
   * Anything else is refused rather than answered with a plausible success. The
   * application runs no other command through execCommand, and a stub that
   * cheerfully returns exit code 0 for one it has never heard of is how a
   * command that was never really run comes to look like it worked.
   */
  async execCommand(command, options) {
    record("execCommand", [command, options]);

    // The process listing recovery asks for, to find out which pids are windows
    // of this application. Answered with this window plus whatever a test says
    // is also running - see liveProcesses() - because a journal's owner being
    // in that list is the whole of what decides between "offer this back" and
    // "somebody is typing in it".
    //
    // The shape is real output: `ps -A -o pid=,comm=` prints the full path on
    // macOS, and a name truncated to fifteen characters on Linux.
    if (command.startsWith("ps -A")) {
      if (!processListingWorks) {
        return { pid: 0, stdOut: "", stdErr: "ps: cannot fetch process table", exitCode: 1 };
      }
      const rows = [`    1 /sbin/launchd`, `${NL_PID} ${APP_PATH}`];
      for (const pid of alsoRunning) {
        rows.push(`${pid} ${APP_PATH}`);
      }
      return { pid: 0, stdOut: `${rows.join("\n")}\n`, stdErr: "", exitCode: 0 };
    }

    if (!command.startsWith("osascript ") || !command.includes("choose file name")) {
      return { pid: 0, stdOut: "", stdErr: `unexpected command: ${command}`, exitCode: 127 };
    }
    const answer = dialogAnswers.length > 0 ? dialogAnswers.shift() : "";
    return { pid: 0, stdOut: `${typeof answer === "string" ? answer : ""}\n`, stdErr: "", exitCode: 0 };
  },

  // Cancel is undocumented, and the application treats anything that is not a
  // non-empty string as one. Answered the same way here so a test cannot come
  // to depend on a shape the real dialog never produces.
  async showFolderDialog(title) {
    record("showFolderDialog", [title]);
    return dialogAnswers.length > 0 ? dialogAnswers.shift() : undefined;
  },

  /** The one call whose answer has to come from outside the browser.
   *
   * The application spawns the sidecar and waits for a handshake line on its
   * stdout. The harness runs a real sidecar-shaped WebSocket server in node and
   * puts its port on __HARNESS__, so what is faked here is the process, not the
   * link: everything after the handshake is the real ipc.js talking to a real
   * socket over the real frame protocol.
   */
  async spawnProcess(command) {
    record("spawnProcess", [command]);
    const id = ++spawnCounter;
    const sidecar = globalThis.__HARNESS__?.sidecar;
    if (sidecar === undefined || !command.includes("sidecar/main.py")) {
      // Everything that is not the sidecar is a short-lived command the
      // application waits for - `git --version` is one, and Settings will not
      // open until it has answered. A stub that spawns and never exits leaves
      // that await outstanding for ever, which looks like a dialog that simply
      // does not open and reports nothing at all.
      //
      // Answered as success by default; a test that needs a failure queues an
      // exit code with exitNextSpawnWith().
      const code = exitCodes.length > 0 ? exitCodes.shift() : 0;
      setTimeout(() => emit("spawnedProcess", { id, action: "exit", data: code }), 0);
      return { id, pid: 1000 + id };
    }
    if (sidecar !== undefined && command.includes("sidecar/main.py")) {
      // A macrotask, not a microtask, and the difference is load-bearing.
      // proc.js registers its output handler *after* awaiting this call, so a
      // microtask would deliver the handshake line to a Map that does not have
      // the id in it yet and startup would wait out its full thirty seconds.
      // Everything from the await to handlers.set is synchronous, so yielding
      // one macrotask is enough to be behind it without guessing at a delay.
      setTimeout(() => {
        emit("spawnedProcess", {
          id,
          action: "stdOut",
          data: `${JSON.stringify(sidecar)}\n`,
        });
      }, 0);
    }
    return { id, pid: 1000 + id };
  },

  async updateSpawnedProcess(id, action) {
    record("updateSpawnedProcess", [id, action]);
  },
};

// --- clipboard, window, app ------------------------------------------------

let clipboardText = "";

export const clipboard = {
  async readText() {
    record("clipboard.readText", []);
    return clipboardText;
  },
  async writeText(text) {
    record("clipboard.writeText", [text]);
    clipboardText = text;
  },
};

// The window's geometry, as the real one would report it. Held here rather than
// answered with constants so that a test can watch the application put the
// window back where it was - which is the whole point of remembering it.
const geometry = { width: 1600, height: 1000, x: 40, y: 60, maximized: false };

export const window = {
  async getSize() {
    record("getSize", []);
    return { width: geometry.width, height: geometry.height };
  },
  async setSize(options) {
    record("setSize", [options]);
    Object.assign(geometry, options);
  },
  async getPosition() {
    record("getPosition", []);
    return { x: geometry.x, y: geometry.y };
  },
  async move(x, y) {
    record("move", [x, y]);
    geometry.x = x;
    geometry.y = y;
  },
  async isMaximized() {
    record("isMaximized", []);
    return geometry.maximized;
  },
  async maximize() {
    record("maximize", []);
    geometry.maximized = true;
  },
  async setTitle(title) {
    record("setTitle", [title]);
    document.title = title;
  },
  async show() {
    record("show", []);
  },

  // Which window the operating system has in front. Recorded rather than
  // simulated - there is no window here - but recorded is what answers the
  // question that matters: whether the keyboard was asked for back after a
  // native dialog took it.
  async focus() {
    record("focus", []);
    // A real one is a call into the native side and takes milliseconds. Here it
    // resolved in the same microtask, which hid a bug: afterNativeDialog is
    // fire-and-forget, so what follows it - moving the caret back into the
    // editor - lands *during* whatever the caller went on to do. With an
    // instant focus it landed before instead, and a save that formats was
    // never raced the way the real one is. See focusDelay().
    if (focusDelayMs > 0) {
      await new Promise((done) => setTimeout(done, focusDelayMs));
    }
  },
  async hide() {
    record("hide", []);
  },

  // A second window, which the application uses for one thing only: taking the
  // foreground away from itself and giving it back. Recorded, because what
  // matters is that it was asked for and that the window asked for is one the
  // operating system would actually activate.
  async create(url, options) {
    record("create", [url, options]);
    return { pid: 4242 };
  },
  // The menu is a pure function of state and menu.js already tests what it
  // builds; what matters here is that it was set, and with what.
  async setMainMenu(menu) {
    record("setMainMenu", [menu]);
  },

  // What the in-window title bar needs. Recorded rather than simulated - there
  // is no frame in a browser to remove and no window to drag - but recorded is
  // enough to answer the questions that matter: whether the frame was given up
  // on the platforms that draw their own bar, and never on macOS.
  async setBorderless(on) {
    record("setBorderless", [on]);
  },
  async setDraggableRegion(target) {
    record("setDraggableRegion", [typeof target === "string" ? target : "(element)"]);
  },
  async unmaximize() {
    record("unmaximize", []);
    geometry.maximized = false;
  },
  async minimize() {
    record("minimize", []);
  },
};

// One screen, at the origin. A test that cares about a position on a monitor
// that is no longer attached drives geometry.js directly, where the decision
// lives and where it needs no browser.
export const computer = {
  async getDisplays() {
    record("getDisplays", []);
    return [{ id: 1, x: 0, y: 0, width: 1920, height: 1200 }];
  },
};

// A half-open socket, which is what a Windows resume leaves behind: the page
// believes it is connected and every call disappears into it, unanswered and
// unrejected. Nothing else in this stub can express that - a refusal would be
// an answer - and without it the watch that notices could not be tested at all.
let silent = false;

export function goSilent() {
  silent = true;
}

/** Never settles. What a queued native call does when the link is gone. */
function swallowed() {
  return new Promise(() => {});
}

export const app = {
  async getConfig() {
    record("getConfig", []);
    if (silent) {
      return swallowed();
    }
    return { applicationId: "dev.build123dstudio.app" };
  },
  async exit(code) {
    record("exit", [code]);
    if (silent) {
      return swallowed();
    }
  },
  async quit() {
    record("quit", []);
  },
};

export function init() {
  record("init", []);
}
