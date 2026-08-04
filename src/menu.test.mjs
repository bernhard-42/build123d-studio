// node --test src/menu.test.mjs
//
// The menu is a pure function of state, so its shape can be asserted without a
// window - which is the only part of it that can be checked here at all. Whether
// macOS actually binds Cmd-C from a native role, and what mainMenuItemClicked
// carries, are a real build's answers on a real machine.
//
// What these pin down is the documented contract: a single character on macOS
// and a display string elsewhere, roles only where we mean them, and every item
// that needs group 2 shipped disabled rather than shipped broken.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MENU, buildMenu, menuShortcut } from "./menu.js";
import { parseChord } from "./keys.js";

const RUN_COMMANDS = [
  { id: "run.cell", label: "Run Cell" },
  { id: "run.cell.stay", label: "Run Cell (Keep Cursor)" },
  { id: "run.selectionOrLine", label: "Run Selection or Line" },
  { id: "run.file", label: "Run File" },
];

function menu(platform, overrides = {}) {
  return buildMenu({
    platform,
    chordFor: () => null,
    isEnabled: () => true,
    nativeClipboard: platform === "Darwin",
    runCommands: RUN_COMMANDS,
    ...overrides,
  });
}

const CHORDS = { "run.cell": "shift+enter", "run.file": "f5" };

const find = (items, id) => items.find((entry) => entry.id === id);
const submenu = (built, id) => find(built, id).menuItems;

// --- the shortcut field, which is two different fields wearing one name ---

test("macOS takes a single character, Command implied", () => {
  assert.equal(menuShortcut("Darwin", parseChord("mod+c")), "c");
  assert.equal(menuShortcut("Darwin", parseChord("mod+s")), "s");
});

test("macOS can express nothing else, so it says nothing", () => {
  // Setting a key equivalent macOS cannot honour would be worse than leaving it
  // blank: the menu would advertise a shortcut that does not work.
  assert.equal(menuShortcut("Darwin", parseChord("shift+enter")), undefined);
  assert.equal(menuShortcut("Darwin", parseChord("ctrl+enter")), undefined);
  assert.equal(menuShortcut("Darwin", parseChord("mod+shift+s")), undefined);
  assert.equal(menuShortcut("Darwin", parseChord("f5")), undefined);
});

test("elsewhere the field only displays, so it takes the readable form", () => {
  assert.equal(menuShortcut("Windows", parseChord("mod+c")), "Ctrl + C");
  assert.equal(menuShortcut("Linux", parseChord("ctrl+shift+enter")), "Ctrl + Shift + Enter");
  assert.equal(menuShortcut("Windows", parseChord("f5")), "F5");
  assert.equal(menuShortcut("Linux", parseChord("shift+enter")), "Shift + Enter");
});

test("no chord means no shortcut rather than an empty one", () => {
  assert.equal(menuShortcut("Darwin", null), undefined);
  assert.equal(menuShortcut("Windows", undefined), undefined);
});

// --- structure ---

test("on macOS the application menu comes first, so File survives as a menu", () => {
  // Observed on a build, not deduced: macOS turns the *first* entry into the
  // application menu and absorbs its items. With File first there was no File
  // menu at all and New, Open and Save had disappeared into "build123d Studio".
  // This assertion is that bug.
  assert.deepEqual(
    menu("Darwin").map((entry) => entry.text),
    ["build123d Studio", "File", "View", "Edit", "Run"],
  );
});

test("elsewhere there is no application menu, so About and Settings go to Help", () => {
  for (const platform of ["Windows", "Linux"]) {
    assert.deepEqual(
      menu(platform).map((entry) => entry.text),
      ["File", "View", "Edit", "Run", "Help"],
      `${platform} should lead with File`,
    );
  }
});

test("About and Settings are reachable on every platform, wherever they sit", () => {
  for (const platform of ["Darwin", "Windows", "Linux"]) {
    const ids = menu(platform).flatMap((group) => group.menuItems.map((entry) => entry.id));
    assert.ok(ids.includes(MENU.ABOUT), `no About on ${platform}`);
    assert.ok(ids.includes(MENU.SETTINGS), `no Settings on ${platform}`);
  }
});

test("File carries the items tabs will need, separated into groups", () => {
  const file = submenu(menu("Darwin"), "menu.file");
  assert.deepEqual(
    file.map((entry) => entry.text),
    ["New", "Open File…", "Open Folder…", "-",
      "Save", "Save As…", "Save All", "-",
      "Close", "Close All", "Close Folder"],
  );
});

test("View carries the sidebar toggle", () => {
  const view = submenu(menu("Darwin"), "menu.view");
  assert.deepEqual(view.map((entry) => entry.text), ["Toggle Sidebar"]);
  assert.equal(view[0].id, MENU.TOGGLE_SIDEBAR);
});

test("Close Folder sits with the other closing commands", () => {
  // It closes every tab, like Close All directly above it, so it belongs in
  // the group about closing things rather than beside Open Folder.
  const file = submenu(menu("Linux"), "menu.file").map((entry) => entry.text);
  assert.ok(file.indexOf("Close Folder") > file.indexOf("Close All"));
  assert.ok(file.indexOf("Close Folder") > file.indexOf("Save All"));
});

test("Run is built from the keymap, so the two cannot drift", () => {
  const run = submenu(menu("Linux"), "menu.run");
  const items = run.filter((entry) => entry.text !== "-");

  assert.deepEqual(items.map((entry) => entry.id), RUN_COMMANDS.map((entry) => entry.id));
  assert.deepEqual(items.map((entry) => entry.text), RUN_COMMANDS.map((entry) => entry.label));
});

test("running part of a file, all of it, and debugging it are three groups", () => {
  // The only thing a menu can say about which items belong together. Nine flat
  // entries say nothing.
  const debugging = [
    { id: "debug.start", label: "Debug File" },
    { id: "debug.stepOver", label: "Step Over" },
    { id: "debug.continue", label: "Continue" },
  ];
  const run = submenu(menu("Linux", { runCommands: [...RUN_COMMANDS, ...debugging] }), "menu.run");

  assert.deepEqual(run.map((entry) => entry.id ?? "-"), [
    "run.cell", "run.cell.stay", "run.selectionOrLine",
    "-",
    "run.file",
    "-",
    "debug.start", "debug.stepOver", "debug.continue",
  ]);
});

test("a command the groups do not mention is appended rather than dropped", () => {
  // This table and keys.js are two lists that have to agree. The failure worth
  // preventing is a new command that silently never appears.
  const run = submenu(
    menu("Linux", { runCommands: [...RUN_COMMANDS, { id: "run.later", label: "Later" }] }),
    "menu.run",
  );

  assert.equal(run.at(-1).id, "run.later");
});

// --- roles ---

test("the clipboard items carry native roles where we ask for them", () => {
  const edit = submenu(menu("Darwin"), "menu.edit");
  assert.equal(find(edit, MENU.CUT).action, "cut:");
  assert.equal(find(edit, MENU.COPY).action, "copy:");
  assert.equal(find(edit, MENU.PASTE).action, "paste:");
});

test("without native clipboard the items carry no role at all", () => {
  // A role and a handler both firing would paste twice, so an item never has
  // both. Which one it gets is decided once, in menubar.js.
  const edit = submenu(menu("Windows", { nativeClipboard: false }), "menu.edit");
  for (const id of [MENU.CUT, MENU.COPY, MENU.PASTE]) {
    assert.equal(find(edit, id).action, undefined);
    assert.ok(find(edit, id).id, "it still has an id to dispatch on");
  }
});

test("nothing outside Edit ever gets a role", () => {
  for (const platform of ["Darwin", "Windows", "Linux"]) {
    for (const group of menu(platform)) {
      for (const entry of group.menuItems) {
        if (entry.id !== undefined && entry.id.startsWith("edit.")) {
          continue;
        }
        assert.equal(entry.action, undefined, `${entry.id ?? entry.text} has a role`);
      }
    }
  }
});

// --- items that are greyed out ---

test("what is disabled is whatever the caller says is disabled", () => {
  // This used to pin a fixed list of items group 2 had not built. They are all
  // built now, and what is greyed changes with the session - Close needs a tab,
  // Close Folder needs a project - so the mechanism is what is worth asserting.
  const away = new Set([MENU.SAVE_ALL, MENU.CLOSE, MENU.CLOSE_ALL, MENU.CLOSE_FOLDER]);
  const file = submenu(menu("Darwin", { isEnabled: (id) => !away.has(id) }), "menu.file");
  for (const id of away) {
    assert.equal(find(file, id).isDisabled, true, `${id} should be disabled`);
  }
  assert.equal(find(file, MENU.NEW).isDisabled, undefined, "New is always available");
  assert.equal(find(file, MENU.OPEN).isDisabled, undefined, "so is Open File");
});

test("nothing is disabled when everything is available", () => {
  // isDisabled is absent rather than false, because Neutralino reads the
  // presence of the field.
  const file = submenu(menu("Darwin", { isEnabled: () => true }), "menu.file");
  for (const entry of file.filter((candidate) => candidate.id !== undefined)) {
    assert.equal(entry.isDisabled, undefined, entry.text);
  }
});

test("every item is either a separator or has an id to dispatch on", () => {
  // An item with neither is unreachable: it cannot be clicked to any effect and
  // nothing would say so.
  for (const platform of ["Darwin", "Windows", "Linux"]) {
    for (const group of menu(platform)) {
      for (const entry of group.menuItems) {
        assert.ok(
          entry.text === "-" || typeof entry.id === "string",
          `${entry.text} has no id`,
        );
      }
    }
  }
});

test("every id is unique across the whole menu", () => {
  const seen = new Set();
  for (const group of menu("Darwin")) {
    for (const entry of group.menuItems) {
      if (entry.id === undefined) {
        continue;
      }
      assert.ok(!seen.has(entry.id), `${entry.id} appears twice`);
      seen.add(entry.id);
    }
  }
});

test("the run items show their shortcut where the platform can show one", () => {
  const chords = { "run.cell": parseChord("shift+enter"), "run.file": parseChord("f5") };
  const chordFor = (id) => chords[id] ?? null;

  const linux = submenu(menu("Linux", { chordFor }), "menu.run");
  assert.equal(find(linux, "run.cell").shortcut, "Shift + Enter");
  assert.equal(find(linux, "run.file").shortcut, "F5");

  // And stay silent on macOS, where neither chord can be expressed.
  const mac = submenu(menu("Darwin", { chordFor }), "menu.run");
  assert.equal(find(mac, "run.cell").shortcut, undefined);
  assert.equal(find(mac, "run.file").shortcut, undefined);
});

test("Settings shows as Command-comma on macOS and Ctrl + , elsewhere", () => {
  // The comma is spelt out in a chord string, but a menu has to show the
  // character - and macOS in particular takes the character literally.
  assert.equal(menuShortcut("Darwin", parseChord("mod+comma")), ",");
  assert.equal(menuShortcut("Windows", parseChord("mod+comma")), "Ctrl + ,");
});

// --- what macOS cannot be told through the shortcut field ---

test("a chord macOS cannot bind is written into the label instead", () => {
  // The field there is not a display string: it binds Command plus one
  // character, so Shift-Enter and F5 cannot go through it and a value picked to
  // look right would bind a chord nobody asked for.
  const built = menu("Darwin", { chordFor: (id) => parseChord(CHORDS[id] ?? null) });
  const runCell = find(submenu(built, "menu.run"), "run.cell");

  assert.equal(runCell.shortcut, undefined, "nothing is bound");
  assert.match(runCell.text, /^Run Cell {2}\(\u21e7\u21a9\)$/);
});

test("a chord it can bind stays in the accelerator column", () => {
  // Cmd plus one character is the one thing that works there, and it must not
  // also be written into the label - that would show the same chord twice.
  const built = menu("Darwin", {
    chordFor: (id) => (id === "file.save" ? parseChord("mod+s") : null),
  });
  const save = find(submenu(built, "menu.file"), "file.save");

  assert.equal(save.shortcut, "s");
  assert.equal(save.text, "Save");
});

test("Windows and Linux keep the real display shortcut and a plain label", () => {
  const built = menu("Linux", { chordFor: (id) => parseChord(CHORDS[id] ?? null) });
  const runCell = find(submenu(built, "menu.run"), "run.cell");

  assert.equal(runCell.shortcut, "Shift + Enter");
  assert.equal(runCell.text, "Run Cell");
});
