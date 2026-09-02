// What the kernel is doing, and what the toolbar should say about it.
//
// Split from toolbar.js for health.js's reason, and it earned the split the
// same way health.js did. The state was a variable in the toolbar that happened
// to be rendered, and two different things read it: the indicator, and the
// check that decides whether an interrupt landed. So the moment the indicator
// wanted a word of its own - "interrupting" - the obvious change would have
// made that check see something other than `busy` and stop offering the restart
// that a missed interrupt needs. A display concern would have silently switched
// off a piece of help.
//
// Here the two are separate by construction. `state` is what the kernel says
// about itself and nothing else may write it; `interrupting` is a request this
// application has made and is waiting on. `label()` derives the word from both,
// and `hasStopped()` answers the interrupt question from the state alone.
//
// Pure: no DOM, no Neutralino. What to *do* about a busy kernel is the
// toolbar's business; what is true about it is a rule, and rules belong where
// they can be tested.

/** The states the sidecar reports, and the two this application infers. */
const STATES = ["starting", "idle", "busy", "dead"];

let state = "idle";
let interrupting = false;
const listeners = new Set();

function announce() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A renderer that throws must not stop the next one from being told.
    }
  }
}

/**
 * Record what the kernel says about itself.
 *
 * Anything else it might say is taken as `dead` rather than shown verbatim: the
 * indicator has three words and a fourth would arrive with no colour, no
 * meaning to a reader and no branch anywhere that handles it.
 */
export function report(next) {
  const known = STATES.includes(next) ? next : "dead";
  if (known !== "busy") {
    // It stopped, died, or was restarted. Whatever was asked of it is over.
    interrupting = false;
  }
  state = known;
  announce();
}

/** Note that an interrupt has been asked for and not yet answered. */
export function requestInterrupt() {
  interrupting = true;
  announce();
}

/**
 * Stop claiming an interrupt is in flight, without saying it succeeded.
 *
 * Used when the grace period runs out: five seconds is as long as "interrupting"
 * is worth saying, and after it the dialog explains while the indicator goes
 * back to the truth - busy, and not stopping.
 */
export function abandonInterrupt() {
  interrupting = false;
  announce();
}

/** What the kernel last reported. Never the display word. */
export function kernelState() {
  return state;
}

/**
 * Whether the kernel has stopped doing what it was asked to stop.
 *
 * The interrupt question, and it reads the reported state alone - which is the
 * property this module exists to keep true. An interrupted kernel goes idle; one
 * that never saw the signal stays busy, because Python raises KeyboardInterrupt
 * between operations and a single long native call has no between.
 */
export function hasStopped() {
  return state !== "busy";
}

/**
 * The word the indicator shows.
 *
 * "interrupting" only while the kernel is still busy: a kernel that has stopped
 * is idle, whatever was asked of it a moment earlier.
 */
export function label() {
  return interrupting && state === "busy" ? "interrupting" : state;
}

/**
 * The class the indicator carries, which is the *state* and not the label.
 *
 * The dot stays the busy one while an interrupt is pending, because that is
 * what the kernel is: asked to stop, and not yet stopped. Only the word says
 * that the asking has happened.
 */
export function indicatorClass() {
  return state;
}

/** Called whenever any of the above changes. */
export function onKernelChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget everything, for a test that needs a known starting point. */
export function reset() {
  state = "idle";
  interrupting = false;
}
