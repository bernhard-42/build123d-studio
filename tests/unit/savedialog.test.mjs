// node --test tests/unit/savedialog.test.mjs
//
// The Save As panel, and the one platform that needs its own script.
//
// What was wrong: Neutralino's showSaveDialog takes a single `defaultPath`, and
// its macOS implementation turns that into AppleScript's `default name` for
// anything that is not a directory. Save As passes the file being saved, so the
// panel opened with "/Users/bernhard/Desktop/test/notes.py" typed into the name
// field. It is not reachable from node - it is a dialog - so what is tested here
// is the script that asks for it, which is where the bug lived.
//
// Un-applied by going back to os.showSaveDialog with the full path: the first
// test fails on the name, and the Darwin tests fail on there being no script at
// all.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  chooseSaveName,
  pathFromOutput,
  quoteApplescript,
  saveCommand,
  saveScript,
} from "../../src/savedialog.js";

/** An `os` that records what it was asked and answers with what it is told. */
function fakeOs({ stdOut = "", exitCode = 0, throws = null, dialog = "" } = {}) {
  const asked = { commands: [], dialogs: [] };
  return {
    asked,
    execCommand(command) {
      asked.commands.push(command);
      if (throws !== null) {
        return Promise.reject(throws);
      }
      return Promise.resolve({ pid: 1, stdOut, stdErr: "", exitCode });
    },
    showSaveDialog(title, options) {
      asked.dialogs.push({ title, options });
      return Promise.resolve(dialog);
    },
  };
}

const quiet = { warn() {}, info() {}, error() {} };

test("the name field gets the file name and the panel opens in its folder", async () => {
  const os = fakeOs({ stdOut: "/Users/b/Desktop/test/notes2.py\n" });
  const chosen = await chooseSaveName({ os, log: quiet, platform: "Darwin" }, "Save", {
    folder: "/Users/b/Desktop/test",
    name: "notes.py",
    filters: [],
  });

  assert.equal(chosen, "/Users/b/Desktop/test/notes2.py");
  const [command] = os.asked.commands;
  assert.match(command, /default name "notes\.py"/);
  assert.match(command, /default location \(POSIX file "\/Users\/b\/Desktop\/test" as alias\)/);
  // The regression itself: the whole path must never be the name.
  assert.ok(
    !command.includes(`default name "/Users/b/Desktop/test/notes.py"`),
    `the full path went into the name field: ${command}`,
  );
  assert.equal(os.asked.dialogs.length, 0, "it went through Neutralino's dialog anyway");
});

test("an unnamed buffer asks for a folder and no name", () => {
  const lines = saveScript({ title: "Save", name: null, folder: "/Users/b/Documents" }).join("\n");
  assert.ok(!lines.includes("default name"), lines);
  assert.match(lines, /default location \(POSIX file "\/Users\/b\/Documents" as alias\)/);
});

test("cancel is an empty path rather than an error", async () => {
  // What the script's `on error number -128` branch puts on stdout.
  const os = fakeOs({ stdOut: "\n" });
  const chosen = await chooseSaveName({ os, log: quiet, platform: "Darwin" }, "Save", {
    folder: "/Users/b", name: "notes.py", filters: [],
  });
  assert.equal(chosen, "");
});

test("a panel that could not be opened falls back to the built-in dialog", async () => {
  // A remembered folder that has been deleted since is how this is reached:
  // `as alias` raises on it and nothing opens. Losing the save instead would be
  // losing somebody's work to a missing directory.
  const os = fakeOs({ exitCode: 1, dialog: "/Users/b/notes.py" });
  const chosen = await chooseSaveName({ os, log: quiet, platform: "Darwin" }, "Save", {
    folder: "/gone", name: "notes.py", filters: [],
  });

  assert.equal(chosen, "/Users/b/notes.py");
  assert.equal(os.asked.dialogs.length, 1);
  assert.equal(os.asked.dialogs[0].options.defaultPath, "/gone/notes.py");
});

test("osascript refusing to run at all falls back too", async () => {
  const os = fakeOs({ throws: new Error("no such command"), dialog: "/Users/b/notes.py" });
  const chosen = await chooseSaveName({ os, log: quiet, platform: "Darwin" }, "Save", {
    folder: "/Users/b", name: "notes.py", filters: [],
  });
  assert.equal(chosen, "/Users/b/notes.py");
});

test("every other platform keeps Neutralino's dialog and the full path", async () => {
  // A Win32 save dialog splits a full path into folder and name itself, so
  // there is nothing to fix there and nothing to change.
  for (const platform of ["Windows", "Linux"]) {
    const os = fakeOs({ dialog: "C:\\parts\\notes.py" });
    const chosen = await chooseSaveName({ os, log: quiet, platform }, "Save", {
      folder: "/parts", name: "notes.py", filters: [{ name: "Python", extensions: ["py"] }],
    });
    assert.equal(chosen, "C:\\parts\\notes.py");
    assert.equal(os.asked.commands.length, 0, `${platform} ran a script`);
    assert.equal(os.asked.dialogs[0].options.defaultPath, "/parts/notes.py");
    assert.equal(os.asked.dialogs[0].options.filters.length, 1, "filters were dropped");
  }
});

test("a Windows path is rebuilt with the separator it arrived with", async () => {
  // The two halves came from splitting one path, so putting them back with "/"
  // would hand a Windows dialog `C:\\parts/notes.py` - accepted there, and a
  // needless difference from the string the application was given.
  const os = fakeOs({ dialog: "" });
  await chooseSaveName({ os, log: quiet, platform: "Windows" }, "Save", {
    folder: "C:\\parts", name: "notes.py", filters: [],
  });
  assert.equal(os.asked.dialogs[0].options.defaultPath, "C:\\parts\\notes.py");

  // And a file at the root of a volume keeps its one separator rather than two.
  const posix = fakeOs({ dialog: "" });
  await chooseSaveName({ os: posix, log: quiet, platform: "Linux" }, "Save", {
    folder: "/", name: "notes.py", filters: [],
  });
  assert.equal(posix.asked.dialogs[0].options.defaultPath, "/notes.py");
});

test("cancelling the built-in dialog is an empty path, whatever it returned", async () => {
  // Neutralino documents a string and returns undefined on cancel.
  const os = { showSaveDialog: () => Promise.resolve(undefined) };
  const chosen = await chooseSaveName({ os, log: quiet, platform: "Linux" }, "Save", {
    folder: "/parts", name: "notes.py", filters: [],
  });
  assert.equal(chosen, "");
});

test("a quote in a file name cannot end the AppleScript string", () => {
  assert.equal(quoteApplescript(`od"d`), `od\\"d`);
  // Backslash first, or the escape added for the quote is escaped in turn.
  assert.equal(quoteApplescript(`back\\slash"`), `back\\\\slash\\"`);
  const lines = saveScript({ title: "Save", name: `od"d.py`, folder: null }).join("\n");
  assert.match(lines, /default name "od\\"d\.py"/);
});

test("a single quote cannot end the shell argument either", () => {
  // The same value twice: it is quoted for AppleScript inside the line, and the
  // line is quoted for /bin/sh around it.
  const command = saveCommand(saveScript({ title: "Save", name: "o'brien.py", folder: null }));
  assert.match(command, /^osascript -e /);
  assert.ok(command.includes(`'\\''`), `the single quote was not escaped: ${command}`);
});

test("a trailing space in a file name survives", () => {
  // macOS allows it, and trim() would have saved to a different file.
  assert.equal(pathFromOutput("/Users/b/notes .py \n"), "/Users/b/notes .py ");
  assert.equal(pathFromOutput("/Users/b/notes.py\r\n"), "/Users/b/notes.py");
  assert.equal(pathFromOutput(""), "");
});
