// What debugging reads out of settings.json.
//
// One value so far, in a module of its own because the alternative is
// session.js importing the settings store and the settings dialog importing
// session.js - a cycle for the sake of a boolean.

import { getSetting } from "../store.js";

export const JUST_MY_CODE_KEY = "debugJustMyCode";
export const ON_STOP_KEY = "debugOnStop";
export const ON_STOP_BREAKPOINTS_ONLY_KEY = "debugOnStopBreakpointsOnly";

/**
 * Whether "step into" stops at the edge of the user's own code.
 *
 * True by default, which is debugpy's own default and the safer one to meet
 * first: stepping into build123d when you did not mean to is disorienting while
 * you are still learning what the buttons do. Turned off, a step into
 * `extrude(Ellipse(10, 6), 2)` lands in build123d's own source, which is what
 * somebody debugging a model usually wants once they know to want it.
 */
export function justMyCode() {
  const stored = getSetting(JUST_MY_CODE_KEY, true);
  return typeof stored === "boolean" ? stored : true;
}

// What the on-stop expression is unless somebody changes it. Defaulted on
// rather than empty: this is the visual debugging the plan asked for, and a
// feature nobody can find is a feature nobody has. The cost that argued for
// empty is answered by onStopBreakpointsOnly below, which is on by default - so
// out of the box it draws once per breakpoint, which is once per place somebody
// deliberately stopped.
const DEFAULT_ON_STOP = "show_all(locals())";

/**
 * An expression to run each time execution stops, or "" for none.
 *
 * This is what makes debugging *visual* on this application rather than
 * textual: `show_all(locals())` at every stop draws the shapes in the frame
 * into the viewer, so stepping through a model is watching it being built. The
 * debugged process is given the kernel's environment - the model socket's port
 * and token - which is the only reason a shape drawn there arrives in the same
 * pane.
 *
 * Clearing the field switches it off. It costs a tessellation per stop, which
 * on a large assembly is seconds.
 */
export function onStopExpression() {
  const stored = getSetting(ON_STOP_KEY, DEFAULT_ON_STOP);
  // An empty string is a stored answer rather than an absent one, so it is
  // honoured: somebody who clears the field wants nothing to run.
  return typeof stored === "string" ? stored.trim() : DEFAULT_ON_STOP;
}

/**
 * Whether the on-stop expression runs at every stop or only at breakpoints.
 *
 * True by default, because the expression is the expensive one: a step through
 * a multi-line call stops on every argument line - measured, `base -=
 * Cylinder(a, b, c)` stops six times - and tessellating a whole assembly at
 * each of them is seconds each time. Landing on a breakpoint is somewhere
 * somebody asked to be, and drawing there is what they asked for.
 *
 * Turned off, the model is redrawn as you step, which is the closest this gets
 * to watching a shape being built. That is worth having and worth choosing
 * deliberately.
 */
export function onStopBreakpointsOnly() {
  const stored = getSetting(ON_STOP_BREAKPOINTS_ONLY_KEY, true);
  return typeof stored === "boolean" ? stored : true;
}
