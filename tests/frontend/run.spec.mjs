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
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/keys.js, run.cell's shift+enter swapped for ctrl/mod+enter -
 *   Shift-Enter runs the cell, Ctrl-Enter stays
 * - src/editor/monaco.js, the `code.trim() === ""` guard - a buffer with
 *   nothing but blank lines sends nothing
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
  test("Alt-Enter runs the whole buffer on the kernel", async ({ page }) => {
    // This was F5 and is now Run All, which is what it always did: the text on
    // screen goes to the kernel and never touches disk. F5 debugs the file, and
    // Ctrl-F5 runs it - both from disk, neither of them this.
    const { sidecar } = await openWithCells(page);

    await putCaretOnLine(page, 1);
    await page.keyboard.press("Alt+Enter");
    await sidecar.waitFor("kernel.execute");

    expect(executed(sidecar)).toHaveLength(1);
    expect(executed(sidecar)[0]).toContain("FIRST");
    expect(executed(sidecar)[0], "Run All did not send the whole buffer").toContain("FOURTH");
  });

  test("F5 no longer sends anything to the kernel", async ({ page }) => {
    // The half of the rename that a passing suite would not have noticed: F5
    // still does something, so a test that only checked Alt-Enter would leave
    // the old chord quietly executing the buffer as well.
    const { sidecar } = await openWithCells(page);

    await putCaretOnLine(page, 1);
    await page.keyboard.press("F5");
    await page.waitForTimeout(300);

    expect(executed(sidecar), "F5 still runs the buffer on the kernel").toEqual([]);
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

test.describe("the toolbar says which chord it is", () => {
  test("every run button names its own chord, in one notation", async ({ page }) => {
    // What he saw: three buttons carried a chord and two did not, and the ones
    // that did spelled "Alt+Enter" where the menu beside them wrote the symbol.
    // The titles are built from the keymap now, so this holds both halves - all
    // of them have one, and none of them spells Enter as a word on a Mac.
    await openWithCells(page);

    const titles = {};
    for (const id of ["btn-run-cell", "btn-run-sel", "btn-run-all", "btn-run-file"]) {
      titles[id] = await page.locator(`#${id}`).getAttribute("title");
    }

    expect(titles["btn-run-cell"]).toBe("Run Cell (⇧↩)");
    expect(titles["btn-run-sel"]).toBe("Run Selection (⌃⇧↩)");
    expect(titles["btn-run-all"]).toBe("Run All (⌥↩)");
    expect(titles["btn-run-file"]).toBe("Run File (⌃F5)");
    for (const [id, title] of Object.entries(titles)) {
      expect(title, `${id} writes Enter as a word`).not.toContain("Enter");
    }
  });

  test("and the debug button names the chord for what it will do next", async ({ page }) => {
    // It said "(Shift+F5)" for both starting and stopping, and went on saying it
    // after F5 became Debug File and Shift-F5 became Stop.
    await openWithCells(page);

    await expect(page.locator("#btn-debug")).toHaveAttribute("title", "Debug File (F5)");
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

  test("Alt-Enter with no file open sends nothing", async ({ page }) => {
    // Closing the last tab leaves the editor with no buffer at all, and a run
    // action then has nothing to read.
    const { sidecar } = await openWithCells(page);
    await page.locator(".tab .tab-close").first().click();
    await expect(page.locator(".tab")).toHaveCount(0);

    await page.keyboard.press("Alt+Enter");
    await page.waitForTimeout(300);

    expect(executed(sidecar)).toEqual([]);
  });
});

test.describe("an interrupt that does not land", () => {
  test("offers to restart the kernel, and only after it has had its five seconds", async ({ page }) => {
    // Python raises KeyboardInterrupt between operations, so a single long
    // native call - a boolean on a large assembly - cannot be interrupted at
    // all. The button then does nothing visible, for ever, and nothing says why.
    const { sidecar } = await openWithCells(page);
    sidecar.send("kernel.status", { state: "busy" });
    await expect(page.locator("#kernel-status")).toHaveClass(/busy/);

    await page.locator("#btn-interrupt").click();

    // Nothing yet: the kernel is given the five seconds before it is doubted.
    await page.waitForTimeout(2000);
    await expect(page.locator(".confirm-overlay")).toHaveCount(0);

    await expect(page.locator(".confirm-overlay")).toBeVisible({ timeout: 10_000 });
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect
      .poll(() => sidecar.received.filter((frame) => frame.type === "kernel.restart").length)
      .toBe(1);
  });

  test("and says nothing when it did land", async ({ page }) => {
    const { sidecar } = await openWithCells(page);
    sidecar.send("kernel.status", { state: "busy" });
    await expect(page.locator("#kernel-status")).toHaveClass(/busy/);

    await page.locator("#btn-interrupt").click();
    sidecar.send("kernel.status", { state: "idle" });
    await expect(page.locator("#kernel-status")).toHaveClass(/idle/);

    await page.waitForTimeout(7000);
    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
  });
});

test.describe("the buttons above a marker", () => {
  // A code lens is Monaco's own widget, so what is asserted here is that it is
  // drawn where a marker is - and that clicking one acts on *that* marker
  // rather than on wherever the caret happens to be, which is the whole reason
  // the commands take a line number.

  // Exact, because "Cell" is a prefix of "Cell Above" and a loose match picks
  // up both - which makes an nth() index mean something different per marker.
  const lens = (page, title) =>
    page.locator(".codelens-decoration a")
      .filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) });

  test("five of them, above each marker and nowhere else", async ({ page }) => {
    await openWithCells(page);

    // Two markers in the fixture, five buttons each. The text before the first
    // marker is a cell too, and must not be decorated: nobody wrote a boundary
    // there.
    await expect.poll(() => page.locator(".codelens-decoration a").count()).toBe(10);
    await expect(lens(page, "\u25b6 Cell").first()).toBeVisible();
    await expect(lens(page, "\u23f9 Interrupt").first()).toBeVisible();
  });

  test("a plain script with no markers has none", async ({ page }) => {
    await open(page, {
      files: { [`${PROJECT}/plain.py`]: "x = 1\ny = 2\n" },
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [{ path: `${PROJECT}/plain.py`, caret: null }],
          active: `${PROJECT}/plain.py`,
        },
      },
    });

    await page.waitForTimeout(300);
    await expect(page.locator(".codelens-decoration a")).toHaveCount(0);
  });

  test("Cell runs the cell it sits on, not the one the caret is in", async ({ page }) => {
    // The caret is left in the first cell and the *second* marker's button is
    // clicked. A command that read the caret would run "FIRST = 1".
    const { sidecar } = await openWithCells(page);
    await putCaretOnLine(page, 1);

    await lens(page, "\u25b6 Cell").nth(1).click();
    await sidecar.waitFor("kernel.execute");

    expect(executed(sidecar)).toHaveLength(1);
    expect(executed(sidecar)[0]).toContain("FOURTH");
    expect(executed(sidecar)[0]).not.toContain("SECOND");
  });

  test("All Above runs everything before its marker", async ({ page }) => {
    const { sidecar } = await openWithCells(page);

    await lens(page, "\u25b6 All Above").nth(1).click();
    await sidecar.waitFor("kernel.execute");

    const code = executed(sidecar)[0];
    expect(code).toContain("FIRST");
    expect(code).toContain("SECOND");
    expect(code).not.toContain("FOURTH");
  });

  test("All Below runs its marker and everything after", async ({ page }) => {
    const { sidecar } = await openWithCells(page);

    await lens(page, "\u25b6 All Below").first().click();
    await sidecar.waitFor("kernel.execute");

    const code = executed(sidecar)[0];
    expect(code).toContain("SECOND");
    expect(code).toContain("FOURTH");
    expect(code).not.toContain("FIRST");
  });

  test("Cell Above runs the one before it", async ({ page }) => {
    const { sidecar } = await openWithCells(page);

    await lens(page, "\u25b6 Cell Above").nth(1).click();
    await sidecar.waitFor("kernel.execute");

    const code = executed(sidecar)[0];
    expect(code).toContain("SECOND");
    expect(code).not.toContain("FOURTH");
  });

  test("Interrupt asks the kernel to stop", async ({ page }) => {
    const { sidecar } = await openWithCells(page);

    await lens(page, "\u23f9 Interrupt").first().click();

    await expect.poll(() =>
      sidecar.received.filter((frame) => frame.type === "kernel.interrupt").length,
    ).toBe(1);
  });

  test("and the setting takes them away", async ({ page }) => {
    await open(page, {
      files: FILES,
      settings: { workspace: WORKSPACE, cellActions: false },
    });

    await page.waitForTimeout(300);
    await expect(page.locator(".codelens-decoration a")).toHaveCount(0);
  });
});

test.describe("restarting the kernel from the keyboard", () => {
  // Not an editor action, unlike every run chord: a restart is what somebody
  // reaches for when the console is wedged, so it has to arrive whatever has
  // the caret. macOS makes that the only option anyway - its native menu binds
  // Command plus one character and nothing more, so the menu cannot carry a
  // four-key chord and Monaco only hears one while the editor has focus.

  const restarts = (sidecar) =>
    sidecar.received.filter((frame) => frame.type === "kernel.restart").length;

  test("the chord works with the editor focused", async ({ page }) => {
    const { sidecar } = await openWithCells(page);
    await putCaretOnLine(page, 1);

    await page.keyboard.press("Meta+Shift+Alt+KeyR");

    await expect.poll(() => restarts(sidecar)).toBe(1);
  });

  test("and with the caret somewhere else entirely", async ({ page }) => {
    // The case the editor action could not cover, and the reason this listener
    // is on the window.
    const { sidecar } = await openWithCells(page);
    await page.locator("#console-tab-backend").click();

    await page.keyboard.press("Meta+Shift+Alt+KeyR");

    await expect.poll(() => restarts(sidecar)).toBe(1);
  });

  test("once per press, not twice", async ({ page }) => {
    // A window listener and an editor action would both answer while the
    // editor has focus, and a kernel restarted twice loses the namespace twice.
    const { sidecar } = await openWithCells(page);
    await putCaretOnLine(page, 1);

    await page.keyboard.press("Meta+Shift+Alt+KeyR");
    await expect.poll(() => restarts(sidecar)).toBe(1);

    await page.waitForTimeout(300);
    expect(restarts(sidecar)).toBe(1);
  });

  test("and Ctrl-Shift-Alt-R is the same chord off macOS", async ({ page }) => {
    // `mod` is Command there and Control here, written once in keys.js. The
    // platform is the one thing this suite can vary that a person cannot.
    const { sidecar } = await open(page, {
      platform: "Windows", files: FILES, settings: { workspace: WORKSPACE },
    });

    await page.keyboard.press("Control+Shift+Alt+KeyR");

    await expect.poll(() => restarts(sidecar)).toBe(1);
  });

  test("and a chord that is nearly it does nothing", async ({ page }) => {
    const { sidecar } = await openWithCells(page);
    await putCaretOnLine(page, 1);

    await page.keyboard.press("Meta+Shift+KeyR");
    await page.keyboard.press("Meta+Alt+KeyR");
    await page.waitForTimeout(300);

    expect(restarts(sidecar)).toBe(0);
  });
});
