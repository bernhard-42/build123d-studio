// node --test src/editor/signature.test.mjs
//
// The parameter hints popup's data, as the sidecar sends it.
//
// The fixture is jedi's answer for a cursor inside Box(10, 10, |) against the
// pinned environment. The part worth holding is activeParameter: Monaco
// highlights the parameter at that index, so an index that is off by one
// underlines the wrong argument, which is worse than no popup at all.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { signatureHelp } from "./signature.js";

const BOX = {
  signature: {
    signatures: [
      {
        label: "Box(length: float, width: float, height: float, rotation=(0, 0, 0), align=…)",
        parameters: ["length: float", "width: float", "height: float", "rotation=(0, 0, 0)"],
        documentation: "Create a box.",
      },
    ],
    activeSignature: 0,
    activeParameter: 2,
  },
};

test("a signature becomes Monaco's shape, parameters and all", () => {
  const help = signatureHelp(BOX);
  assert.equal(help.signatures.length, 1);
  assert.equal(help.signatures[0].label.startsWith("Box("), true);
  assert.deepEqual(help.signatures[0].parameters, [
    { label: "length: float" },
    { label: "width: float" },
    { label: "height: float" },
    { label: "rotation=(0, 0, 0)" },
  ]);
  assert.equal(help.signatures[0].documentation, "Create a box.");
});

test("the argument being typed is the one Monaco highlights", () => {
  assert.equal(signatureHelp(BOX).activeParameter, 2);
});

test("past the last parameter, nothing is highlighted", () => {
  // jedi answers -1 for a call with more arguments than the signature has
  // parameters - *args, or a mistake half typed. Monaco highlights nothing for
  // an index it cannot find, which is the honest rendering of "no idea".
  const past = { signature: { ...BOX.signature, activeParameter: -1 } };
  assert.equal(signatureHelp(past).activeParameter, -1);
});

test("an out-of-range signature index falls back to the first", () => {
  const wrong = { signature: { ...BOX.signature, activeSignature: 7 } };
  assert.equal(signatureHelp(wrong).activeSignature, 0);
});

test("an empty documentation is left off rather than sent as an empty string", () => {
  // Monaco renders the documentation area whenever there is a value, so an
  // empty string is an empty box under the signature.
  const bare = {
    signature: {
      ...BOX.signature,
      signatures: [{ ...BOX.signature.signatures[0], documentation: "" }],
    },
  };
  assert.equal(signatureHelp(bare).signatures[0].documentation, undefined);
});

test("no call under the cursor is null, which is most of the time", () => {
  for (const value of [null, undefined, {}, { signature: null }, { signature: {} }]) {
    assert.equal(signatureHelp(value), null);
  }
});

test("a call jedi could not describe is null rather than an empty popup", () => {
  assert.equal(signatureHelp({ signature: { signatures: [], activeParameter: 0 } }), null);
});
