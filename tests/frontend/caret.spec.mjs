/** Giving the keyboard back keeps the caret where the user left it.
 *
 * After a native dialog, and when the window is activated with nothing in the
 * page focused, Studio hands the keyboard to the editor - see nativedialog.js.
 * Handing it over must not move the caret: the next key typed belongs where the
 * user was, not at the top of the file.
 *
 * Observed the way a user observes it: put the caret somewhere, let the event
 * happen, type, and see where the typing landed.
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "A = 1\nB = 2\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

async function openApp(page) {
  const handles = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
  await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
  return handles;
}

/** The caret at the end of `B = 2`, the second line. */
async function caretOnSecondLine(page) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
}

/** The editor's lines as drawn, top to bottom - see import.spec.mjs. */
async function editorLines(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".monaco-editor .view-lines .view-line")];
    lines.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    return lines.map((line) => line.textContent.replace(/\s/g, " ").trimEnd());
  });
}

test.describe("the caret survives the keyboard being given back", () => {
  test("after Save As", async ({ page }) => {
    await openApp(page);
    await caretOnSecondLine(page);
    await page.evaluate((target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target), `${PROJECT}/copy.py`);
    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.saveAs" }));
    await expect(page.locator(".tab-active .tab-label")).toHaveText("copy.py");
    // The keyboard comes back asynchronously - see afterNativeDialog.
    await page.waitForTimeout(300);

    await page.keyboard.type("Z");

    await expect.poll(() => editorLines(page)).toEqual(["A = 1", "B = 2Z", ""]);
  });

  test("when the window is activated with nothing focused", async ({ page }) => {
    await openApp(page);
    await caretOnSecondLine(page);
    // What a window coming back to the front from another application is left
    // with when nothing in it held the keyboard.
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("windowFocus", {}));
    await page.waitForTimeout(100);

    await page.keyboard.type("Z");

    await expect.poll(() => editorLines(page)).toEqual(["A = 1", "B = 2Z", ""]);
  });
});
