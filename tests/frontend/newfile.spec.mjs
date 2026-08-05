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

test.describe("which folder the buttons mean", () => {
  test("clicking a folder marks it, so you can see what is selected", async ({ page }) => {
    // Reported as "I cannot select a folder": the click did select it, and
    // nothing on screen said so - the only mark in the tree was the file the
    // editor was showing, which a folder can never be.
    await openApp(page);

    await page.locator(".tree-dir", { hasText: "parts" }).click();

    await expect(page.locator(".tree-dir.tree-selected")).toHaveText(/parts/);
  });

  test("and the buttons name the folder they would create in", async ({ page }) => {
    // The tree can be scrolled away from the selection, so the mark alone is
    // not enough to answer "where would this go".
    await openApp(page);
    await expect(page.locator("#tree-new-file")).toHaveAttribute("title", "New file in bracket");

    await page.locator(".tree-dir", { hasText: "parts" }).click();

    await expect(page.locator("#tree-new-file")).toHaveAttribute("title", "New file in parts");
    await expect(page.locator("#tree-new-folder")).toHaveAttribute("title", "New folder in parts");
  });

  test("selecting a file names its folder, not the file", async ({ page }) => {
    await openApp(page);
    await page.locator(".tree-dir", { hasText: "parts" }).click();

    await page.locator(".tree-file", { hasText: "plate.py" }).click();

    await expect(page.locator("#tree-new-file")).toHaveAttribute("title", "New file in parts");
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

test.describe("after the folder is deleted from outside", () => {
  test("a refresh forgets it, and the buttons still work", async ({ page }) => {
    // Reported after deleting files and folders in a terminal: the refresh
    // looked right and both buttons then did nothing at all. `read` answers an
    // unreadable directory with an empty listing rather than an error, so the
    // deleted folder stayed selected - and the new row, being its child, was
    // never rendered, because the walk from the root no longer reaches it.
    await openApp(page);
    await page.locator(".tree-dir", { hasText: "parts" }).click();
    await expect(page.locator("#tree-new-file")).toHaveAttribute("title", "New file in parts");

    await page.evaluate(
      (path) => globalThis.__NEUTRALINO_STUB__.removePath(path),
      `${PROJECT}/parts`,
    );
    await page.locator("#tree-refresh").click();
    await expect(page.locator(".tree-dir", { hasText: "parts" })).toHaveCount(0);

    await expect(page.locator("#tree-new-file")).toHaveAttribute("title", "New file in bracket");
    await page.locator("#tree-new-file").click();
    await page.locator("#tree-new-name").fill("after-delete.py");
    await page.keyboard.press("Enter");

    await expect.poll(() => wrote(page, `${PROJECT}/after-delete.py`)).toBe("");
  });

  test("and it works even without a refresh first", async ({ page }) => {
    // The tree cannot know until something reads the directory again, so the
    // click checks the filesystem rather than trusting what it remembers.
    await openApp(page);
    await page.locator(".tree-dir", { hasText: "parts" }).click();

    await page.evaluate(
      (path) => globalThis.__NEUTRALINO_STUB__.removePath(path),
      `${PROJECT}/parts`,
    );

    await page.locator("#tree-new-file").click();
    await page.locator("#tree-new-name").fill("fallback.py");
    await page.keyboard.press("Enter");

    await expect.poll(() => wrote(page, `${PROJECT}/fallback.py`)).toBe("");
  });
});

test.describe("a tab whose file has gone", () => {
  test("is struck through after a refresh, and stays open", async ({ page }) => {
    // Closing it would discard edits nobody asked to lose, which is the Phase 2
    // rule. The mark says what the dirty dot says, in its strongest form: what
    // is on screen is not what is on disk, because there is no longer a disk
    // copy at all.
    await openApp(page);
    await expect(page.locator(".tab-missing")).toHaveCount(0);

    await page.evaluate(
      (path) => globalThis.__NEUTRALINO_STUB__.removePath(path),
      `${PROJECT}/part.py`,
    );
    await page.locator("#tree-refresh").click();

    await expect(page.locator(".tab-missing .tab-label")).toHaveText("part.py");
    await expect(page.locator(".tab")).toHaveCount(1);
  });

  test("counts as unsaved work, so closing it asks", async ({ page }) => {
    // The buffer is the only copy of that text now. Discarding it silently is
    // exactly the failure the unsaved prompt exists to prevent.
    await openApp(page);
    await page.evaluate(
      (path) => globalThis.__NEUTRALINO_STUB__.removePath(path),
      `${PROJECT}/part.py`,
    );
    await page.locator("#tree-refresh").click();
    await expect(page.locator(".tab-missing")).toHaveCount(1);

    await page.locator(".tab-close").first().click();

    await expect(page.locator(".confirm-overlay:visible")).toContainText("part.py");
  });

  test("and saving writes it back and takes the mark off", async ({ page }) => {
    await openApp(page);
    await page.evaluate(
      (path) => globalThis.__NEUTRALINO_STUB__.removePath(path),
      `${PROJECT}/part.py`,
    );
    await page.locator("#tree-refresh").click();
    await expect(page.locator(".tab-missing")).toHaveCount(1);

    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Meta+s");

    await expect(page.locator(".tab-missing")).toHaveCount(0);
    await expect.poll(() => wrote(page, `${PROJECT}/part.py`)).toContain("PART = 1");
  });
});
