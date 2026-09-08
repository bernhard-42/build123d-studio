// Dragging the toolbar sideways when the window is too narrow for it.
//
// The row scrolls and draws no scrollbar, so what is left is Shift-wheel, which
// nobody guesses, and dragging, which everybody tries and which a browser does
// not provide for a mouse. The two claims worth holding are that a drag scrolls
// the row, and that it does not press the button it started on - the row is
// covered in buttons, and getting that wrong turns every drag into a Run.

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = { folder: PROJECT, tabs: [{ path: `${PROJECT}/part.py`, caret: null }], active: `${PROJECT}/part.py` };

/** Narrow enough that the buttons do not fit, which is the only time this runs. */
async function openNarrow(page) {
  await page.setViewportSize({ width: 620, height: 700 });
  const handles = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
  await expect(page.locator("#btn-run-file")).toBeVisible();
  const overflowing = await page.evaluate(() => {
    const bar = document.querySelector(".toolbar");
    return bar.scrollWidth > bar.clientWidth;
  });
  expect(overflowing, "the toolbar has to overflow for any of this to mean anything").toBe(true);
  return handles;
}

const scrollLeft = (page) =>
  page.evaluate(() => document.querySelector(".toolbar").scrollLeft);

/**
 * Drag the row by `distance` pixels; negative scrolls it forward.
 *
 * Started from the side the drag is heading away from, because the pointer
 * cannot leave the viewport - a drag to the right that begins at the right edge
 * has nowhere to go and moves nothing, which is a fact about the mouse and not
 * about the toolbar.
 */
async function dragBy(page, distance) {
  const box = await page.locator(".toolbar").boundingBox();
  const y = box.y + box.height / 2;
  const from = distance < 0 ? box.x + box.width - 12 : box.x + 12;
  await page.mouse.move(from, y);
  await page.mouse.down();
  // In steps, because one jump is not a drag: the threshold has to be crossed
  // by a move, exactly as a hand does it.
  await page.mouse.move(from + distance, y, { steps: 8 });
  await page.mouse.up();
}

test.describe("dragging the toolbar", () => {
  test("a drag to the left scrolls it, without a scrollbar to grab", async ({ page }) => {
    await openNarrow(page);
    expect(await scrollLeft(page)).toBe(0);

    await dragBy(page, -160);

    expect(await scrollLeft(page)).toBeGreaterThan(100);
  });

  test("and dragging back returns it", async ({ page }) => {
    await openNarrow(page);
    await dragBy(page, -160);
    expect(await scrollLeft(page)).toBeGreaterThan(100);

    await dragBy(page, 160);

    expect(await scrollLeft(page)).toBe(0);
  });

  test("a drag that starts on a button does not press it", async ({ page }) => {
    // The failure this prevents: every drag across the row runs the file.
    const { sidecar } = await openNarrow(page);
    const button = page.locator("#btn-run-file");
    const box = await button.boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    expect(await scrollLeft(page)).toBeGreaterThan(50);
    expect(sidecar.received.filter((frame) => frame.type === "run.start")).toEqual([]);
  });

  test("but a click that does not move still presses it", async ({ page }) => {
    // The other half, and the one a threshold gets wrong: a press that stays
    // still is an ordinary click and must reach the button.
    await openNarrow(page);

    await page.locator("#btn-info").click();

    await expect(page.locator("#info-dialog")).toBeVisible();
  });
});
