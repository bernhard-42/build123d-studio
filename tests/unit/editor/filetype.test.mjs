// node --test tests/unit/editor/filetype.test.mjs
//
// What counts as binary and what counts as large. Both are decisions the editor
// acts on before it has read a file, and both are wrong in ways that are hard
// to see afterwards: too strict and a file somebody meant to open is refused,
// too loose and a PNG lands in a buffer that will overwrite it on save.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  describeSize,
  isLarge,
  LARGE_FILE_BYTES,
  looksBinary,
  SNIFF_BYTES,
} from "../../../src/editor/filetype.js";

const bytesOf = (text) => new TextEncoder().encode(text);

// --- binary ---

test("ordinary source is text", () => {
  assert.equal(looksBinary(bytesOf("from build123d import *\n\nb = Box(1, 2, 3)\n")), false);
});

test("an empty file is text", () => {
  // The file you have just made and are about to type into.
  assert.equal(looksBinary(new Uint8Array(0)), false);
});

test("a NUL byte anywhere in the sample is binary", () => {
  // A real PNG head, and the reason it is written out in full rather than
  // stopping at the signature: 89 50 4E 47 0D 0A 1A 0A contains no NUL at all.
  // The first one is in the length field of the IHDR chunk that follows, at
  // byte 8 - so a sniff too short to reach it would call a PNG text. This is
  // what SNIFF_BYTES being thousands rather than a magic number's worth is for.
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  assert.equal(looksBinary(png.slice(0, 8)), false);
  assert.equal(looksBinary(png), true);
  assert.equal(looksBinary(new Uint8Array([...bytesOf("MZ"), 0x90, 0x00, 0x03])), true);
});

test("a STEP export is text, however large it gets", () => {
  // The case this guard must not catch: a real assembly's export is tens of
  // megabytes of ASCII, and refusing it would refuse the files this editor is
  // for. Size is a separate question with a separate answer.
  const step = "ISO-10303-21;\nHEADER;\n" + "#1=CARTESIAN_POINT('',(0.,0.,0.));\n".repeat(500);
  assert.equal(looksBinary(bytesOf(step)), false);
});

test("high bytes on their own are not binary", () => {
  // UTF-8 text is full of them. A rule that called any byte over 127 binary
  // would refuse every file with a degree sign or a name in it.
  assert.equal(looksBinary(bytesOf("# Maß: 12° an der Rückseite\n")), false);
});

test("UTF-16 is binary here, and that is the right answer", () => {
  // Not a judgement about the file: Monaco is handed a UTF-8 string, so a
  // UTF-16 file put in a buffer is as unreadable as a PNG.
  const utf16 = new Uint8Array([0xff, 0xfe, 0x62, 0x00, 0x20, 0x00, 0x3d, 0x00]);
  assert.equal(looksBinary(utf16), true);
});

test("the sample is a prefix, and the rule reads all of what it is given", () => {
  // The caller passes at most SNIFF_BYTES; nothing here assumes a length.
  const trailing = new Uint8Array(SNIFF_BYTES);
  trailing.fill(0x61);
  assert.equal(looksBinary(trailing), false);
  trailing[SNIFF_BYTES - 1] = 0;
  assert.equal(looksBinary(trailing), true);
});

// --- size ---

test("a file at the threshold is not large, and one byte past it is", () => {
  assert.equal(isLarge(LARGE_FILE_BYTES), false);
  assert.equal(isLarge(LARGE_FILE_BYTES + 1), true);
});

test("ordinary sizes are not large", () => {
  assert.equal(isLarge(0), false);
  assert.equal(isLarge(4096), false);
  assert.equal(isLarge(2 * 1024 * 1024), false);
});

test("a size that is not a number is not large", () => {
  // getStats answering with something unexpected must not turn into a question
  // about a file whose size nobody knows.
  assert.equal(isLarge(null), false);
  assert.equal(isLarge(undefined), false);
  assert.equal(isLarge("12000000"), false);
});

// --- how it reads ---

test("sizes are described in the unit that suits them", () => {
  assert.equal(describeSize(0), "0 bytes");
  assert.equal(describeSize(512), "512 bytes");
  assert.equal(describeSize(2048), "2.0 kB");
  assert.equal(describeSize(13 * 1024 * 1024), "13.0 MB");
  assert.equal(describeSize(Math.round(12.44 * 1024 * 1024)), "12.4 MB");
});

test("an unknown size says so rather than inventing a number", () => {
  assert.equal(describeSize(null), "an unknown size");
  assert.equal(describeSize(Number.NaN), "an unknown size");
  assert.equal(describeSize(-1), "an unknown size");
});
