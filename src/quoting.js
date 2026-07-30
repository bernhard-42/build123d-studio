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
 * A value containing a double quote is refused rather than escaped. That is the
 * fix for the injection this module's own tests used to certify as safe, and
 * refusing is a better answer than escaping for three reasons.
 *
 * The escaping cannot work, because there are two parsers and they disagree.
 * Neutralino wraps every command in `cmd.exe /c "..."` - confirmed against the
 * shipped binary, which contains that literal string, not inferred - so cmd
 * reads the line first and CommandLineToArgvW second. ArgvW's escape for a
 * quote is `\"`; cmd has no escape at all, and reads the backslash as an
 * ordinary character and the quote as the end of its quoted region. So
 *
 *     a" & calc.exe & "b
 *
 * quoted for ArgvW as `"a\" & calc.exe & \"b"` leaves cmd looking at
 * ` & calc.exe & ` outside any quoted region, and cmd runs it. The round-trip
 * test above passed the whole time, because it modelled ArgvW and nothing else.
 *
 * Nothing legitimate is lost, because `"` is one of the characters Windows
 * forbids in a file name. Every value that reaches here is a path, so a quote in
 * one is already not a thing the user can have meant.
 *
 * And the alternative was worse. The review proposed a caret pass - escaping
 * cmd's metacharacters with `^` - which is a second escaping layer interacting
 * with the first, on a platform none of us can run a test on. Rejection fails
 * closed and can be checked from here.
 *
 * `%` is still not handled and still cannot be: it opens variable expansion
 * inside double quotes and `%%` only escapes in batch files. It corrupts a
 * value, it does not inject one, so it stays documented rather than refused -
 * `%` is legal in a Windows path and refusing it would break real ones.
 *
 * What remains is the backslash rule, which the original `"${value}"` also got
 * wrong. Backslashes are only special immediately before a quote, where they
 * escape it: 2n produce n and end the argument, 2n+1 produce n and a literal
 * quote. With no quote left in the value, the closing one is the only quote any
 * backslash can precede - so a path ending in a backslash, and `C:\CAD\` is an
 * ordinary directory, escaped that closing quote and swallowed the rest of the
 * command line until this doubled it.
 */
function quoteWindows(value) {
  if (value.includes('"')) {
    throw new Error(
      `A double quote cannot be passed safely to a Windows command line: ${value}`,
    );
  }

  // With no quote left in the value, the only backslashes that are special are
  // the trailing ones, because the closing quote is the only quote they can
  // precede. Doubling them is what stops `C:\CAD\` escaping that closing quote
  // and swallowing the rest of the command line - the original bug here.
  //
  // The general case used to be written out as a loop over every character,
  // doubling any run of backslashes before an embedded quote. That code is
  // deliberately gone rather than left unreachable: it was ArgvW-correct and
  // cmd-unsafe, so keeping it would mean deleting the check above silently
  // restored the injection instead of obviously breaking.
  const trailing = /\\*$/.exec(value)[0].length;
  return `"${value}${"\\".repeat(trailing)}"`;
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
