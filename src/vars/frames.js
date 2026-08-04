// The variable explorer's other source: the paused frame, not the kernel.
//
// While a session is running the pane shows what the debugged process holds -
// the same rule the console pane follows, so every pane in the window describes
// the same world at the same time. The rows are the frame's scopes, Locals
// first, and opening one asks the adapter rather than the kernel.
//
// The shape it produces is the inspector's, deliberately: name, type, repr,
// expandable, and children under a path of ordinals. That is what lets the pane
// itself stay unaware of which world it is drawing - see explorer.js, which
// picks a source and otherwise does not know the difference.

import { scopes, variables } from "../debug/session.js";
import { pathKey } from "./tree.js";

// Every path this has handed out, against the reference the adapter wants back.
// DAP addresses a nested value by an opaque number rather than by position, so
// the ordinals the pane uses have to be translated - and only the side that
// issued them can do it.
//
// Cleared whenever execution moves: a variablesReference belongs to one stop.
// Reusing one from the previous stop is not an error the adapter reports, it is
// an answer describing a frame that has gone.
const references = new Map();

/** Forget every reference. Called on each stop, and when a session ends. */
export function reset() {
  references.clear();
}

function row(name, type, value, reference) {
  return {
    name,
    type: type ?? "",
    size: null,
    repr: value ?? "",
    label: "",
    // A reference of zero is DAP for "nothing inside this".
    expandable: (reference ?? 0) > 0,
  };
}

/** The top-level rows: the scopes of the frame the user has selected. */
export async function scopeRows() {
  reset();
  const found = await scopes();
  return found.map((scope) => {
    references.set(pathKey([scope.name]), scope.variablesReference ?? 0);
    return row(scope.name, "", "", scope.variablesReference);
  });
}

/**
 * One level down, in the inspector's reply shape.
 *
 * No paging: DAP can page a variables request and debugpy does not need it at
 * the sizes a stack frame holds. The absent offset and total are what make the
 * pane leave the pager off, which is the right answer rather than a missing one.
 */
export async function detailFor(path) {
  const reference = references.get(pathKey(path));
  if (reference === undefined || reference === 0) {
    return { path, children: [] };
  }

  const found = await variables(reference);
  const children = found.map((variable, index) => {
    references.set(pathKey([...path, index]), variable.variablesReference ?? 0);
    return row(variable.name, variable.type, variable.value, variable.variablesReference);
  });
  return { path, children };
}
