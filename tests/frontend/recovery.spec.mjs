// Recovering what a crash left behind.
//
// None of this can be reached by using the application: every graceful exit
// prompts and then clears the journal, so the state under test - copies left
// by a session that ended without being asked - only exists after a webview
// dies, a kill, a logout that never delivers windowClose, or a power cut.
//
// So the crash is staged: recovery copies are seeded before the window opens,
// exactly as a dead instance would have left them, and the beat file's age is
// what says whether that instance is still running.

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const SOURCE = "from build123d import *\n\nb = Box(1, 2, 3)\n";
const FILES = { [`${PROJECT}/part.py`]: SOURCE };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

const RECOVERY = "/appdata/build123d-studio/recovery";
const DEAD = `${RECOVERY}/deadbeef`;
const ALSO_DEAD = `${RECOVERY}/deadbe11`;

/** A session that crashed with unsaved work in it. */
function crashed(root, entries) {
  const files = { [`${root}/alive`]: "" };
  for (const [key, { path, text }] of Object.entries(entries)) {
    files[`${root}/${key}.py`] = text;
    files[`${root}/${key}.json`] = JSON.stringify({ path });
  }
  return files;
}

async function openApp(page, extraFiles = {}) {
  return open(page, {
    files: { ...FILES, ...extraFiles },
    settings: { workspace: WORKSPACE },
  });
}

const tabLabels = (page) => page.locator(".tab .tab-label").allTextContents();

test.describe("a session that ended without being asked", () => {
  test("its unsaved work is offered back, and arrives modified", async ({ page }) => {
    await openApp(page, crashed(DEAD, {
      7: { path: `${PROJECT}/bracket.py`, text: "RECOVERED = 1\n" },
    }));

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    expect(await page.locator(".confirm-overlay").innerText()).toContain("bracket.py");
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(() => tabLabels(page)).toContain("bracket.py");
    // Dirty, because the text was never written. Nothing has touched disk.
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);
    expect(
      await page.evaluate(
        (p) => globalThis.__NEUTRALINO_STUB__.wrote(p),
        `${PROJECT}/bracket.py`,
      ),
      "recovery wrote to disk; it must only offer",
    ).toBe(undefined);
  });

  test("an untitled buffer comes back too", async ({ page }) => {
    // The one with no other copy anywhere.
    await openApp(page, crashed(DEAD, { 3: { path: null, text: "SCRATCH = 1\n" } }));

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    expect(await page.locator(".confirm-overlay").innerText()).toContain("(untitled)");
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);
  });

  test("two dead sessions are offered together, in one prompt", async ({ page }) => {
    await openApp(page, {
      ...crashed(DEAD, { 7: { path: `${PROJECT}/one.py`, text: "ONE\n" } }),
      ...crashed(ALSO_DEAD, { 4: { path: `${PROJECT}/two.py`, text: "TWO\n" } }),
    });

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    const text = await page.locator(".confirm-overlay").innerText();
    expect(text).toContain("one.py");
    expect(text).toContain("two.py");
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(() => tabLabels(page)).toContain("one.py");
    await expect.poll(() => tabLabels(page)).toContain("two.py");
  });

  test("Discard throws the copies away rather than leaving them to ask again", async ({ page }) => {
    await openApp(page, crashed(DEAD, {
      7: { path: `${PROJECT}/bracket.py`, text: "RECOVERED = 1\n" },
    }));

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    await expect.poll(() => tabLabels(page)).not.toContain("bracket.py");
    await expect
      .poll(() => page.evaluate((p) => globalThis.__NEUTRALINO_STUB__.wrote(p), `${DEAD}/7.py`))
      .toBe(undefined);
  });

  test("and the same file in two sessions gives one tab, not two", async ({ page }) => {
    // Two tabs on one path is a state with no correct behaviour left in it, so
    // the loser stays on disk as an ordinary source file instead.
    await openApp(page, {
      ...crashed(DEAD, { 7: { path: `${PROJECT}/same.py`, text: "FIRST\n" } }),
      ...crashed(ALSO_DEAD, { 4: { path: `${PROJECT}/same.py`, text: "SECOND\n" } }),
    });

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(async () => (await tabLabels(page)).filter((l) => l === "same.py").length)
      .toBe(1);
  });
});

test.describe("a session that is still running", () => {
  test("is left alone, however much unsaved work it has", async ({ page }) => {
    // The dangerous mistake. Offering a live window's unsaved work to another
    // window takes it from somebody who is still typing it.
    const files = crashed(DEAD, {
      7: { path: `${PROJECT}/theirs.py`, text: "THEIRS = 1\n" },
    });
    await open(page, {
      files: { ...FILES, ...files },
      settings: { workspace: WORKSPACE },
      // Beating as of now, which is what a window somebody is typing in looks
      // like. Everything else the stub stamps is a counter, and therefore old.
      times: { [`${DEAD}/alive`]: Date.now() },
    });

    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
    await expect.poll(() => tabLabels(page)).not.toContain("theirs.py");
  });
});

test.describe("an ordinary start", () => {
  test("asks nothing when nothing crashed", async ({ page }) => {
    await openApp(page);

    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
    await expect.poll(() => tabLabels(page)).toEqual(["part.py"]);
  });
});
