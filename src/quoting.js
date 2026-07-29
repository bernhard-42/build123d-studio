// Shell quoting, kept in its own module because it is the one piece of this
// application that is pure, security-relevant, and impossible to test on the
// platform it matters most on.
//
// Everything interpolated into a command string must go through quote(). Not
// "everything that might contain a space" - everything. Neutralino's
// spawnProcess takes a string and hands it to a shell (/bin/sh on Unix,
// `cmd.exe /c "..."` on Windows), so an unquoted value is not a formatting
// problem, it is a command injection. The values here are install paths,
// app-data paths and files the user chose, which are not attacker-controlled
// today; Phase 3 adds a free-text field for extra packages, and that is exactly
// the kind of change that turns a habit into a vulnerability.

/**
 * Quote for CommandLineToArgvW, which is what parses the string on Windows
 * after cmd.exe has had its turn.
 *
 * Two rules, both of which the previous `"${value}"` got wrong:
 *
 *   * a literal quote must be escaped, or the value ends the argument early -
 *     and with cmd.exe in the chain it ends the whole `cmd /c "..."` wrapper;
 *   * backslashes are only special immediately before a quote, where they
 *     escape it. A path ending in a backslash - `C:\CAD\` is an ordinary
 *     directory - therefore escaped the closing quote and swallowed the rest of
 *     the command line.
 *
 * The rule is: 2n backslashes before a quote produce n backslashes and end the
 * argument, 2n+1 produce n backslashes and a literal quote. So backslashes are
 * doubled when they precede a quote (including the closing one) and left alone
 * everywhere else.
 *
 * Not handled, because cmd.exe offers no way to: a literal `%` still opens
 * variable expansion inside double quotes, so a path containing `%USERNAME%`
 * would be substituted. `%%` only escapes inside batch files, not on a command
 * line. An undefined name is left as written, so this bites only when the text
 * between percent signs happens to name a real variable.
 */
function quoteWindows(value) {
  let quoted = '"';
  let backslashes = 0;

  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      // These backslashes now precede a quote, so they are escapes: double
      // them, then escape the quote itself.
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }

  // Trailing backslashes precede the closing quote, so they are escapes too.
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * Quote for /bin/sh: single quotes, with an embedded single quote written as
 * '\'' - close, escaped quote, reopen. Nothing else is special inside single
 * quotes, which is why this form needs no other cases.
 */
function quotePosix(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quote a value for a shell command string on the given platform.
 *
 * @param {string} platform NL_OS: "Windows", "Darwin" or "Linux"
 * @param {string} value
 */
export function quoteFor(platform, value) {
  const text = String(value);
  return platform === "Windows" ? quoteWindows(text) : quotePosix(text);
}
