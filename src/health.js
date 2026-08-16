// How each part of the application is doing, and whether that is worth saying.
//
// Everything below the window has a lifecycle - the model channel, the
// measurement backend, the kernel, the language server, the console - and each
// of them used to announce itself into the log and tell the user nothing. The
// expensive failure is not the loud one: it is a start that *looks* fine with
// one part dead, because every symptom afterwards has the wrong shape. `show()`
// draws nothing, a measurement answers nothing, completion is silent - and the
// application knew all along.
//
// Pure on purpose: no Neutralino, no DOM. What to do about a subsystem being
// unwell is the toolbar's business and the Backend tab's; deciding *whether*
// anything is unwell is a rule, and rules belong where they can be tested.

/** The states a subsystem may report, worst last. */
export const STATES = ["ready", "starting", "degraded", "failed"];

// What each state means for the user, in the order a person acts on them:
// nothing to do, wait, it works but something is wrong, it does not work.
const SEVERITY = { ready: 0, starting: 1, degraded: 2, failed: 3 };

const subsystems = new Map();
const listeners = new Set();

/**
 * Record what a subsystem last said about itself.
 *
 * Unknown names are kept rather than refused: this list is not a schema, it is
 * whatever the sidecar has to say, and a new part reporting for the first time
 * must not be silently dropped by an older frontend.
 */
export function record(name, state, detail = "") {
  if (typeof name !== "string" || name === "") {
    return;
  }
  subsystems.set(name, {
    name,
    state: SEVERITY[state] === undefined ? "degraded" : state,
    detail: typeof detail === "string" ? detail : "",
  });
  for (const listener of listeners) {
    listener(health());
  }
}

/**
 * Forget everything, as a replacement sidecar does.
 *
 * Subscribers are told, and that is not a detail: this exists because a chip in
 * the toolbar can otherwise go on describing a process that no longer exists.
 * Clearing the record without saying so would leave exactly the stale reading
 * it is meant to remove, until something unrelated happened to speak.
 */
export function reset() {
  subsystems.clear();
  for (const listener of listeners) {
    listener(health());
  }
}

/** Every subsystem, worst first, then alphabetically so the order is stable. */
export function health() {
  return [...subsystems.values()].sort(
    (a, b) => SEVERITY[b.state] - SEVERITY[a.state] || a.name.localeCompare(b.name),
  );
}

/** The worst state anything is in, or "ready" when nothing has spoken. */
export function worstState() {
  let worst = "ready";
  for (const entry of subsystems.values()) {
    if (SEVERITY[entry.state] > SEVERITY[worst]) {
      worst = entry.state;
    }
  }
  return worst;
}

/**
 * Whether something is wrong enough to keep the startup pane on screen.
 *
 * `starting` is not: at the moment the window appears, the measurement backend
 * is still loading its geometry kernel and will be for a second or two, and
 * treating that as a fault would leave every good start looking like a bad one.
 */
export function anythingUnwell() {
  return SEVERITY[worstState()] >= SEVERITY.degraded;
}

/** One line per subsystem, for a tooltip or a report. */
export function summary() {
  return health()
    .map((entry) => `${entry.name}: ${entry.state}${entry.detail ? ` - ${entry.detail}` : ""}`)
    .join("\n");
}

/** Called whenever anything changes, with the current picture. */
export function onHealthChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
