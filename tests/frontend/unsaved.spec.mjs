/** Asking about unsaved work: once, about everything, or not at all.
 *
 * This is the part of the application where a mistake costs somebody's work,
 * and Phase 2 exists partly because it used to. Group 2 then rewrote it from
 * one buffer to many, which is the single change in that group that could lose
 * edits - so it is the one most worth holding down.
 *
 * Every case here is stated as what the user sees and what ends up on disk,
 * never as which function was called. "The file on disk has the edit in it" is
 * the only assertion that cannot be satisfied by a save path that reports
 * success and writes nothing, which is a defect this project has had.
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";

const FILES = {
  [`${PROJECT}/part.py`]: "PART = 1\n",
  [`${PROJECT}/plate.py`]: "PLATE = 1\n",
  [`${PROJECT}/base.py`]: "BASE = 1\n",
};

const THREE_TABS = {
  folder: PROJECT,
  tabs: [
    { path: `${PROJECT}/part.py`, caret: null },
    { path: `${PROJECT}/plate.py`, caret: null },
    { path: `${PROJECT}/base.py`, caret: null },
  ],
  active: `${PROJECT}/part.py`,
};

async function typeInto(page, label, text) {
  await page.locator(".tab", { hasText: label }).click();
  await expect(page.locator(".tab-active .tab-label")).toHaveText(label);
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.type(text);
  await expect(page.locator(".tab-active .tab-close.tab-dirty")).toHaveCount(1);
}

/** What is on the in-memory disk right now - seeded contents included.
 *
 * Not "what the application wrote": a file the test seeded reads back the same
 * way, which is exactly what makes "Discard left it alone" assertable as the
 * original contents rather than as an absence.
 */
async function onDisk(page, path) {
  return page.evaluate((p) => globalThis.__NEUTRALINO_STUB__.wrote(p) ?? null, path);
}

/** Invoke a menu command the way the operating system does.
 *
 * Neutralino delivers a click as a `mainMenuItemClicked` event carrying the
 * item id, and every item's behaviour is the application's own - so emitting
 * the event is not a shortcut past the UI, it *is* the UI's entry point. The
 * ids come from menu.js.
 */
async function chooseMenuItem(page, id) {
  await page.evaluate(
    (menuId) => globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: menuId }),
    id,
  );
}

const CLOSE_FOLDER = "file.closeFolder";

test.describe("one prompt, not one per file", () => {
  test("closing a folder with three dirty tabs asks once and lists them", async ({ page }) => {
    // The point of group 2's piece 4, and it is a usability decision rather than
    // a mechanical one: five questions in a row is how people learn to dismiss a
    // dialog without reading it.
    await open(page, { files: FILES, settings: { workspace: THREE_TABS } });

    await typeInto(page, "part.py", "A");
    await typeInto(page, "plate.py", "B");
    await typeInto(page, "base.py", "C");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(3);

    await chooseMenuItem(page, CLOSE_FOLDER);

    // One overlay, however many files are dirty. The element is hidden rather
    // than removed when it is answered, so visibility is the question and a
    // count of them is not - counting said "1" just as loudly after every click.
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await expect(page.locator(".confirm-overlay")).toHaveCount(1);
    const text = await page.locator(".confirm-overlay").innerText();
    for (const name of ["part.py", "plate.py", "base.py"]) {
      expect(text, `${name} was not named in the prompt`).toContain(name);
    }
  });
});

test.describe("what each answer does", () => {
  test("Save writes every dirty buffer to disk", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: THREE_TABS } });

    await typeInto(page, "part.py", "AAA");
    await typeInto(page, "plate.py", "BBB");

    await chooseMenuItem(page, CLOSE_FOLDER);
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect(page.locator(".confirm-overlay")).toBeHidden();
    expect(String(await onDisk(page, `${PROJECT}/part.py`))).toContain("AAA");
    expect(String(await onDisk(page, `${PROJECT}/plate.py`))).toContain("BBB");
  });

  test("Discard leaves disk untouched", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: THREE_TABS } });

    await typeInto(page, "part.py", "AAA");

    await chooseMenuItem(page, CLOSE_FOLDER);
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="discard"]').click();

    await expect(page.locator(".confirm-overlay")).toBeHidden();
    // Byte for byte what it was, and specifically not the edited buffer.
    expect(await onDisk(page, `${PROJECT}/part.py`)).toBe("PART = 1\n");
  });

  test("Cancel cancels the whole command, folder and all", async ({ page }) => {
    // Decided in group 2: cancelling the save prompt for any dirty tab cancels
    // the command outright, exactly as it cancels a quit. A folder that closed
    // anyway would be a command that half happened.
    await open(page, { files: FILES, settings: { workspace: THREE_TABS } });

    await typeInto(page, "part.py", "AAA");

    await chooseMenuItem(page, CLOSE_FOLDER);
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    await expect(page.locator(".confirm-overlay")).toBeHidden();
    // Everything still open, still dirty, still the same folder.
    await expect(page.locator(".tab")).toHaveCount(3);
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);
    await expect(page.locator("#pane-tree")).toBeVisible();
  });
});

test.describe("nothing is asked when nothing is at stake", () => {
  test("closing a folder with no dirty tabs puts up no dialog", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: THREE_TABS } });

    await chooseMenuItem(page, CLOSE_FOLDER);

    await expect(page.locator(".tab")).toHaveCount(0);
    await expect(page.locator(".confirm-overlay")).toBeHidden();
  });
});
