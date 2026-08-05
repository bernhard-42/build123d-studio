/** Making a file or a folder from the tree, named in place.
 *
 * Creating a folder had no route at all before this - Open Folder chooses an
 * existing one and Save As will not make one - so a project's first `parts/`
 * had to be made outside the application.
 *
 * Nothing is written until the name is accepted. The alternative considered was
 * creating `untitled.py` straight away and renaming it afterwards, which is
 * simpler and leaves one behind every time somebody changes their mind. So the
 * assertions below are as much about what is *not* on disk as about what is.
 *
 * Where it goes is decided in `tree.js` and unit-tested there; what these hold
 * is that the click reaches it and that the thing lands in the folder the row
 * appeared in.
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = {
  [`${PROJECT}/part.py`]: "PART = 1\n",
  [`${PROJECT}/parts/plate.py`]: "PLATE = 1\n",
};
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

const wrote = (page, path) =>
  page.evaluate((p) => globalThis.__NEUTRALINO_STUB__.wrote(p), path);

const madeDirectories = (page) =>
  page.evaluate(() =>
    globalThis.__NEUTRALINO_STUB__
      .calls()
      .filter((call) => call.name === "createDirectory")
      .map((call) => call.args[0]),
  );

test.describe("naming it in the tree", () => {
  test("the row opens with untitled.py, and the name is selected", async ({ page }) => {
    // The extension is not: what somebody retypes is the name, and having to
    // skip past ".py" every time is the sort of thing that makes a feature
    // annoying rather than broken.
    await openApp(page);

    await page.locator("#tree-new-file").click();

    await expect(page.locator("#tree-new-name")).toBeFocused();
    await expect(page.locator("#tree-new-name")).toHaveValue("untitled.py");
    expect(
      await page.evaluate(() => {
        const field = document.getElementById("tree-new-name");
        return field.value.slice(field.selectionStart, field.selectionEnd);
      }),
    ).toBe("untitled");
  });

  test("nothing is written until it is accepted", async ({ page }) => {
    await openApp(page);

    await page.locator("#tree-new-file").click();
    expect(await wrote(page, `${PROJECT}/untitled.py`)).toBeUndefined();

    await page.locator("#tree-new-name").fill("bracket.py");
    await page.keyboard.press("Enter");

    await expect.poll(() => wrote(page, `${PROJECT}/bracket.py`)).toBe("");
    await expect(page.locator(".tab-active .tab-label")).toHaveText("bracket.py");
  });

  test("Escape leaves nothing behind at all", async ({ page }) => {
    // The whole reason for naming before creating.
    await openApp(page);

    await page.locator("#tree-new-file").click();
    await page.keyboard.press("Escape");

    await expect(page.locator("#tree-new-name")).toHaveCount(0);
    expect(await wrote(page, `${PROJECT}/untitled.py`)).toBeUndefined();
  });

  test("a name already there is refused, and the row stays open", async ({ page }) => {
    await openApp(page);

    await page.locator("#tree-new-file").click();
    await page.locator("#tree-new-name").fill("part.py");
    await page.keyboard.press("Enter");

    await expect(page.locator("#tree-problem")).toContainText("already there");
    await expect(page.locator("#tree-new-name")).toHaveValue("part.py");
    expect(await wrote(page, `${PROJECT}/part.py`)).toBe("PART = 1\n");
  });

  test("it lands beside the selected file, not at the root", async ({ page }) => {
    await openApp(page);
    await page.locator(".tree-dir", { hasText: "parts" }).click();
    await page.locator(".tree-file", { hasText: "plate.py" }).click();

    await page.locator("#tree-new-file").click();
    await page.locator("#tree-new-name").fill("rib.py");
    await page.keyboard.press("Enter");

    await expect.poll(() => wrote(page, `${PROJECT}/parts/rib.py`)).toBe("");
  });
});

test.describe("a new folder", () => {
  test("opens as untitled with no extension, and is expanded once made", async ({ page }) => {
    await openApp(page);

    await page.locator("#tree-new-folder").click();
    await expect(page.locator("#tree-new-name")).toHaveValue("untitled");

    await page.locator("#tree-new-name").fill("jigs");
    await page.keyboard.press("Enter");

    await expect.poll(() => madeDirectories(page)).toContain(`${PROJECT}/jigs`);
    await expect(page.locator(".tree-dir", { hasText: "jigs" })).toBeVisible();
  });

  test("inside the selected folder", async ({ page }) => {
    await openApp(page);
    await page.locator(".tree-dir", { hasText: "parts" }).click();

    await page.locator("#tree-new-folder").click();
    await page.locator("#tree-new-name").fill("small");
    await page.keyboard.press("Enter");

    await expect.poll(() => madeDirectories(page)).toContain(`${PROJECT}/parts/small`);
  });
});
