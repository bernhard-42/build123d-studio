/** Many files in one editor: the strip, the dirty mark, and what undo belongs to.
 *
 * `tabs.js` already tests label disambiguation as a pure function, and
 * `buffers.js` tests the registry with injected model operations. What neither
 * can reach is the part that went wrong on a real build: whether the mark the
 * user is looking at agrees with the answer the application gives when it
 * matters, and whether Monaco's undo stack stays with the file it belongs to.
 * Both need a real Monaco and a real strip, which is what this suite has.
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/editor/monaco.js, the dirty check's deferral to the next tick - the
 *   dirty mark goes away again, and the title agrees
 * - src/editor/monaco.js, one model per buffer back to one shared model - each
 *   tab shows its own file, the dirty mark, a clean tab closes
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";

const FILES = {
  [`${PROJECT}/part.py`]: "from build123d import *\n\nb = Box(1, 2, 3)\n",
  [`${PROJECT}/plate.py`]: "PLATE = 1\n",
  [`${PROJECT}/sub/part.py`]: "SUB = 2\n",
};

const WORKSPACE = {
  folder: PROJECT,
  tabs: [
    { path: `${PROJECT}/part.py`, caret: null },
    { path: `${PROJECT}/plate.py`, caret: null },
  ],
  active: `${PROJECT}/part.py`,
};

/** Type into whichever buffer the editor is showing.
 *
 * Through `.view-lines` rather than the textarea Monaco actually listens to.
 * That textarea exists and is even resolvable, but Monaco parks it off-screen
 * at a size a click cannot land on, so Playwright waits for an actionability it
 * will never get and the test dies thirty seconds later. Clicking the lines is
 * also what a person does.
 */
async function focusEditor(page) {
  await page.locator(".monaco-editor .view-lines").first().click();
}

async function typeInEditor(page, text) {
  await focusEditor(page);
  await page.keyboard.type(text);
}

/** What the editor is showing, without the line-number gutter.
 *
 * innerText on `.monaco-editor` includes the gutter, so "AAA = 1" comes back as
 * "123\nAAA = 1" and every assertion about content quietly matches the wrong
 * thing. `.view-lines` is the text alone.
 */
async function editorText(page) {
  return page.locator(".monaco-editor .view-lines").first().innerText();
}

async function labels(page) {
  return page.locator(".tab .tab-label").allTextContents();
}

test.describe("the strip says which file is which", () => {
  test("a tab is labelled with the filename and titled with the path", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    expect(await labels(page)).toEqual(["part.py", "plate.py"]);
    const titles = await page.locator(".tab").evaluateAll((tabs) =>
      tabs.map((tab) => tab.title),
    );
    expect(titles[0]).toBe(`${PROJECT}/part.py`);
  });

  test("two files of the same name get a hint saying where they are", async ({ page }) => {
    // A strip showing "part.py" twice is a strip you have to hover to use.
    await open(page, {
      files: FILES,
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [
            { path: `${PROJECT}/part.py`, caret: null },
            { path: `${PROJECT}/sub/part.py`, caret: null },
          ],
          active: `${PROJECT}/part.py`,
        },
      },
    });

    const hints = await page.locator(".tab .tab-hint").allTextContents();
    expect(hints.filter((hint) => hint !== "").length, "neither tab said where it was").toBe(2);
    expect(hints.join(" ")).toContain("sub");
  });

  test("the active tab is the one marked active", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
    await page.locator(".tab", { hasText: "plate.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("plate.py");
  });
});

test.describe("choosing a tab", () => {
  // Reported from a real session: put the caret somewhere in a file, click into
  // the viewer, click the file's tab again - and there is no cursor. The caret
  // was never lost; showBuffer restores the view state. What was missing is
  // that nothing on the tab path ever focused the editor, so Monaco drew no
  // cursor and the next keystroke went to the window instead of the file.

  test("puts the keyboard in the editor", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    await focusEditor(page);

    // Away from the editor, the way clicking the viewer does it.
    await page.locator("#pane-viewer").click();
    await expect(page.locator(".monaco-editor textarea")).not.toBeFocused();

    await page.locator(".tab", { hasText: "plate.py" }).click();

    await expect(page.locator(".monaco-editor textarea")).toBeFocused();
  });

  test("so what is typed next lands in the file the tab named", async ({ page }) => {
    // The consequence a person actually meets. Asserted through the text rather
    // than through activeElement, because "the editor has focus" is only worth
    // anything if typing reaches the buffer.
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    await focusEditor(page);
    await page.locator("#pane-viewer").click();
    await expect(page.locator(".monaco-editor textarea")).not.toBeFocused();

    await page.locator(".tab", { hasText: "plate.py" }).click();
    // Waited for, not assumed. Typing into a window that has not been given the
    // caret yet is a race this test lost about one run in three under a full
    // suite - and it is what a person does anyway: click the tab, see the
    // cursor, then type.
    await expect(page.locator(".monaco-editor textarea")).toBeFocused();
    await page.keyboard.type("AAA");

    await expect(page.locator(".tab-active .tab-label")).toHaveText("plate.py");
    expect(await editorText(page), "the keystrokes went somewhere else").toContain("AAA");
  });
});

test.describe("the dirty mark", () => {
  test("appears when the buffer differs from disk", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await expect(page.locator(".tab-active .tab-close.tab-dirty")).toHaveCount(0);
    await typeInEditor(page, "x = 1\n");
    await expect(page.locator(".tab-active .tab-close.tab-dirty")).toHaveCount(1);
  });

  test("goes away again when the edit is undone", async ({ page }) => {
    // The one that lied on a real build. Undoing back to the saved version left
    // the mark on, because Monaco's alternative version id has not settled
    // while the content-change event is still being delivered - so the check is
    // deferred a tick. Closing the buffer asked nothing, which is what said the
    // answer was right and only the moment it was asked was wrong.
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    // One token, no spaces and no newline. Monaco opens a new undo stop at each
    // of those, so "x = 1" is three edits and a single undo would leave the
    // buffer still changed - the test would fail against correct code, for a
    // reason that has nothing to do with the defect.
    await typeInEditor(page, "hello");
    await expect(page.locator(".tab-active .tab-close.tab-dirty")).toHaveCount(1);

    await page.keyboard.press("Meta+z");
    await expect(
      page.locator(".tab-active .tab-close.tab-dirty"),
      "the tab still claims unsaved work after the edit was undone",
    ).toHaveCount(0);
  });

  test("and the window title agrees with the tab", async ({ page }) => {
    // Two indicators of one fact. They disagreed once, and a user cannot tell
    // which of them to believe.
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await typeInEditor(page, "hello");
    await expect(page).toHaveTitle(/•/);

    await page.keyboard.press("Meta+z");
    await expect(page).not.toHaveTitle(/•/);
  });
});

test.describe("each file keeps its own history", () => {
  test("each tab shows its own file rather than a shared one", async ({ page }) => {
    // The property underneath the undo bug, stated so it can actually fail: one
    // Monaco model per buffer. Before group 2 the application had a single model
    // that every file's text was poured into, and everything else followed from
    // that - two tabs showing the same text, and an undo stack that walked back
    // through files the user had closed.
    //
    // Asserted as "what each tab shows" rather than as "what undo does",
    // because the undo phrasing could not be made to fail honestly - see the
    // note below. This one fails the moment the models are shared.
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
    const partText = await editorText(page);

    await page.locator(".tab", { hasText: "plate.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("plate.py");
    const plateText = await editorText(page);

    expect(partText, "part.py is not showing its own contents").toContain("Box");
    expect(plateText, "plate.py is not showing its own contents").toContain("PLATE");
    expect(plateText, "both tabs are showing one shared model").not.toContain("Box");
  });

  // An "undo in one file cannot put back a line from another" case lived here
  // and was deleted rather than kept. It described the right property - it is
  // the group 2 bug in one sentence - but it could not be made to fail
  // honestly: under a shared model it failed in isolation for an unrelated
  // reason (the typing never landed) and passed in the suite, and once the case
  // above was added it started failing against correct code too. A test whose
  // result depends on what ran before it is worse than no test, because the
  // next person spends a morning on the flake instead of on the defect. The
  // case above holds the same line and fails exactly when it should.

  test("switching away and back keeps what was typed", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await typeInEditor(page, "KEEPME");
    await page.locator(".tab", { hasText: "plate.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("plate.py");
    await page.locator(".tab", { hasText: "part.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");

    expect(await editorText(page), "the unsaved edit was lost switching tabs").toContain("KEEPME");
  });
});

test.describe("closing", () => {
  test("the last tab leaves no phantom buffer behind", async ({ page }) => {
    // Decided in group 2: no empty buffer to save, close or wonder about. The
    // editor pane shows nothing until a file is opened or created.
    await open(page, {
      files: FILES,
      settings: {
        workspace: { folder: PROJECT, tabs: [{ path: `${PROJECT}/plate.py`, caret: null }], active: `${PROJECT}/plate.py` },
      },
    });

    await page.locator(".tab .tab-close").first().click();

    await expect(page.locator(".tab")).toHaveCount(0);
    await expect(page.locator("#tab-strip")).toBeHidden();
  });

  test("a clean tab closes without asking", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await page.locator(".tab", { hasText: "plate.py" }).locator(".tab-close").click();

    await expect(page.locator(".tab")).toHaveCount(1);
    expect(await labels(page)).toEqual(["part.py"]);
  });
});
