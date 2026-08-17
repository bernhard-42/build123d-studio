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
