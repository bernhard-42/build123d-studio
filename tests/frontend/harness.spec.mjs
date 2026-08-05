/** The harness's own acceptance test.
 *
 * Not a feature test and not a warm-up: this is the gate that decides whether
 * the rest of Phase 5 is worth writing here. A harness is only worth its weight
 * if it can see the defects that previously needed a human at a real build, so
 * it is held to two of them from Phase 4 - one about layout, one about the
 * engine - and each is proved by un-applying the fix.
 *
 * If a case here cannot be made to fail against the code without its fix, it is
 * reported as such rather than kept. A green test that never had the chance to
 * be red is worse than no test, because it gets believed.
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/styles.css, `flex: 0 0 var(--splitter)` off #splitter-tree - the tree
 *   splitter has a width
 * - src/editor/sidebar.js, the icon-font chevron back to a literal U+25B8 /
 *   U+25BE - a folder row's chevron
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";

/** A folder open at startup, which is what puts the sidebar and its splitter up. */
const WITH_FOLDER = {
  settings: {
    workspace: { folder: PROJECT, tabs: [{ path: `${PROJECT}/part.py`, caret: null }], active: `${PROJECT}/part.py` },
  },
  files: {
    [`${PROJECT}/part.py`]: "from build123d import *\n\nb = Box(1, 2, 3)\n",
    [`${PROJECT}/README.md`]: "# bracket\n",
    [`${PROJECT}/exports/bracket.step`]: "ISO-10303-21;\n",
  },
};

test.describe("the harness can see what a browser-shaped one cannot", () => {
  test("the application boots with only the native layer replaced", async ({ page }) => {
    const { problems } = await open(page);

    // Every pane the application promises, present and laid out.
    for (const pane of [".pane-editor", ".pane-viewer", ".pane-console", ".pane-vars"]) {
      const box = await page.locator(pane).first().boundingBox();
      expect(box, `${pane} was not laid out`).not.toBeNull();
      expect(box.width, `${pane} has no width`).toBeGreaterThan(0);
      expect(box.height, `${pane} has no height`).toBeGreaterThan(0);
    }

    // Monaco is the real one, not a textarea standing in for it.
    await expect(page.locator(".monaco-editor").first()).toBeVisible();

    expect(problems, "the page reported errors while starting").toEqual([]);
  });

  test("the tree splitter has a width when the sidebar is open", async ({ page }) => {
    // Phase 4 group 2. `.splitter-v` positions itself with grid-column, and the
    // sidebar's row is flex - where grid-column means nothing - so the splitter
    // was five pixels of nothing to grab. Found only by dragging at it on a real
    // build, and invisible to every test this project had.
    //
    // This is the case that rules jsdom out. It has no layout engine, so every
    // width it reports is zero and the assertion below cannot distinguish a
    // splitter that works from one that does not.
    await open(page, WITH_FOLDER);

    const splitter = page.locator("#splitter-tree");
    await expect(splitter).toBeVisible();

    const box = await splitter.boundingBox();
    expect(box, "the tree splitter was not laid out at all").not.toBeNull();
    // Not "> 0": the defect produced a zero-width box, and a one-pixel one would
    // be just as ungrabbable. --splitter is 5px, so anything at or near it is
    // right and anything under three is the bug.
    expect(box.width, "the tree splitter is too thin to grab").toBeGreaterThanOrEqual(3);
  });

  test("a folder row's chevron is painted by the bundled icon font", async ({ page }) => {
    // Phase 4 group 2, the other one. `▸` and `▾` have no glyph in WKWebView and
    // render as a dot, so folder rows use the bundled Material Symbols subset -
    // which either renders or nothing does.
    //
    // Asserted as "which font paints it", because that is what the fix changed,
    // and NOT as "the triangle is invisible" - the test below measured this
    // engine and it *has* a glyph for U+25B8, so the original symptom does not
    // reproduce here. What this catches is a regression away from the icon
    // font; whether a bare character would render is still a question only a
    // real WKWebView build answers.
    await open(page, WITH_FOLDER);

    const chevron = page.locator(".tree-row .icon-chevron").first();
    await expect(chevron).toBeVisible();

    // The glyph lives on ::before, so the element's own font says nothing - it
    // reports the body font and an assertion against it fails on correct code.
    const painted = await chevron.evaluate((el) => {
      const before = getComputedStyle(el, "::before");
      return { font: before.fontFamily, content: before.content };
    });
    expect(painted.font.toLowerCase(), "the chevron is not painted by the icon font").toContain(
      "material symbols",
    );
    expect(painted.content, "the chevron has no glyph to paint").not.toBe("none");

    const box = await chevron.boundingBox();
    expect(box.width, "the chevron has no width").toBeGreaterThan(0);
    expect(box.height, "the chevron has no height").toBeGreaterThan(0);
  });

  test("REPORT: does this engine lack the ▸ glyph the way WKWebView does", async ({ page }) => {
    // Deliberately not an assertion about the application. It measures the
    // *harness* - whether Playwright's WebKit reproduces the glyph gap that
    // made the original defect - so that the answer is on the record instead of
    // being assumed by whoever writes the next test.
    //
    // Measured, WebKit 26.5 / playwright v2336 on macOS: ▸ is 7.23px against
    // 9.02px for "n" and 16.23px for the replacement character. A missing glyph
    // would advance like the replacement; this one does not, so **this engine
    // has the glyph and the original defect does not reproduce here**. The
    // system font stack differs from the one a packaged WKWebView resolves.
    //
    // The consequence is worth stating plainly rather than discovering later:
    // glyph *availability* is not something this suite can answer, and it stays
    // a human test on a real build. What the suite can hold is that the
    // application keeps using the bundled font instead of trusting one.
    await open(page);

    const measurement = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      context.font = "16px system-ui";
      const widthOf = (text) => context.measureText(text).width;
      return {
        triangle: widthOf("▸"),
        // A character certain to be present, as the yardstick, and the
        // replacement box's own width for comparison.
        letter: widthOf("n"),
        notdef: widthOf("�"),
      };
    });

    // Recorded, not asserted. A missing glyph does not report itself; the tell
    // is the advance width matching the fallback rather than a real one.
    console.log(
      `    engine glyph widths: ▸=${measurement.triangle} n=${measurement.letter} ` +
        `�=${measurement.notdef}`,
    );
    expect(measurement.letter).toBeGreaterThan(0);
  });
});
