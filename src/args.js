// What the command line asked this instance to open.
//
// Neutralino puts the whole argv in NL_ARGS, including its own flags - the
// binary, --path=, --load-dir-res and anything else the runtime cares about -
// so ours is a named flag rather than a positional. A bare positional would
// mean guessing which of several arguments was meant for the application, and
// guessing wrong opens somebody's home directory.
//
// The `studio` script always passes one, resolving to the shell's working
// directory when given nothing. That is what makes the rule at the other end so
// short: a path means open it, no path means this was a double-click, and a
// double-click restores the previous session.

const FLAG = "--open=";

/**
 * The path this instance was asked to open, or null for none.
 *
 * @param {string[]} argv typically NL_ARGS
 * @returns {string|null} an absolute path, as the script resolved it
 */
export function openTarget(argv) {
  if (Array.isArray(argv) === false) {
    // NL_ARGS is always defined in a Neutralino window, and this file is also
    // imported by tests that hand it whatever they like.
    return null;
  }

  // Last wins. Two --open flags is not a thing the script produces, but a
  // person typing the binary's name directly might, and answering with the last
  // one is what every shell tool does.
  let found = null;
  for (const argument of argv) {
    if (typeof argument === "string" && argument.startsWith(FLAG)) {
      found = argument.slice(FLAG.length);
    }
  }

  // `--open=` with nothing after it is not a request to open the current
  // directory - it is a script bug, and treating it as a path would open
  // whatever the working directory happens to be.
  if (found === "") {
    return null;
  }
  return found;
}
