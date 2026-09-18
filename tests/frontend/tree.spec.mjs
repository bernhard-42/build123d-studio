// The file tree's own gestures: what a click does, and what the right-click
// actions do to a file that may be open in a tab.
//
// None of this is reachable from the pure tests in tree.test.mjs, which own the
// naming rules and the sorting. What is here is the half that needs rows, a
// pointer and a filesystem: selecting without opening, opening on the second
// click, and a rename that has to move a file on disk *and* take the tab
// holding it along - a buffer left pointing at the old name saves to a file
// nobody can see, and that save creates it again.

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = {
  [`${PROJECT}/part.py`]: "PART = 1\n",
  [`${PROJECT}/hinge.py`]: "HINGE = 1\n",
};
const WORKSPACE = { folder: PROJECT, tabs: [], active: null };

async function openApp(page, extra = {}) {
  return open(page, { files: FILES, settings: { workspace: WORKSPACE }, ...extra });
}

const row = (page, name) => page.locator(".tree-row", { hasText: name }).first();
const tabLabels = (page) =>
  page.locator(".tab-label").allTextContents();
const onDisk = (page, path) =>
  page.evaluate((p) => globalThis.__NEUTRALINO_STUB__.wrote(p), path);

test.describe("clicking a file", () => {
  test("opens it, and the open file is the one the tree marks", async ({ page }) => {
    // Either one file is marked - the one on screen - or none is. Opening is
    // what marks it; there is no second, separate idea of a selected file.
    await openApp(page);

    await row(page, "hinge.py").click();

    await expect.poll(() => tabLabels(page)).toContain("hinge.py");
    await expect(row(page, "hinge.py")).toHaveClass(/tree-active/);
    await expect(row(page, "part.py")).not.toHaveClass(/tree-active/);
  });

  test("a click opens a CAD file like any other; Show in its menu imports it", async ({ page }) => {
    // A STEP or an SVG is text, and sometimes the point is to edit it - so a
    // click opens it in the editor, as a click does for everything. Showing
    // is the row menu's, for the files build123d can import; the lines that
    // run are echoed into the console, and _imported is the user's to keep.
    // Proof, at writing: with the "show" item removed from showRowMenu, this
    // fails on the menu having no Show.
    const { sidecar } = await openApp(page, {
      files: { ...FILES, [`${PROJECT}/frame.step`]: "ISO-10303-21;\n", [`${PROJECT}/logo.svg`]: "<svg/>\n" },
    });

    await row(page, "logo.svg").click();
    await expect.poll(() => tabLabels(page)).toContain("logo.svg");
    expect(sidecar.received.filter((frame) => frame.type === "kernel.execute")).toHaveLength(0);

    await row(page, "frame.step").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Show" }).click();

    await sidecar.waitFor("kernel.execute");
    await expect
      .poll(() => sidecar.received.filter((frame) => frame.type === "kernel.execute").length)
      .toBe(2);
    const sent = sidecar.received.filter((frame) => frame.type === "kernel.execute").map((f) => f.code);
    expect(sent).toEqual([
      "# Importing frame.step ...",
      "from build123d import import_step; from build123d_studio import show, Camera; " +
        `_imported = import_step("${PROJECT}/frame.step"); show(_imported, reset_camera=Camera.RESET)`,
    ]);
    expect(await tabLabels(page)).not.toContain("frame.step");

    // A Python file's menu has no Show.
    await row(page, "part.py").click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(page.locator(".context-menu-item", { hasText: "Show" })).toHaveCount(0);
  });

  test("the filter box narrows the tree to what has been opened: a name, or an extension", async ({ page }) => {
    // Proof, at writing: with filteredEntries replaced by the plain listing
    // in rowsUnder, this fails on the count after typing.
    await openApp(page, {
      files: { ...FILES, [`${PROJECT}/exports/bus.stl`]: "solid bus\n" },
    });
    const names = () => page.locator(".tree-row").allTextContents();
    await expect.poll(() => names()).toEqual(expect.arrayContaining(["exports", "hinge.py", "part.py"]));

    const box = page.locator("#tree-filter");
    await box.fill("HINGE");
    // hinge.py, and the folder that has never been read - nothing is known
    // about what it holds, so it stays.
    await expect(page.locator(".tree-row")).toHaveCount(2);
    expect(await names()).toEqual(expect.arrayContaining(["exports", "hinge.py"]));
    await expect(page.locator(".tree-row", { hasText: "part.py" })).toHaveCount(0);

    // An extension: both scripts, and the unread folder.
    await box.fill(".py");
    await expect(page.locator(".tree-row")).toHaveCount(3);

    // Open the folder under the filter: only what matches shows in it, and
    // with nothing matching the folder itself goes.
    await row(page, "exports").click();
    await expect(page.locator(".tree-row", { hasText: "bus.stl" })).toHaveCount(0);
    await expect(page.locator(".tree-row", { hasText: "exports" })).toHaveCount(0);

    await box.fill(".stl");
    await expect(page.locator(".tree-row")).toHaveCount(2);
    expect(await names()).toEqual(expect.arrayContaining(["exports", "bus.stl"]));

    await box.fill("zzz");
    await expect(page.locator(".tree-empty")).toContainText('No file matches "zzz"');

    await box.press("Escape");
    await expect(box).toHaveValue("");
    await expect(page.locator(".tree-row")).toHaveCount(4);
  });

  test("but a right click opens nothing", async ({ page }) => {
    // The difference that makes the menu usable on a file somebody has no
    // intention of opening.
    await openApp(page);

    await row(page, "hinge.py").click({ button: "right" });

    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(row(page, "hinge.py")).toHaveClass(/tree-selected/);
    expect(await tabLabels(page)).not.toContain("hinge.py");
  });

  test("and its mark comes off when the menu is dismissed", async ({ page }) => {
    await openApp(page);
    await row(page, "hinge.py").click({ button: "right" });
    await expect(row(page, "hinge.py")).toHaveClass(/tree-selected/);

    await page.keyboard.press("Escape");

    await expect(page.locator(".context-menu")).toHaveCount(0);
    await expect(row(page, "hinge.py")).not.toHaveClass(/tree-selected/);
  });

  test("and when the rename it started is done", async ({ page }) => {
    await openApp(page);
    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();
    await page.locator("#tree-new-name").fill("pivot.py");
    await page.locator("#tree-new-name").press("Enter");

    await expect(row(page, "pivot.py")).toBeVisible();
    await expect(row(page, "pivot.py")).not.toHaveClass(/tree-selected/);
  });

  test("and when that rename is abandoned", async ({ page }) => {
    await openApp(page);
    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();
    await page.locator("#tree-new-name").press("Escape");

    await expect(row(page, "hinge.py")).not.toHaveClass(/tree-selected/);
  });

  test("the file on screen keeps its mark while another is right-clicked", async ({ page }) => {
    // Two marks, and they mean different things: a bar down the left edge for
    // the file being edited, the row picked out for what the menu is about.
    await openApp(page);
    await row(page, "part.py").click();
    await expect(row(page, "part.py")).toHaveClass(/tree-active/);

    await row(page, "hinge.py").click({ button: "right" });

    await expect(row(page, "part.py")).toHaveClass(/tree-active/);
    await expect(row(page, "hinge.py")).toHaveClass(/tree-selected/);
  });
});

test.describe("the right-click actions on a file", () => {
  test("rename moves it on disk", async ({ page }) => {
    await openApp(page);

    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();
    const field = page.locator("#tree-new-name");
    await expect(field).toBeFocused();
    await field.fill("pivot.py");
    await field.press("Enter");

    await expect.poll(() => onDisk(page, `${PROJECT}/pivot.py`)).toBe("HINGE = 1\n");
    await expect.poll(() => onDisk(page, `${PROJECT}/hinge.py`)).toBe(undefined);
    await expect(row(page, "pivot.py")).toBeVisible();
  });

  test("and the tab holding it follows the rename", async ({ page }) => {
    // The half that costs work rather than tidiness: a buffer still pointing at
    // the old name writes there on the next save, recreating the file that was
    // just renamed away.
    await openApp(page);
    await row(page, "hinge.py").click();
    await expect.poll(() => tabLabels(page)).toContain("hinge.py");

    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();
    await page.locator("#tree-new-name").fill("pivot.py");
    await page.locator("#tree-new-name").press("Enter");

    await expect.poll(() => tabLabels(page)).toContain("pivot.py");
    expect(await tabLabels(page)).not.toContain("hinge.py");
  });

  test("a name already taken is refused rather than overwriting", async ({ page }) => {
    await openApp(page);

    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();
    await page.locator("#tree-new-name").fill("part.py");
    await page.locator("#tree-new-name").press("Enter");

    // The name is refused in the row, so the field stays open and part.py is
    // untouched.
    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toBe("PART = 1\n");
    await expect.poll(() => onDisk(page, `${PROJECT}/hinge.py`)).toBe("HINGE = 1\n");
  });

  test("delete moves it to the trash rather than removing it", async ({ page }) => {
    await openApp(page);

    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    expect(await page.locator(".confirm-overlay").innerText()).toContain("Trash");
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect
      .poll(() => page.evaluate(() =>
        globalThis.__NEUTRALINO_STUB__.calls()
          .filter((call) => call.name === "trashItem")
          .map((call) => call.args[0])),
      { message: "it was not put in the trash" })
      .toContain(`${PROJECT}/hinge.py`);
    await expect.poll(() => onDisk(page, `${PROJECT}/hinge.py`)).toBe(undefined);
  });

  test("cancelling the prompt leaves the file alone", async ({ page }) => {
    await openApp(page);

    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();
    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    await expect.poll(() => onDisk(page, `${PROJECT}/hinge.py`)).toBe("HINGE = 1\n");
  });

  test("no trash means a second question, not a silent delete", async ({ page }) => {
    // "Move to Trash" was the question that was answered. Removing it from disk
    // when that turns out to be impossible answers a different one.
    await openApp(page, { trashFails: true });

    await row(page, "hinge.py").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    const second = page.locator(".confirm-overlay");
    await expect(second).toBeVisible();
    expect(await second.innerText()).toContain("cannot be undone");
    await expect.poll(() => onDisk(page, `${PROJECT}/hinge.py`)).toBe("HINGE = 1\n");

    await second.locator('[data-answer="save"]').click();
    await expect.poll(() => onDisk(page, `${PROJECT}/hinge.py`)).toBe(undefined);
  });

  test("a folder offers neither", async ({ page }) => {
    // Deleting a folder is recursive and renaming one moves everything under
    // it; both are different questions from these.
    await openApp(page, { files: { ...FILES, [`${PROJECT}/parts/bolt.py`]: "BOLT = 1\n" } });

    await row(page, "parts").click({ button: "right" });

    await expect(page.locator(".context-menu")).toHaveCount(0);
  });
});

test.describe("watching the folder", () => {
  // The tree used to be a photograph: what was on disk when it was read, until
  // somebody pressed Refresh. A project is written to from outside constantly -
  // a script that exports a STEP file, a git checkout, another editor - and a
  // tree that disagrees with the disk is worse than no tree, because it is
  // believed.

  const calls = (page, name) =>
    page.evaluate(
      (wanted) => globalThis.__NEUTRALINO_STUB__.calls().filter((call) => call.name === wanted),
      name,
    );

  test("opening a folder starts one watcher on it", async ({ page }) => {
    await openApp(page);

    const made = await calls(page, "createWatcher");
    expect(made).toHaveLength(1);
    expect(made[0].args[0]).toBe(PROJECT);
  });

  test("a file that appears on disk appears in the tree", async ({ page }) => {
    await openApp(page);
    await expect(row(page, "part.py")).toBeVisible();

    await page.evaluate((project) => {
      globalThis.__NEUTRALINO_STUB__.given(`${project}/exported.py`, "EXPORTED = 1\n");
      globalThis.__NEUTRALINO_STUB__.emit("watchFile", {
        id: 1, dir: project, filename: "exported.py", action: "add",
      });
    }, PROJECT);

    await expect(row(page, "exported.py")).toBeVisible();
  });

  test("and one that goes away leaves it", async ({ page }) => {
    await openApp(page);
    await expect(row(page, "hinge.py")).toBeVisible();

    await page.evaluate((project) => {
      globalThis.__NEUTRALINO_STUB__.removePath(`${project}/hinge.py`);
      globalThis.__NEUTRALINO_STUB__.emit("watchFile", {
        id: 1, dir: project, filename: "hinge.py", action: "delete",
      });
    }, PROJECT);

    await expect(page.locator(".tree-row", { hasText: "hinge.py" })).toHaveCount(0);
  });

  test("a burst of changes is one refresh, not one each", async ({ page }) => {
    // A checkout or a build arrives as dozens of events. Re-reading per event
    // would read the same directories over and over while the burst was still
    // arriving.
    await openApp(page);
    const before = (await calls(page, "readDirectory")).length;

    await page.evaluate((project) => {
      for (let i = 0; i < 20; i += 1) {
        globalThis.__NEUTRALINO_STUB__.given(`${project}/b${i}.py`, "B = 1\n");
        globalThis.__NEUTRALINO_STUB__.emit("watchFile", {
          id: 1, dir: project, filename: `b${i}.py`, action: "add",
        });
      }
    }, PROJECT);

    await expect(row(page, "b19.py")).toBeVisible();
    const after = (await calls(page, "readDirectory")).length;
    expect(after - before, "the tree was re-read once per event").toBeLessThanOrEqual(2);
  });

  test("closing the folder stops the watcher", async ({ page }) => {
    await openApp(page);

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.closeFolder" }),
    );

    await expect.poll(async () => (await calls(page, "removeWatcher")).length).toBe(1);
    const [stopped] = (await calls(page, "removeWatcher"))[0].args;
    expect(stopped).toBe((await calls(page, "createWatcher")).length);
  });

  test("and an event from a watcher that is not ours changes nothing", async ({ page }) => {
    // With the same event under our own id at the end, because otherwise this
    // passes just as well against an application that watches nothing at all.
    await openApp(page);
    const before = (await calls(page, "readDirectory")).length;

    await page.evaluate((project) => {
      globalThis.__NEUTRALINO_STUB__.given(`${project}/other.py`, "OTHER = 1\n");
      globalThis.__NEUTRALINO_STUB__.emit("watchFile", {
        id: 99, dir: project, filename: "other.py", action: "add",
      });
    }, PROJECT);

    await page.waitForTimeout(600);
    expect((await calls(page, "readDirectory")).length).toBe(before);
    await expect(page.locator(".tree-row", { hasText: "other.py" })).toHaveCount(0);

    await page.evaluate((project) => {
      globalThis.__NEUTRALINO_STUB__.emit("watchFile", {
        id: 1, dir: project, filename: "other.py", action: "add",
      });
    }, PROJECT);

    await expect(row(page, "other.py")).toBeVisible();
  });
});

test.describe("a directory opened a second time", () => {
  /**
   * M35, on all three platforms. A collapsed directory is deliberately skipped
   * by refreshSidebar - watching one nobody can see is work spent on nothing -
   * so opening it is the moment its listing has to be asked for again. It was
   * read only the first time it was ever opened, and kept for the life of the
   * project: a file written into it while it was closed never appeared however
   * often it was drilled into, a deleted one stayed, and a rename showed both
   * names at once.
   *
   * The other program here is the stub writing the directory directly, which is
   * what a terminal, a git checkout or an export from another application does.
   */
  const NESTED = `${PROJECT}/schnaddel`;

  async function withNested(page) {
    return open(page, {
      files: { ...FILES, [`${NESTED}/first.py`]: "FIRST = 1\n" },
      settings: { workspace: WORKSPACE },
    });
  }

  test("shows what is in it now, not what was in it the first time", async ({ page }) => {
    await withNested(page);

    await row(page, "schnaddel").click();
    await expect(row(page, "first.py")).toBeVisible();
    await row(page, "schnaddel").click();
    await expect(row(page, "first.py")).toHaveCount(0);

    // Written while the directory is closed, so nothing is expected to happen
    // on screen until it is opened again.
    await page.evaluate(
      (p) => globalThis.__NEUTRALINO_STUB__.given(p, "SECOND = 1\n"),
      `${NESTED}/second.py`,
    );

    await row(page, "schnaddel").click();

    await expect(row(page, "second.py"), "the listing was the one read the first time")
      .toBeVisible();
  });

  test("and a file removed while it was closed is gone from it", async ({ page }) => {
    await withNested(page);

    await row(page, "schnaddel").click();
    await expect(row(page, "first.py")).toBeVisible();
    await row(page, "schnaddel").click();

    await page.evaluate(
      (p) => globalThis.__NEUTRALINO_STUB__.removePath(p),
      `${NESTED}/first.py`,
    );

    await row(page, "schnaddel").click();

    await expect(row(page, "first.py"), "a deleted file survived in the tree").toHaveCount(0);
  });
});

test.describe("opening a file gives it the keyboard", () => {
  /**
   * Monaco draws no cursor while it does not have focus, so a file opened from
   * the tree arrived on screen with no caret and nothing to type into - the
   * click that opened it had left the focus on the tree row. The menu's Open
   * File had the same end for a different reason: the focus was put back before
   * the buffer existed, and an editor with no model cannot take it.
   *
   * Asserted through the editor's textarea, which is what "the editor has the
   * keyboard" means in Monaco.
   */
  test("clicking a file in the tree focuses the editor", async ({ page }) => {
    await openApp(page);

    await row(page, "hinge.py").click();

    await expect(page.locator(".tab-active .tab-label")).toHaveText("hinge.py");
    await expect(page.locator(".monaco-editor textarea")).toBeFocused();
  });

  test("and so does typing into it straight away", async ({ page }) => {
    // The point of the focus, rather than the focus itself: what is typed next
    // has to land in the file that was just opened.
    await openApp(page);
    await row(page, "hinge.py").click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("hinge.py");

    await page.keyboard.type("MINE");

    await expect(page.locator(".monaco-editor .view-lines")).toContainText("MINE");
  });
});

test.describe("a Makefile's row", () => {
  const MAKEFILE = [
    ".PHONY: build test",
    "VERSION := 1",
    "build:",
    "\techo building",
    "test: build",
    "\tpytest",
    "",
  ].join("\n");
  const withMakefile = { files: { ...FILES, [`${PROJECT}/Makefile`]: MAKEFILE } };
  const entries = (page) => page.locator(".context-menu-item", { hasText: "Make ▸" });

  test("offers each target below a line, and picking one runs it", async ({ page }) => {
    // Flat rather than a submenu, by request: a right-click on a Makefile is
    // asking for exactly this list. The harness sidecar answers run.tool with
    // present, which is what a machine with make does.
    const { sidecar } = await openApp(page, withMakefile);

    await row(page, "Makefile").click({ button: "right" });

    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(entries(page)).toHaveText(["Make ▸ build", "Make ▸ test"]);
    await expect(page.locator(".context-menu .context-menu-separator")).toHaveCount(1);
    // The file actions stay, above the line.
    await expect(page.locator(".context-menu-item", { hasText: "Rename" })).toHaveCount(1);

    await page.locator(".context-menu-item", { hasText: "Make ▸ test" }).click();

    const frame = await sidecar.waitFor("run.make");
    expect(frame.makefile).toBe(`${PROJECT}/Makefile`);
    expect(frame.target).toBe("test");
  });

  test("while a target runs, Stop is on screen and ends it", async ({ page }) => {
    // The answer to "how do I stop this": the Run/Debug bar comes up with Stop
    // as its one control, for a make run as for a file. Pressing it sends
    // run.stop, and the bar goes with it.
    const { sidecar } = await openApp(page, withMakefile);

    await row(page, "Makefile").click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Make ▸ test" }).click();
    await sidecar.waitFor("run.make");

    const stop = page.locator("#debug-stop");
    await expect(page.locator("#pane-debug")).toBeVisible();
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    for (const id of ["debug-continue", "debug-step-over", "debug-step-into", "debug-step-out"]) {
      await expect(page.locator(`#${id}`)).toBeHidden();
    }

    await stop.click();

    await sidecar.waitFor("run.stop");
    await expect(page.locator("#debug-bar")).toBeHidden();
  });

  test("the Makefile is read at every right-click, so an edit shows at the next one", async ({ page }) => {
    // Nothing about the file is remembered - only that make is here. A target
    // added in a terminal is in the menu the next time it opens.
    await openApp(page, withMakefile);

    await row(page, "Makefile").click({ button: "right" });
    await expect(entries(page)).toHaveText(["Make ▸ build", "Make ▸ test"]);
    await page.keyboard.press("Escape");

    await page.evaluate(
      ([path, text]) => globalThis.__NEUTRALINO_STUB__.given(path, text),
      [`${PROJECT}/Makefile`, `${MAKEFILE}release: test\n\tsh release.sh\n`],
    );
    await row(page, "Makefile").click({ button: "right" });

    await expect(entries(page)).toHaveText(["Make ▸ build", "Make ▸ test", "Make ▸ release"]);
  });

  test("other files get no Make entries", async ({ page }) => {
    await openApp(page, withMakefile);

    await row(page, "part.py").click({ button: "right" });

    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator(".context-menu .context-menu-separator")).toHaveCount(0);
  });

  test("without make on this machine the row is a file like any other - until make answers", async ({ page }) => {
    // The sidecar says whether make is on the PATH a run gets. And absence is
    // not remembered: the next right-click asks again, which is what stops
    // one bad moment deciding the session - see tools.js, and the git case
    // it was written for.
    const { sidecar } = await openApp(page, withMakefile);

    let installed = false;
    sidecar.answer("run.tool", (frame) => ({ name: frame.name, present: installed }));
    await row(page, "Makefile").click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(entries(page)).toHaveCount(0);
    await page.keyboard.press("Escape");

    installed = true;
    await row(page, "Makefile").click({ button: "right" });
    await expect(entries(page)).toHaveText(["Make ▸ build", "Make ▸ test"]);
    expect(sidecar.received.filter((f) => f.type === "run.tool")).toHaveLength(2);
  });
});

test.describe("a picture in the tree", () => {
  // A 2x3 PNG, red over green: the bytes of a real file rather than a name,
  // so that the picture *drawing* is what the test holds - a blob URL that
  // points at nothing gives an <img> with no size.
  const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2,
    0, 0, 0, 54, 136, 73, 214, 0, 0, 0, 16, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 68, 12, 40, 20,
    0, 68, 208, 5, 251, 164, 207, 222, 128, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  const SHOT = `${PROJECT}/shot.png`;

  async function openWithPicture(page) {
    // Listed at open with a placeholder, then replaced by the bytes: the
    // harness seeds strings, and the tree only needs the name to list it.
    const handles = await openApp(page, { files: { ...FILES, [SHOT]: "placeholder" } });
    await page.evaluate(
      ([path, bytes]) => globalThis.__NEUTRALINO_STUB__.given(path, new Uint8Array(bytes).buffer),
      [SHOT, PNG],
    );
    return handles;
  }

  test("opens in a tab that shows it, with no editor behind", async ({ page }) => {
    await openWithPicture(page);

    await row(page, "shot.png").click();

    await expect.poll(() => tabLabels(page)).toContain("shot.png");
    const picture = page.locator("#image-host img");
    await expect(page.locator("#image-host")).toBeVisible();
    await expect(picture).toHaveAttribute("src", /^blob:/);
    // Decoded, which is the claim: the bytes reached the page as a PNG.
    await expect.poll(() => picture.evaluate((img) => img.naturalWidth)).toBe(2);
    await expect(page.locator("#editor-host")).toBeHidden();
  });

  test("switching back to a text tab brings the editor back", async ({ page }) => {
    await openWithPicture(page);
    // Kept, or the single click on the picture would replace it - see the
    // preview tabs below.
    await row(page, "part.py").dblclick();
    await expect.poll(() => tabLabels(page)).toContain("part.py");

    await row(page, "shot.png").click();
    await expect(page.locator("#image-host")).toBeVisible();

    await page.locator(".tab", { hasText: "part.py" }).click();

    await expect(page.locator("#image-host")).toBeHidden();
    await expect(page.locator("#editor-host")).toBeVisible();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("PART = 1");
  });

  test("Save writes nothing over it, and it is never dirty", async ({ page }) => {
    // The one thing this tab must never do. Its model is empty, and a save
    // that wrote it would replace the picture with nothing.
    await openWithPicture(page);
    await row(page, "shot.png").click();
    await expect(page.locator("#image-host")).toBeVisible();

    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(300);

    const stored = await page.evaluate(
      (path) => globalThis.__NEUTRALINO_STUB__.wrote(path),
      SHOT,
    );
    expect(typeof stored, "the picture was written as text").not.toBe("string");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
  });

  test("closing the tab frees it, and it opens again", async ({ page }) => {
    await openWithPicture(page);
    await row(page, "shot.png").click();
    await expect(page.locator("#image-host")).toBeVisible();

    await page.locator(".tab", { hasText: "shot.png" }).locator(".tab-close").click();

    await expect(page.locator("#image-host")).toBeHidden();
    await row(page, "shot.png").click();
    await expect(page.locator("#image-host")).toBeVisible();
    await expect.poll(() => page.locator("#image-host img").evaluate((img) => img.naturalWidth)).toBe(2);
  });
});

test.describe("preview tabs", () => {
  // VS Code's rule, adopted after clicking through a folder of pictures left
  // a strip full of them: a single click opens the tab the next single click
  // replaces, and a double-click, an edit or a double-click on the tab keeps it.
  const THREE = {
    files: { ...FILES, [`${PROJECT}/third.py`]: "THIRD = 1\n" },
  };
  const previewTabs = (page) => page.locator(".tab.tab-preview .tab-label").allTextContents();
  // The strip minus the Untitled buffer a start with no tabs opens; these
  // tests are about the files clicked in the tree.
  const fileTabs = async (page) => (await tabLabels(page)).filter((label) => label !== "Untitled");

  test("a single click previews, and the next single click replaces it", async ({ page }) => {
    await openApp(page, THREE);

    await row(page, "part.py").click();
    await expect.poll(() => fileTabs(page)).toEqual(["part.py"]);
    await expect.poll(() => previewTabs(page)).toEqual(["part.py"]);

    await row(page, "hinge.py").click();

    await expect.poll(() => fileTabs(page)).toEqual(["hinge.py"]);
    await expect.poll(() => previewTabs(page)).toEqual(["hinge.py"]);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("HINGE = 1");
  });

  test("a double-click keeps the tab, so the next single click adds one", async ({ page }) => {
    await openApp(page, THREE);

    await row(page, "part.py").dblclick();
    await expect.poll(() => fileTabs(page)).toEqual(["part.py"]);
    await expect.poll(() => previewTabs(page)).toEqual([]);

    await row(page, "hinge.py").click();

    await expect.poll(() => fileTabs(page)).toEqual(["part.py", "hinge.py"]);
    await expect.poll(() => previewTabs(page)).toEqual(["hinge.py"]);
  });

  test("typing into a preview keeps it", async ({ page }) => {
    await openApp(page, THREE);
    await row(page, "part.py").click();
    await expect.poll(() => previewTabs(page)).toEqual(["part.py"]);

    await page.keyboard.type("X");
    await expect.poll(() => previewTabs(page)).toEqual([]);

    await row(page, "hinge.py").click();
    await expect.poll(() => fileTabs(page)).toEqual(["part.py", "hinge.py"]);
  });

  test("double-clicking the tab keeps it, and a single click on a kept file does not demote it", async ({ page }) => {
    await openApp(page, THREE);
    await row(page, "part.py").click();
    await expect.poll(() => previewTabs(page)).toEqual(["part.py"]);

    await page.locator(".tab", { hasText: "part.py" }).dblclick();
    await expect.poll(() => previewTabs(page)).toEqual([]);

    // Kept stays kept when clicked once in the tree.
    await row(page, "part.py").click();
    await expect.poll(() => previewTabs(page)).toEqual([]);
    await row(page, "hinge.py").click();
    await expect.poll(() => fileTabs(page)).toEqual(["part.py", "hinge.py"]);
  });

  test("the preview survives a restart as a preview", async ({ page }) => {
    // The workspace remembers which tab was the preview, so a session that
    // ends with one comes back with one - and the first single click after
    // the restart replaces it rather than adding to it.
    await openApp(page, {
      ...THREE,
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [
            { path: `${PROJECT}/part.py`, caret: null, preview: false },
            { path: `${PROJECT}/hinge.py`, caret: null, preview: true },
          ],
          active: `${PROJECT}/hinge.py`,
        },
      },
    });
    await expect.poll(() => fileTabs(page)).toEqual(["part.py", "hinge.py"]);
    await expect.poll(() => previewTabs(page)).toEqual(["hinge.py"]);

    await row(page, "third.py").click();

    await expect.poll(() => fileTabs(page)).toEqual(["part.py", "third.py"]);
  });

  test("a picture left open comes back as a picture, not as its bytes", async ({ page }) => {
    // Restore read every remembered tab as text. A PNG read that way is a
    // buffer of its bytes with an editor behind it - and a Save that writes
    // them back as such.
    const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2,
      0, 0, 0, 54, 136, 73, 214, 0, 0, 0, 16, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 68, 12, 40, 20,
      0, 68, 208, 5, 251, 164, 207, 222, 128, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
    const SHOT = `${PROJECT}/shot.png`;
    // The bytes themselves, seeded before the page loads: restore reads them.
    await openApp(page, {
      files: { ...FILES, [SHOT]: PNG },
      settings: {
        workspace: { folder: PROJECT, tabs: [{ path: SHOT, caret: null, preview: false }], active: SHOT },
      },
    });

    await expect.poll(() => fileTabs(page)).toEqual(["shot.png"]);
    await expect(page.locator("#image-host")).toBeVisible();
    await expect(page.locator("#editor-host")).toBeHidden();
  });
});
