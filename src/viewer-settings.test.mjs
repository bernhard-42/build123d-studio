import assert from "node:assert/strict";
import test from "node:test";

import {
  GROUPS,
  SETTINGS,
  defaults,
  parseValue,
  settingFor,
  toStore,
  withDefaults,
} from "./viewer-settings.js";

test("the schema is the viewer's vocabulary, not a second one", () => {
  // Every key here is a keyword `show()` takes and a name the viewer reports
  // back. A typo would produce a setting that is stored, shown, and silently
  // dropped by the renderer - the failure mode this ecosystem specialises in.
  const keys = SETTINGS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "a key is declared twice");
  assert.ok(keys.includes("grid_XY") && keys.includes("grid_XZ") && keys.includes("grid_YZ"));
  assert.ok(!keys.includes("theme"), "theme is the application's own setting");
  assert.ok(!keys.includes("grid"), "the grid triple is assembled from the three flags");
});

test("every setting has a default from the shared file", () => {
  // The file the transport answers from. A key here that is missing there is a
  // control with no default, and - worse - a setting the answer never carries.
  for (const setting of SETTINGS) {
    assert.notEqual(setting.default, undefined, `${setting.key} is not in viewer_defaults.json`);
  }
});

test("every setting is renderable", () => {
  const types = new Set(["boolean", "number", "integer", "enum", "color", "keymap"]);
  for (const setting of SETTINGS) {
    assert.ok(types.has(setting.type), `${setting.key} has type ${setting.type}`);
    assert.ok(typeof setting.label === "string" && setting.label !== "");
    if (setting.type === "enum") {
      assert.ok(setting.options.includes(setting.default));
    }
  }
});

test("groups hold every setting exactly once", () => {
  const grouped = GROUPS.flatMap((g) => g.settings.map((s) => s.key));
  assert.deepEqual(grouped.slice().sort(), SETTINGS.map((s) => s.key).sort());
});

test("only what differs from the default is stored", () => {
  // The point of the whole storage design: an unset key means "the viewer
  // decides", so a value that equals today's default must not be written - it
  // would pin that default if the shared core ever moved it.
  assert.deepEqual(toStore({ axes: false, ortho: true }), {});
  assert.deepEqual(toStore({ axes: true }), { axes: true });
  assert.deepEqual(toStore({ tree_width: 240 }), {});
  assert.deepEqual(toStore({ tree_width: 300 }), { tree_width: 300 });
});

test("an unknown key is dropped rather than stored", () => {
  assert.deepEqual(toStore({ nonsense: 1, axes: true }), { axes: true });
});

test("the keymap compares by value, not by identity", () => {
  const asDefault = { shift: "shiftKey", ctrl: "ctrlKey", meta: "metaKey", alt: "altKey" };
  assert.deepEqual(toStore({ modifier_keys: asDefault }), {});
  assert.deepEqual(
    toStore({ modifier_keys: { ...asDefault, alt: "metaKey" } }),
    { modifier_keys: { ...asDefault, alt: "metaKey" } },
  );
});

test("what the dialog shows is the defaults with the stored values over them", () => {
  const shown = withDefaults({ axes: true, nonsense: 5 });
  assert.equal(shown.axes, true);
  assert.equal(shown.ortho, defaults().ortho);
  assert.equal(shown.nonsense, undefined);
});

test("numbers are clamped rather than refused", () => {
  assert.equal(parseValue("tree_width", "5"), 100);
  assert.equal(parseValue("tree_width", "10000"), 800);
  assert.equal(parseValue("tree_width", "300"), 300);
  assert.equal(parseValue("default_opacity", "0.25"), 0.25);
});

test("a number that is not a number is refused, not defaulted", () => {
  // Null means "do not write this key", which leaves whatever was stored
  // alone. Substituting the default would silently discard the user's value.
  assert.equal(parseValue("ticks", ""), null);
  assert.equal(parseValue("ticks", "abc"), null);
});

test("an integer setting does not accept a fraction", () => {
  assert.equal(parseValue("tree_width", "240.7"), 240);
});

test("an enum takes only its own values", () => {
  assert.equal(parseValue("collapse", "leaves"), "leaves");
  assert.equal(parseValue("collapse", "LEAVES"), null);
  assert.equal(parseValue("reset_camera", "KEEP"), "KEEP");
});

test("a colour keeps a CSS name as written", () => {
  // Two of the shipped defaults are names rather than hex, and the viewer
  // resolves both - so a control that normalised to hex would rewrite a value
  // the user never touched.
  assert.equal(parseValue("default_facecolor", " Violet "), "Violet");
  assert.equal(parseValue("default_color", "#e8b024"), "#e8b024");
  assert.equal(parseValue("default_color", "  "), null);
});

test("a keymap keeps only real modifiers", () => {
  assert.deepEqual(parseValue("modifier_keys", { shift: "ctrlKey" }), { shift: "ctrlKey" });
  assert.equal(parseValue("modifier_keys", { shift: "nonsense" }), null);
  assert.equal(parseValue("modifier_keys", "shiftKey"), null);
});

test("an unknown key parses to nothing", () => {
  assert.equal(parseValue("nonsense", "1"), null);
  assert.equal(settingFor("nonsense"), null);
  assert.equal(settingFor("axes").type, "boolean");
});
