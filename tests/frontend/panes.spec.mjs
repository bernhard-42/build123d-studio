/** The four panes, their boundaries, and what a restart remembers about them.
 *
 * Everything here is about pixels the layout engine actually produced, which is
 * the whole reason this suite runs in a browser: `splitter.js` sizes panes by
 * writing computed pixel widths into custom properties, so what it got right or
 * wrong is only visible once something has measured a real container. A unit
 * test of the arithmetic would have agreed with the code in every case below,
 * including the one that shipped broken.
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/editor/sidebar.js, the `if (visible === away)` re-measure - starting
 *   with a folder open, and hiding the tree gives its width back
 * - src/layout/splitter.js, clamp() returning its argument - an absurd stored
 *   fraction is clamped
 * - src/layout/splitter.js, the persist() after a drag - moves it, and is
 *   remembered
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";

const FILES = {
  [`${PROJECT}/part.py`]: "from build123d import *\n\nb = Box(1, 2, 3)\n",
  [`${PROJECT}/README.md`]: "# bracket\n",
};

/** Where a boundary actually ended up, as a fraction of the row it divides. */
async function columnFraction(page, rowId, leftPaneId) {
  return page.evaluate(
    ([row, pane]) => {
      const width = document.getElementById(row).clientWidth - 5;
      return document.getElementById(pane).getBoundingClientRect().width / width;
    },
    [rowId, leftPaneId],
  );
}

test.describe("the stored layout is what comes back", () => {
  test("a stored fraction puts the boundary where it was left", async ({ page }) => {
    await open(page, {
      files: FILES,
      settings: { layout: { rows: 0.62, columnsTop: 0.3, columnsBottom: 0.7, tree: 0.16 } },
    });

    expect(await columnFraction(page, "row-top", "pane-editor")).toBeCloseTo(0.3, 1);
    expect(await columnFraction(page, "row-bottom", "pane-console")).toBeCloseTo(0.7, 1);
  });

  test("the two rows keep their own ratios rather than sharing one", async ({ page }) => {
    // Nested grids rather than one, so the editor/viewer split and the
    // console/explorer split are independent. Sharing them was the obvious
    // simplification and is the thing this excludes.
    await open(page, {
      files: FILES,
      settings: { layout: { rows: 0.5, columnsTop: 0.25, columnsBottom: 0.75, tree: 0.16 } },
    });

    const top = await columnFraction(page, "row-top", "pane-editor");
    const bottom = await columnFraction(page, "row-bottom", "pane-console");
    expect(Math.abs(top - bottom)).toBeGreaterThan(0.3);
  });

  test("an absurd stored fraction is clamped rather than obeyed", async ({ page }) => {
    // A settings file can be edited by hand, and 0.99 would leave the viewer
    // with a few pixels and no way to drag it back.
    await open(page, {
      files: FILES,
      settings: { layout: { rows: 0.62, columnsTop: 0.99, columnsBottom: 0.01, tree: 0.16 } },
    });

    const top = await columnFraction(page, "row-top", "pane-editor");
    expect(top).toBeLessThanOrEqual(0.91);
    expect(top).toBeGreaterThanOrEqual(0.85);
  });
});

test.describe("the panes are re-measured when the tree comes and goes", () => {
  test("starting with a folder open does not push the boundaries right", async ({ page }) => {
    // The defect, found by hand and only ever visible on a start with a folder
    // already open: initSplitters measures while the tree is still hidden,
    // restoreWorkspace opens the folder afterwards, the tree takes its share
    // and nothing measures again - so both vertical boundaries sat too far
    // right by exactly the tree's width.
    //
    // His own description is what located it: "It works when the file tree is
    // closed, it doesn't work when it is open", and "when I move the bottom
    // splitter the top one jumps to the right position" - because any drag
    // re-measures both rows.
    await open(page, {
      files: FILES,
      settings: {
        layout: { rows: 0.62, columnsTop: 0.45, columnsBottom: 0.45, tree: 0.16 },
        workspace: { folder: PROJECT, tabs: [], active: null },
      },
    });

    await expect(page.locator("#pane-tree")).toBeVisible();
    // The measurement that matters: the editor takes its stored share of the
    // row it is *in*, which is narrower now that the tree is beside it.
    expect(await columnFraction(page, "row-top", "pane-editor")).toBeCloseTo(0.45, 1);
    expect(await columnFraction(page, "row-bottom", "pane-console")).toBeCloseTo(0.45, 1);
  });

  // An "and no pane overlaps the one beside it" case was written here and then
  // deleted. It passed against all three un-applications of this group - the
  // grid clips rather than overlapping, so the symptom it named cannot actually
  // occur - which makes it a test that had no way to fail. The boundary
  // assertions above cover the defect it was reaching for.

  test("hiding the tree gives its width back to the panes", async ({ page }) => {
    await open(page, {
      files: FILES,
      settings: {
        layout: { rows: 0.62, columnsTop: 0.45, columnsBottom: 0.45, tree: 0.16 },
        workspace: { folder: PROJECT, tabs: [], active: null },
      },
    });

    const withTree = (await page.locator("#pane-editor").boundingBox()).width;
    await page.locator("#btn-sidebar").click();
    await expect(page.locator("#pane-tree")).toBeHidden();

    const withoutTree = (await page.locator("#pane-editor").boundingBox()).width;
    expect(withoutTree, "the editor did not grow when the tree went away").toBeGreaterThan(
      withTree,
    );
    // And its share of the row is unchanged - it is the row that got wider.
    expect(await columnFraction(page, "row-top", "pane-editor")).toBeCloseTo(0.45, 1);
  });

  test("the tree's splitter goes away with the tree", async ({ page }) => {
    // A handle for dragging the width of something that is not there is five
    // pixels that do nothing.
    await open(page, { files: FILES });
    await expect(page.locator("#splitter-tree")).toBeHidden();
  });
});

test.describe("dragging a boundary", () => {
  test("moves it, and is remembered", async ({ page }) => {
    await open(page, {
      files: FILES,
      settings: { layout: { rows: 0.62, columnsTop: 0.45, columnsBottom: 0.45, tree: 0.16 } },
    });

    const row = await page.locator("#row-top").boundingBox();
    const splitter = await page.locator("#splitter-v-top").boundingBox();

    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width * 0.7, splitter.y + splitter.height / 2, { steps: 8 });
    await page.mouse.up();

    expect(await columnFraction(page, "row-top", "pane-editor")).toBeCloseTo(0.7, 1);

    // Persisted on mouse-up, not on every move: a drag is one decision, and one
    // settings write, not sixty.
    const stored = await page.evaluate(() =>
      JSON.parse(globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/settings.json")),
    );
    expect(stored.layout.columnsTop).toBeCloseTo(0.7, 1);
  });

  test("does not let a pane be squeezed out of existence", async ({ page }) => {
    await open(page, {
      files: FILES,
      settings: { layout: { rows: 0.62, columnsTop: 0.45, columnsBottom: 0.45, tree: 0.16 } },
    });

    const row = await page.locator("#row-top").boundingBox();
    const splitter = await page.locator("#splitter-v-top").boundingBox();

    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
    await page.mouse.down();
    // Well past the right-hand edge, which is what a determined drag does.
    await page.mouse.move(row.x + row.width + 400, splitter.y + splitter.height / 2, { steps: 8 });
    await page.mouse.up();

    const viewer = await page.locator("#pane-viewer").boundingBox();
    expect(viewer.width, "the viewer was squeezed away and could not be dragged back")
      .toBeGreaterThan(20);
  });
});

test.describe("the window comes back where it was left", () => {
  test("a remembered size and position are applied before the window is shown", async ({ page }) => {
    // Neutralino remembers this itself, in .tmp/window_state.config.json beside
    // its own binary - so it survives a restart and is lost on every new
    // install, which is what he reported: unpack a new version and the layout
    // appears to have been forgotten. The splitters were never the problem;
    // they are fractions in settings.json and came back correctly into a window
    // that was suddenly the default size again.
    const { sidecar } = await open(page, {
      files: {},
      settings: { window: { width: 1280, height: 820, x: 120, y: 90 } },
    });
    expect(sidecar).toBeDefined();

    const calls = await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.calls());
    const sized = calls.find((call) => call.name === "setSize");
    const moved = calls.find((call) => call.name === "move");
    const shown = calls.findIndex((call) => call.name === "show");

    expect(sized, "the window was never sized").toBeDefined();
    expect(sized.args[0]).toMatchObject({ width: 1280, height: 820 });
    expect(moved.args).toEqual([120, 90]);

    // Before show(), or the window appears at the default and jumps - which
    // looks like a bug even though it ends up in the right place.
    expect(calls.indexOf(sized)).toBeLessThan(shown);
    expect(calls.indexOf(moved)).toBeLessThan(shown);
  });

  test("with nothing remembered, the window is left alone", async ({ page }) => {
    // A first run must not be sized to anything: the config's own width and
    // height are the answer, and asking for them again would be this module
    // second-guessing the window it was given.
    await open(page, { files: {}, settings: {} });

    const calls = await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.calls());
    expect(calls.filter((call) => call.name === "setSize")).toHaveLength(0);
    expect(calls.filter((call) => call.name === "move")).toHaveLength(0);
  });
});
