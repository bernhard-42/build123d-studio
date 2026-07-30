// node --test src/quoting.test.mjs
//
// These exist because the Windows half of quote() cannot be exercised here.
// There is no Windows machine, the packaging job for it has never run, and a
// quoting bug does not announce itself - it either works or it hands a shell
// something the author did not intend. Asserting the rules is the closest
// available thing to running them.
//
// The expectations below are what CommandLineToArgvW does, not what looks
// tidy: 2n backslashes before a quote yield n backslashes and end the argument,
// 2n+1 yield n backslashes and a literal quote.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { quoteFor } from "./quoting.js";

test("posix: wraps in single quotes", () => {
  assert.equal(quoteFor("Darwin", "/usr/bin/curl"), "'/usr/bin/curl'");
  assert.equal(quoteFor("Linux", "/CAD projects/part.py"), "'/CAD projects/part.py'");
});

test("posix: a single quote is closed, escaped and reopened", () => {
  assert.equal(quoteFor("Darwin", "it's"), "'it'\\''s'");
});

test("posix: shell metacharacters stay inside the quotes", () => {
  for (const hostile of ["a; rm -rf /", "a && b", "a | b", "$(id)", "`id`", "a\nb"]) {
    const quoted = quoteFor("Darwin", hostile);
    assert.equal(quoted, `'${hostile}'`, `${hostile} must be wholly quoted`);
  }
});

test("windows: wraps in double quotes", () => {
  assert.equal(quoteFor("Windows", "C:\\Program Files\\uv.exe"), '"C:\\Program Files\\uv.exe"');
});

test("windows: a trailing backslash does not escape the closing quote", () => {
  // The bug this replaces: "C:\CAD\" ended the argument early and let the rest
  // of the command line escape.
  assert.equal(quoteFor("Windows", "C:\\CAD\\"), '"C:\\CAD\\\\"');
  assert.equal(quoteFor("Windows", "C:\\CAD\\\\"), '"C:\\CAD\\\\\\\\"');
});

test("windows: an embedded quote is refused, not escaped", () => {
  // This used to assert quoteFor("Windows", 'a"b') === '"a\\"b"', which is what
  // CommandLineToArgvW wants and what cmd.exe reads as the end of its quoted
  // region. Escaping for the second parser while the first one is still looking
  // is the injection; see quoting.js.
  for (const value of ['a"b', '"', 'trailing quote"', 'a" & calc.exe & "b']) {
    assert.throws(() => quoteFor("Windows", value), /double quote/,
      `${JSON.stringify(value)} must be refused`);
  }
});

test("windows: a quote is refused only on Windows", () => {
  // /bin/sh has one parser and single quotes really do quote everything, so the
  // same value is perfectly safe there and must keep working.
  assert.equal(quoteFor("Darwin", 'a"b'), `'a"b'`);
});

test("windows: backslashes are literal except before the closing quote", () => {
  assert.equal(quoteFor("Windows", "a\\b"), '"a\\b"');
  assert.equal(quoteFor("Windows", "C:\\a\\\\b"), '"C:\\a\\\\b"');
});

// cmd.exe gets the string before CommandLineToArgvW does, and it plays by
// different rules. Confirmed against the shipped binary rather than assumed:
// `strings bin/neutralino-win_x64.exe` contains the literal `cmd.exe /c "`, so
// every command this application builds is wrapped in one.
//
// The rules that matter, from `cmd /?`: with several quotes present, cmd strips
// the first and the last and parses what is left as a command line. In that
// text a `"` toggles a quoted region and *nothing escapes it* - a backslash is
// an ordinary character to cmd, so ArgvW's `\"` reads to cmd as a literal
// backslash followed by a quote that closes the region. Anything in `&|<>()`
// outside a quoted region then separates commands.
//
// That is the whole injection, and it says which character is dangerous: a
// value containing `&` but no `"` never leaves the quoted region and is inert.
// The quote is the only way out.
function cmdEscapes(commandLine) {
  let inQuotes = false;
  for (const character of commandLine) {
    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && "&|<>()".includes(character)) {
      return character;
    }
  }
  return null;
}

test("windows: a value cannot reach cmd.exe as a command separator", () => {
  for (const value of [
    'a" & calc.exe & "b',
    '" & calc.exe & "',
    'x"|whoami"y',
    'a" > C:\\Windows\\System32\\drivers\\etc\\hosts "b',
    "C:\\CAD & Design\\part.py",
    "C:\\CAD (2026)\\part.py",
  ]) {
    let quoted;
    try {
      quoted = quoteFor("Windows", value);
    } catch {
      // Rejected outright, which is the other acceptable answer: a value that
      // never reaches the command line cannot inject into it.
      continue;
    }
    const escaped = cmdEscapes(`C:\\app\\uv.exe ${quoted}`);
    assert.equal(escaped, null,
      `${JSON.stringify(value)} quoted as ${JSON.stringify(quoted)} lets cmd.exe ` +
      `see ${JSON.stringify(escaped)} outside quotes`);
  }
});

test("windows: a value cannot break out of the quoting", () => {
  // Round-trip through the documented CommandLineToArgvW rules: whatever went
  // in must come back out as exactly one argument.
  const unquote = (quoted) => {
    assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), "must be quoted");
    const body = quoted.slice(1, -1);
    let out = "";
    let backslashes = 0;
    for (const character of body) {
      if (character === "\\") {
        backslashes += 1;
        continue;
      }
      if (character === '"') {
        assert.equal(backslashes % 2, 1, "an unescaped quote would end the argument");
        out += "\\".repeat((backslashes - 1) / 2) + '"';
        backslashes = 0;
        continue;
      }
      out += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
    assert.equal(backslashes % 2, 0, "a trailing odd backslash would escape the closing quote");
    return out + "\\".repeat(backslashes / 2);
  };

  // Values carrying a quote are no longer in this list: they do not round-trip
  // any more, they are refused, and the test above is where that is asserted.
  // The round trip still matters for everything that does get through, because
  // the backslash rules are unchanged and a path ending in one is ordinary.
  for (const value of [
    "C:\\CAD\\",
    "C:\\CAD projects\\part.py",
    "C:\\a\\\\b\\\\\\",
    "C:\\CAD & Design\\part.py",
    "\\",
    "",
  ]) {
    assert.equal(unquote(quoteFor("Windows", value)), value, `round trip: ${value}`);
  }
});
