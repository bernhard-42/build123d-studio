/** A folder is the project, and the project is the whole session.
 *
 * That is the sentence group 2's folder rules follow from, and every case here
 * is one of them. They are decisions rather than mechanics - "what happens to
 * my tabs" is answered *always all of them*, never *some*, because a rule the
 * user has to hold in their head to predict a menu item is a bad rule - so they
 * are worth holding down at the layer where a user would notice them changing.
 *
 * The working directory is the other half. It is the one thing a CAD script
 * silently depends on: `export_step(part, "bracket.step")` lands in a different
 * place depending on what this application decided, and nothing on screen says
 * where. It is asserted through the `kernel.cwd` frame, which is exactly what
 * the sidecar acts on.
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const OTHER = "/documents/plate-project";
const LOOSE = "/documents/loose";

const FILES = {
  [`${PROJECT}/part.py`]: "PART = 1\n",
  [`${PROJECT}/sub/deep.py`]: "DEEP = 1\n",
  [`${OTHER}/plate.py`]: "PLATE = 1\n",
  [`${LOOSE}/scratch.py`]: "SCRATCH = 1\n",
};

const MENU = {
  OPEN_FOLDER: "file.openFolder",
  CLOSE_FOLDER: "file.closeFolder",
};

const WITH_PROJECT = {
  folder: PROJECT,
  tabs: [
    { path: `${PROJECT}/part.py`, caret: null },
    { path: `${PROJECT}/sub/deep.py`, caret: null },
  ],
  active: `${PROJECT}/part.py`,
};

async function chooseMenuItem(page, id) {
  await page.evaluate(
    (menuId) => globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: menuId }),
    id,
  );
}

/** What the next folder chooser will answer with. */
async function answerFolderDialogWith(page, path) {
  await page.evaluate((p) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(p), path);
}

/** Every working directory the application has asked the kernel for, in order. */
function workingDirectories(sidecar) {
  return sidecar.received.filter((f) => f.type === "kernel.cwd").map((f) => f.path);
}

function lastWorkingDirectory(sidecar) {
  const all = workingDirectories(sidecar);
  return all.length === 0 ? null : all[all.length - 1];
}

test.describe("the working directory", () => {
  test("is the project root, however deep the open file sits", async ({ page }) => {
    // Not the active tab's directory. A hierarchy is one project and a project
    // has one place its relative paths resolve against - a cwd that followed the
    // tab would put export_step's output somewhere different for every file.
    const { sidecar } = await open(page, { files: FILES, settings: { workspace: WITH_PROJECT } });

    await expect.poll(() => lastWorkingDirectory(sidecar)).toBe(PROJECT);

    // Switch to the file two directories down. The answer must not move.
    await page.locator(".tab", { hasText: "deep.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("deep.py");
    await page.waitForTimeout(200);

    expect(lastWorkingDirectory(sidecar), "the cwd followed the tab into a subdirectory").toBe(
      PROJECT,
    );
  });

  test("follows the file again once the folder is closed", async ({ page }) => {
    // The Phase 1 promise, kept in precisely the case it was made for: a single
    // script opened on its own runs beside itself. Without Close Folder there
    // would be no way back to that behaviour once any folder had been opened.
    const { sidecar } = await open(page, {
      files: FILES,
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [{ path: `${LOOSE}/scratch.py`, caret: null }],
          active: `${LOOSE}/scratch.py`,
        },
      },
    });

    await expect.poll(() => lastWorkingDirectory(sidecar)).toBe(PROJECT);

    await chooseMenuItem(page, MENU.CLOSE_FOLDER);
    await expect(page.locator("#pane-tree")).toBeHidden();

    // Every tab went with the folder, so there is no file left to follow and
    // home is the honest answer - the same one an unsaved buffer gets.
    await expect(page.locator(".tab")).toHaveCount(0);
    expect(lastWorkingDirectory(sidecar), "the cwd stayed at a folder that is closed").not.toBe(
      PROJECT,
    );
  });
});

test.describe("Open Folder is a context reset", () => {
  test("it closes every tab, including ones outside the old folder", async ({ page }) => {
    // The alternative - keeping the tabs that happened to live elsewhere - was
    // considered and dropped: "which tabs survive this" would then depend on
    // where each file sits, which is exactly the rule a user should not have to
    // hold in their head.
    const { sidecar } = await open(page, {
      files: FILES,
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [
            { path: `${PROJECT}/part.py`, caret: null },
            { path: `${LOOSE}/scratch.py`, caret: null },
          ],
          active: `${PROJECT}/part.py`,
        },
      },
    });
    await expect(page.locator(".tab")).toHaveCount(2);

    await answerFolderDialogWith(page, OTHER);
    await chooseMenuItem(page, MENU.OPEN_FOLDER);

    // Nothing showing: it is a reset, and the previous project leaves nothing
    // behind - not even the file that was never part of it.
    await expect(page.locator(".tab")).toHaveCount(0);
    await expect(page.locator("#tree-root")).toHaveText("plate-project");
    await expect.poll(() => lastWorkingDirectory(sidecar)).toBe(OTHER);
  });

  test("cancelling the chooser changes nothing at all", async ({ page }) => {
    // The dialog's cancel return is undocumented, so anything that is not a
    // non-empty string is treated as one. A reset that half-happened because a
    // chooser was dismissed would be the worst of both.
    const { sidecar } = await open(page, { files: FILES, settings: { workspace: WITH_PROJECT } });
    await expect(page.locator(".tab")).toHaveCount(2);
    const before = workingDirectories(sidecar).length;

    // No answer queued, so the stub returns undefined - a cancel.
    await chooseMenuItem(page, MENU.OPEN_FOLDER);
    await page.waitForTimeout(300);

    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(page.locator("#tree-root")).toHaveText("bracket");
    expect(workingDirectories(sidecar).length, "a cancelled Open Folder moved the kernel").toBe(
      before,
    );
  });

  test("unsaved work is asked about once, and cancelling keeps the old project", async ({
    page,
  }) => {
    const { sidecar } = await open(page, { files: FILES, settings: { workspace: WITH_PROJECT } });

    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.type("EDIT");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);

    await answerFolderDialogWith(page, OTHER);
    await chooseMenuItem(page, MENU.OPEN_FOLDER);

    // Asked after the chooser, not before it: picking a folder is the point at
    // which this becomes destructive, and asking earlier is a prompt for
    // nothing if the user never chooses one.
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    await expect(page.locator("#tree-root")).toHaveText("bracket");
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);
    expect(lastWorkingDirectory(sidecar)).toBe(PROJECT);
  });
});

test.describe("the session is remembered", () => {
  test("the open tabs, the active one and the folder are all written down", async ({ page }) => {
    // Restart restores the previous session's tabs, not just the folder, along
    // with which one was active.
    await open(page, { files: FILES, settings: { workspace: WITH_PROJECT } });

    await page.locator(".tab", { hasText: "deep.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("deep.py");
    await page.waitForTimeout(300);

    const stored = await page.evaluate(() =>
      JSON.parse(globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/settings.json")),
    );
    expect(stored.workspace.folder).toBe(PROJECT);
    expect(stored.workspace.tabs.map((tab) => tab.path)).toEqual([
      `${PROJECT}/part.py`,
      `${PROJECT}/sub/deep.py`,
    ]);
    expect(stored.workspace.active, "the active tab was not remembered").toBe(
      `${PROJECT}/sub/deep.py`,
    );
  });

  test("and a restored session opens exactly what was left open", async ({ page }) => {
    await open(page, {
      files: FILES,
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [
            { path: `${PROJECT}/part.py`, caret: null },
            { path: `${PROJECT}/sub/deep.py`, caret: null },
          ],
          active: `${PROJECT}/sub/deep.py`,
        },
      },
    });

    expect(await page.locator(".tab .tab-label").allTextContents()).toEqual([
      "part.py",
      "deep.py",
    ]);
    await expect(page.locator(".tab-active .tab-label")).toHaveText("deep.py");
    await expect(page.locator("#tree-root")).toHaveText("bracket");
  });
});
