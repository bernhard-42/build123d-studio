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
