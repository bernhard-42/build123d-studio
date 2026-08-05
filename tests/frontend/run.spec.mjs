/** The five run actions, as chords a person presses.
 *
 * `keys.js` already tests chord parsing and `editor/cells.js` tests where a
 * cell begins and ends, both as pure functions. Neither can answer the question
 * that actually matters here, which is whether pressing the chord runs the
 * right text - that needs Monaco to have registered the action, the keybinding
 * to have survived the platform mapping, and the cell arithmetic to have been
 * applied to the buffer the user is looking at.
 *
 * It has gone wrong before in exactly that gap: a chord named in the New File
 * template but attached to the wrong action is something the pure tests
 * explicitly cannot catch, and it shipped once.
 *
 * What is asserted is the frame that leaves for the sidecar. The kernel's half
 * - that it ran and printed In[n] - belongs to tests/integration.py, which has
 * a real kernel; this suite has a fake sidecar and can only speak for the
 * frontend's end. Both halves are worth having and neither substitutes.
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";

// Two cells, so "run this one and move on" has somewhere to move on to.
const CELLS = [
  "FIRST = 1",
  "# %%",
  "SECOND = 2",
  "THIRD = 3",
  "# %%",
  "FOURTH = 4",
  "",
].join("\n");

const FILES = { [`${PROJECT}/cells.py`]: CELLS };

const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/cells.py`, caret: null }],
  active: `${PROJECT}/cells.py`,
};

async function openWithCells(page) {
  const handles = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
  await expect(page.locator(".tab-active .tab-label")).toHaveText("cells.py");
  return handles;
}

/** Put the caret at the start of a line, counting from 1, selecting nothing.
 *
 * Driven from the top of the file with arrow keys rather than by clicking the
 * line, and both halves of that matter. A click lands the caret wherever it
 * landed - clicking "SECOND = 2" put it at the end of the line, so a
 * shift-selection from there began at the newline and the assertion looked for
 * text the selection genuinely did not contain. And an empty line has no glyph
 * to aim at, so nth=1 hit a different row entirely and ran the wrong cell.
 */
async function putCaretOnLine(page, lineNumber) {
  await page.locator(".view-lines .view-line").first().click();
  await page.keyboard.press("Meta+ArrowUp");
  for (let line = 1; line < lineNumber; line += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Home");
}

/** The code of every kernel.execute the application has sent. */
function executed(sidecar) {
  return sidecar.received.filter((frame) => frame.type === "kernel.execute").map((f) => f.code);
}

test.describe("what each chord runs", () => {
  test("F5 runs the whole file", async ({ page }) => {
    const { sidecar } = await openWithCells(page);

    await putCaretOnLine(page, 1);
    await page.keyboard.press("F5");
    await sidecar.waitFor("kernel.execute");

    expect(executed(sidecar)).toHaveLength(1);
    expect(executed(sidecar)[0]).toContain("FIRST");
    expect(executed(sidecar)[0], "F5 did not send the whole file").toContain("FOURTH");
  });

  test("Shift-Enter runs the cell at the cursor and moves to the next", async ({ page }) => {
    // Jupyter's own pair, matched exactly rather than improved on: Shift-Enter
    // advances, Ctrl-Enter stays.
    const { sidecar } = await openWithCells(page);

    await putCaretOnLine(page, 3); // SECOND, inside the second cell
    await page.keyboard.press("Shift+Enter");
    await sidecar.waitFor("kernel.execute");

    const code = executed(sidecar)[0];
    expect(code).toContain("SECOND");
    expect(code).toContain("THIRD");
    expect(code, "the cell boundary was not respected").not.toContain("FIRST");
    expect(code, "the cell boundary was not respected").not.toContain("FOURTH");

    // And the caret moved on, so pressing it again runs the *next* cell.
    await page.keyboard.press("Shift+Enter");
    await expect
      .poll(() => executed(sidecar).length, { message: "the second press ran nothing" })
      .toBe(2);
    expect(executed(sidecar)[1], "the caret did not advance to the next cell").toContain("FOURTH");
  });

  test("Ctrl-Enter runs the cell and stays where it is", async ({ page }) => {
    const { sidecar } = await openWithCells(page);

    await putCaretOnLine(page, 3);
    await page.keyboard.press("Control+Enter");
    await sidecar.waitFor("kernel.execute");
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => executed(sidecar).length).toBe(2);

    // The same cell twice, which is the whole difference from Shift-Enter.
    expect(executed(sidecar)[0]).toContain("SECOND");
    expect(executed(sidecar)[1], "the caret advanced when it should have stayed").toContain(
      "SECOND",
    );
  });

  test("Ctrl-Shift-Enter with no selection runs one physical line", async ({ page }) => {
    // "Run line" means one line, deliberately. A line that is not valid on its
    // own gets the kernel's "incomplete input" back, and that is the shortcut
    // behaving as named - extending to the enclosing statement would make the
    // one literal action ambiguous.
    const { sidecar } = await openWithCells(page);

    await putCaretOnLine(page, 3);
    await page.keyboard.press("Control+Shift+Enter");
    await sidecar.waitFor("kernel.execute");

    expect(executed(sidecar)[0].trim()).toBe("SECOND = 2");
  });

  test("Ctrl-Shift-Enter with a selection runs the selection", async ({ page }) => {
    const { sidecar } = await openWithCells(page);

    await putCaretOnLine(page, 3);
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+End");

    await page.keyboard.press("Control+Shift+Enter");
    await sidecar.waitFor("kernel.execute");

    const code = executed(sidecar)[0];
    expect(code).toContain("SECOND");
    expect(code, "only the first line of the selection was run").toContain("THIRD");
  });
});

test.describe("what does not run", () => {
  test("a buffer with nothing but blank lines sends nothing", async ({ page }) => {
    // The guard is `code.trim() === ""` in execute(). Sending whitespace would
    // advance In[n] for nothing and put an empty prompt in the transcript.
    //
    // Reached through a file with no cell markers at all, deliberately. An
    // "empty cell" does *not* reach it: a cell's code includes its own `# %%`
    // line, so running the empty cell between two markers sends "# %%" - a
    // comment, which the kernel executes and counts. That is the application's
    // behaviour rather than a defect, and this test says so rather than
    // asserting a rule nobody wrote down.
    const blank = ["", "   ", "", ""].join("\n");
    const { sidecar } = await open(page, {
      files: { [`${PROJECT}/blank.py`]: blank },
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [{ path: `${PROJECT}/blank.py`, caret: null }],
          active: `${PROJECT}/blank.py`,
        },
      },
    });

    await putCaretOnLine(page, 1);
    await page.keyboard.press("F5");
    await page.waitForTimeout(300);

    expect(executed(sidecar), "whitespace was sent to the kernel").toEqual([]);
  });

  test("F5 with no file open sends nothing", async ({ page }) => {
    // Closing the last tab leaves the editor with no buffer at all, and a run
    // action then has nothing to read.
    const { sidecar } = await openWithCells(page);
    await page.locator(".tab .tab-close").first().click();
    await expect(page.locator(".tab")).toHaveCount(0);

    await page.keyboard.press("F5");
    await page.waitForTimeout(300);

    expect(executed(sidecar)).toEqual([]);
  });
});
