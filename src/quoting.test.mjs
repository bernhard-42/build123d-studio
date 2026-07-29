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

test("windows: an embedded quote is escaped rather than ending the argument", () => {
  assert.equal(quoteFor("Windows", 'a"b'), '"a\\"b"');
});

test("windows: backslashes before a quote are doubled, elsewhere left alone", () => {
  assert.equal(quoteFor("Windows", 'a\\"b'), '"a\\\\\\"b"');
  assert.equal(quoteFor("Windows", "a\\b"), '"a\\b"');
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

  for (const value of [
    "C:\\CAD\\",
    'C:\\CAD "projects"\\part.py',
    'a" & calc.exe & "b',
    "C:\\a\\\\b\\\\\\",
    'trailing quote"',
    '"',
    "\\",
  ]) {
    assert.equal(unquote(quoteFor("Windows", value)), value, `round trip: ${value}`);
  }
});
