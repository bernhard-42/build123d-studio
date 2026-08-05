/** What the editor refuses to open, and what it asks about first.
 *
 * Both guards run before the file is read, which is the half a unit test cannot
 * see: `filetype.js` is pure and says what the bytes mean, and nothing in it can
 * say whether the application then stopped. The assertions below are therefore
 * about what is on screen and what crossed the boundary - a tab that did not
 * appear, a read that did not happen - rather than about which function ran.
 *
 * The size case is deliberately not about the editor being slow. Measured in
 * this harness, a 32 MB file appears in a tab in 152 ms because Monaco
 * tokenises the viewport rather than the document; what costs is that the whole
 * buffer goes for analysis on open and after every edit. So the question is
 * asked, and answering it with Load is a perfectly ordinary thing to do.
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/editor/filetype.js, looksBinary()'s scan for a NUL - a file that is
 *   not text is refused, and is never read whole
 * - src/editor/filetype.js, isLarge() answering false - a large file asks,
 *   Load opens it, only the front is looked at, and an open tab is not asked
 *   about twice
 * - src/editor/files.js, the mayOpen() call in openPath - every case here
 *   except the ordinary file, which correctly stays green
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";

// A PNG's first bytes. The signature alone carries no NUL - the first one is in
// the IHDR chunk's length field right after it - which is why the application
// sniffs thousands of bytes and not eight.
const PNG = "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0001\u0000";

// Past the ten megabyte threshold, and ASCII so its length is its size.
const HUGE = "b = Box(1, 2, 3)\n".repeat(700000);

const FILES = {
  [`${PROJECT}/part.py`]: "PART = 1\n",
  [`${PROJECT}/plate.py`]: "PLATE = 1\n",
  [`${PROJECT}/logo.png`]: PNG,
  [`${PROJECT}/assembly.step`]: HUGE,
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

/** Every native call the application has made, for asserting on what it read. */
function nativeCalls(page) {
  return page.evaluate(() => globalThis.__NEUTRALINO_STUB__.calls());
}

function clickInTree(page, name) {
  return page.locator(".tree-file", { hasText: name }).click();
}

test.describe("what will not be opened", () => {
  test("a file that is not text is refused, and no tab appears", async ({ page }) => {
    await openApp(page);

    await clickInTree(page, "logo.png");

    const calls = await nativeCalls(page);
    const box = calls.find((call) => call.name === "showMessageBox");
    expect(box, "nothing was said about the file being refused").toBeDefined();
    expect(box.args[0]).toBe("Not a text file");
    // A warning rather than an error: the application is working, and the user
    // is entitled to have a PNG in their project.
    expect(box.args[3]).toBe("WARNING");

    await expect(page.locator(".tab-label", { hasText: "logo.png" })).toHaveCount(0);
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
  });

  test("the refused file is never read whole", async ({ page }) => {
    // The point of sniffing a prefix. Reading the file to find out whether it
    // should be read would put a 400 MB STL in memory to reject it.
    await openApp(page);

    await clickInTree(page, "logo.png");

    const calls = await nativeCalls(page);
    const read = calls.filter(
      (call) => call.name === "readFile" && call.args[0] === `${PROJECT}/logo.png`,
    );
    expect(read, "the file was read despite being refused").toHaveLength(0);
  });

  test("an ordinary file opens with nothing asked", async ({ page }) => {
    // The guard has to be invisible on the files this editor is actually for,
    // or it is a dialog between the user and every open.
    await openApp(page);

    await clickInTree(page, "plate.py");

    await expect(page.locator(".tab-active .tab-label")).toHaveText("plate.py");
    await expect(page.locator(".confirm-overlay")).toBeHidden();
    const calls = await nativeCalls(page);
    expect(calls.filter((call) => call.name === "showMessageBox")).toHaveLength(0);
  });
});

test.describe("what is asked about first", () => {
  test("a large file asks, and Cancel opens nothing", async ({ page }) => {
    await openApp(page);

    await clickInTree(page, "assembly.step");

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    const asked = await page.locator(".confirm-overlay").innerText();
    expect(asked).toContain("large file");
    expect(asked).toContain("MB");
    // Two buttons and no third: this question has no middle answer, and a
    // "Discard" left over from the unsaved prompt would be a button that means
    // nothing here.
    await expect(page.locator(".confirm-overlay [data-answer]:visible")).toHaveCount(2);

    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    await expect(page.locator(".confirm-overlay")).toBeHidden();
    await expect(page.locator(".tab-label", { hasText: "assembly.step" })).toHaveCount(0);
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
  });

  test("Load opens it", async ({ page }) => {
    await openApp(page);

    await clickInTree(page, "assembly.step");
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect(page.locator(".tab-active .tab-label")).toHaveText("assembly.step");
  });

  test("only the front of it is looked at before the question", async ({ page }) => {
    await openApp(page);

    await clickInTree(page, "assembly.step");
    await expect(page.locator(".confirm-overlay")).toBeVisible();

    const calls = await nativeCalls(page);
    const sniff = calls.find(
      (call) => call.name === "readBinaryFile" && call.args[0] === `${PROJECT}/assembly.step`,
    );
    expect(sniff, "the file was not sniffed at all").toBeDefined();
    expect(sniff.args[1].pos).toBe(0);
    expect(sniff.args[1].size).toBe(8000);
  });

  test("a file already in a tab is not asked about again", async ({ page }) => {
    // It was answered for when it was opened. Asking on every click would be
    // the application arguing with itself about a file that is on screen.
    await openApp(page);

    await clickInTree(page, "assembly.step");
    await page.locator('.confirm-overlay [data-answer="save"]').click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("assembly.step");

    await page.locator(".tab", { hasText: "part.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
    await clickInTree(page, "assembly.step");

    await expect(page.locator(".confirm-overlay")).toBeHidden();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("assembly.step");
  });
});
