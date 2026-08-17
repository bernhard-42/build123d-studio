/** Boot the real application in a page, with only the native layer replaced.
 *
 * Three seams, and no more:
 *
 * - `/__neutralino_globals.js`, which the native server injects and a browser
 *   404s. Fulfilled from here rather than committed to public/, because a file
 *   in public/ would be copied into resources/ and shadow the real one in the
 *   packaged application.
 * - `@neutralinojs/lib`, aliased to the in-memory stub at build time.
 * - the sidecar's WebSocket, answered by Playwright's own routing rather than
 *   by a server. The application still opens a real socket and still speaks the
 *   real binary frame protocol - `src/frame.js` encodes both ends, so the two
 *   cannot drift - but there is no process, no port to collide and nothing to
 *   clean up if a test fails half way.
 *
 * What is deliberately *not* faked: main.js, the panes, Monaco, the stylesheet
 * and the layout engine. A harness that replaced any of those would be
 * answering questions about itself.
 */

import { decodeBinary, encodeBinary } from "../../src/frame.js";

/** The handshake line the sidecar prints on stdout, and nothing else uses stdio.
 *
 * `type: "listening"` is not decoration - ipc.js refuses any other shape, which
 * is what stops a stray line of output being read as a port. The port is never
 * bound by anything; Playwright answers the socket without one being opened.
 */
const SIDECAR = { type: "listening", port: 45999, token: "harness-token" };

const GLOBALS = (platform, argv) => `
  var NL_OS = ${JSON.stringify(platform)};
  var NL_ARCH = "arm64";
  // This window's own process. Recovery records it in the journal it owns and
  // asks the operating system which pids are still windows of this
  // application, so the stub's process listing has to contain this one.
  var NL_PID = "4242";
  var NL_ARGS = ${JSON.stringify(argv)};
  var NL_PATH = "/app";
  var NL_CWD = "/app";
  var NL_VERSION = "6.9.0";
  var NL_APPVERSION = "0.0.0-harness";
  var NL_PORT = 0;
  var NL_TOKEN = "unused";
`;

/** The sidecar's end of the link, driven from the test. */
class FakeSidecar {
  constructor() {
    this.received = [];
    // Binary frames are a separate list because they are a separate protocol:
    // console keystrokes leave as KIND_CONSOLE bytes rather than as a JSON
    // frame, so a suite that only recorded text would have quietly concluded
    // that typing in the console sends nothing.
    this.receivedBinary = [];
    this._route = null;
    this._waiters = [];
    this._answers = new Map();
    // Requests an answer() chose not to reply to yet. See the dispatch below.
    this.held = [];
    this._dap = false;
  }

  /** What a real sidecar always answers, so tests need not know it exists.
   *
   * Format on Save is on by default, so *every* save now waits on this frame -
   * and a harness that left it unanswered would make each save test hang for
   * the request's whole timeout and then fail as though saving were broken.
   * `source: null` is what the real sidecar sends for a buffer black would not
   * change, which is the common case and produces no edit at all.
   *
   * A test that cares about formatting overrides it with answer().
   */
  _answerDefaults() {
    if (!this._answers.has("editor.format")) {
      this._answers.set("editor.format", () => ({ source: null }));
    }
  }

  /** Answer every request of a type, the way the sidecar's lanes do.
   *
   * ipc.request() correlates a reply to its request by an `id` it puts in the
   * frame, and a reply without it is dropped as "abandoned by its caller" - so
   * the id has to be echoed. That is the whole contract, and getting it wrong
   * looks exactly like a language feature that is switched off.
   */
  answer(type, build) {
    this._answers.set(type, build);
  }

  /** Answer DAP requests the way a live adapter would.
   *
   * The frontend is the debug client - the sidecar understands no DAP at all -
   * so a pause is not finished when the `stopped` event arrives: it is finished
   * when the stackTrace that follows has been answered. Without that the UI
   * never reaches its paused state and the step buttons stay disabled, which
   * shows up as a click timing out rather than as anything about debugging.
   */
  autoAnswerDap() {
    this._dap = true;
  }

  _answerDap(frame) {
    const request = frame.message;
    const bodies = {
      stackTrace: {
        stackFrames: [
          { id: 1, name: "<module>", line: 3, column: 1, source: { path: "/documents/bracket/part.py" } },
        ],
        totalFrames: 1,
      },
      scopes: { scopes: [{ name: "Locals", variablesReference: 2, expensive: false }] },
      variables: { variables: [] },
      evaluate: { result: "", variablesReference: 0 },
      threads: { threads: [{ id: 1, name: "MainThread" }] },
    };
    this.send("debug.message", {
      message: {
        type: "response",
        request_seq: request.seq,
        seq: request.seq + 1000,
        success: true,
        command: request.command,
        body: bodies[request.command] ?? {},
      },
    });
  }

  _attach(route) {
    this._route = route;
    this._answerDefaults();
    route.onMessage((message) => {
      // Text frames are JSON control messages; binary ones are console bytes
      // and model payloads.
      if (typeof message !== "string") {
        const frame = decodeBinary(
          message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
          () => {},
        );
        if (frame !== null) {
          this.receivedBinary.push(frame);
        }
        return;
      }
      {
        const frame = JSON.parse(message);
        this.received.push(frame);
        const build = this._answers.get(frame.type);
        if (build !== undefined) {
          const reply = build(frame);
          // A builder that answers nothing holds the request open, and the
          // frame is kept so the test can answer it whenever it likes. That is
          // the only way to test what the application does *during* a request:
          // a real sidecar can take as long as it takes - black is a quarter of
          // a millisecond a line and the timeout is thirty seconds - and the
          // window is live throughout.
          if (reply === undefined) {
            this.held.push(frame);
          } else {
            this.send(frame.type, { id: frame.id, ...reply });
          }
        }
        if (this._dap === true && frame.type === "debug.send" && frame.message?.type === "request") {
          this._answerDap(frame);
        }
        for (const waiter of [...this._waiters]) {
          if (waiter.type === frame.type) {
            this._waiters.splice(this._waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      }
    });
  }


  /**
   * Answer a request that was held open, as the sidecar eventually would.
   *
   * Takes the oldest held frame of that type, so a test reads as the sequence
   * it is describing: hold, do the thing that used to break, release.
   */
  release(type, payload = {}) {
    const index = this.held.findIndex((frame) => frame.type === type);
    if (index === -1) {
      throw new Error(`no held ${type} to release`);
    }
    const [frame] = this.held.splice(index, 1);
    this.send(frame.type, { id: frame.id, ...payload });
    return frame;
  }

  /** Send a control frame, exactly as the sidecar's channel.send does. */
  send(type, payload = {}) {
    this._route.send(JSON.stringify({ type, ...payload }));
  }

  /** Send a binary frame through the shipped encoder, so both ends agree. */
  sendBinary(kind, payload, header = null) {
    const buffer = encodeBinary(kind, payload, header);
    this._route.send(Buffer.from(buffer));
  }

  /** Resolve when the application sends a frame of this type. */
  waitFor(type, timeout = 10000) {
    const already = this.received.find((frame) => frame.type === type);
    if (already !== undefined) {
      return Promise.resolve(already);
    }
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this._waiters.push(waiter);
      setTimeout(() => reject(new Error(`No ${type} frame within ${timeout}ms`)), timeout);
    });
  }

  /** The text of every binary frame of a kind the application sent. */
  binaryTextOf(kind) {
    return this.receivedBinary
      .filter((frame) => frame.kind === kind)
      .map((frame) => new TextDecoder().decode(frame.payload));
  }

  /** What the application sent, for asserting on a whole exchange at once. */
  typesSent() {
    return this.received.map((frame) => frame.type);
  }
}

/**
 * Open the application and wait for the shell to be up.
 *
 * @param page a Playwright page
 * @param options.platform what NL_OS says: "Darwin", "Windows" or "Linux"
 * @param options.argv what NL_ARGS says, for the `studio <path>` behaviour
 * @param options.settings the settings.json the application starts from
 * @param options.files extra files to seed the in-memory filesystem with
 * @param options.ready whether to answer the sidecar handshake with "ready"
 */
export async function open(page, options = {}) {
  const {
    platform = "Darwin",
    argv = ["/app/build123d-studio"],
    settings = null,
    files = {},
    // Other pids the process listing should report as windows of this
    // application. Recovery asks the operating system which of them are live,
    // so this is how a test says "that journal belongs to somebody who is still
    // running" - and, with brokenListing, how it says the listing failed.
    running = [],
    brokenListing = false,
    // No trash on this volume, so a delete has to ask a second question.
    trashFails = false,
    // Modification times for seeded files, where a test needs one to mean
    // something.
    times = {},
    ready = true,
  } = options;

  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console.error: ${message.text()}`);
    }
  });

  await page.route("**/__neutralino_globals.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: GLOBALS(platform, argv),
    }),
  );

  const sidecar = new FakeSidecar();
  await page.routeWebSocket(new RegExp(`^ws://127\\.0\\.0\\.1:${SIDECAR.port}/`), (route) => {
    sidecar._attach(route);
    if (ready) {
      // The frame startup waits for. Sent on connect because the harness has no
      // kernel to wait for; a test that wants the slow path passes ready: false
      // and sends it itself.
      route.send(JSON.stringify({ type: "ready", connectionFile: "/appdata/kernel.json" }));
    }
  });

  await page.addInitScript(
    ([harness, seed, stored, stamps, processes]) => {
      globalThis.__HARNESS__ = harness;
      globalThis.__HARNESS_FILES__ = seed;
      globalThis.__HARNESS_SETTINGS__ = stored;
      globalThis.__HARNESS_TIMES__ = stamps;
      globalThis.__HARNESS_PROCESSES__ = processes;
    },
    [{ sidecar: SIDECAR, env: {} }, files, settings, times,
      { running, brokenListing, trashFails }],
  );

  await page.goto("/");
  // The splash is hidden rather than removed - index.html keeps the element so
  // a later failure can raise it again - so "detached" would wait for ever. And
  // "attached" rather than the default "visible", because the thing being
  // waited for is precisely an element that has stopped being visible.
  await page.waitForSelector("#splash.hidden", { state: "attached", timeout: 30000 });

  return { sidecar, problems };
}
