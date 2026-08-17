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

/** What the editor shows, with Monaco's non-breaking spaces normalised. */
async function editorText(page) {
  const text = await page.locator(".monaco-editor .view-lines").first().innerText();
  return text.replace(/\u00a0/g, " ");
}

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

  test("Not now leaves the copies where they are", async ({ page }) => {
    // Escape maps to cancel, and cancel used to mean Discard - so the reflexive
    // dismiss-a-dialog keypress, moments after a crash, deleted the only copy
    // of the work. It now means "ask me again next start".
    await openApp(page, crashed(DEAD, {
      7: { path: `${PROJECT}/bracket.py`, text: "RECOVERED = 1\n" },
    }));

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.keyboard.press("Escape");

    await expect.poll(() => tabLabels(page)).not.toContain("bracket.py");
    expect(
      await page.evaluate((p) => globalThis.__NEUTRALINO_STUB__.wrote(p), `${DEAD}/7.py`),
      "dismissing the dialog destroyed the copy",
    ).toBe("RECOVERED = 1\n");
  });

  test("Discard throws the copies away rather than leaving them to ask again", async ({ page }) => {
    await openApp(page, crashed(DEAD, {
      7: { path: `${PROJECT}/bracket.py`, text: "RECOVERED = 1\n" },
    }));

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="discard"]').click();

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

test.describe("a file that the session restore has already reopened", () => {
  /**
   * The case every other test here missed, and the one that matters most.
   *
   * The workspace remembers which files were open and the restore runs first,
   * so after a crash the tab is already back - holding what is *on disk*, which
   * is the text from before the unsaved edits. The recovery copy holds the
   * newer work. Treating "already open" as "nothing to do" recovered nothing at
   * all for every named file, and then deleted the copy.
   *
   * Every earlier case in this file recovers a path the workspace does not
   * mention, which is why they all passed against that.
   */
  test("its unsaved text replaces what was read from disk", async ({ page }) => {
    await openApp(page, crashed(DEAD, {
      7: { path: `${PROJECT}/part.py`, text: "UNSAVED = 1\n" },
    }));

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    // The tab it already had, now holding the work rather than the disk text.
    await expect.poll(async () => (await tabLabels(page)).filter((l) => l === "part.py").length)
      .toBe(1);
    await expect
      .poll(() => editorText(page))
      .toContain("UNSAVED = 1");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);
    // And nothing was written: recovery offers, it does not save.
    expect(
      await page.evaluate((p) => globalThis.__NEUTRALINO_STUB__.wrote(p), `${PROJECT}/part.py`),
    ).toBe(SOURCE);
  });

  test("and the recovered work is shadowed again straight away", async ({ page }) => {
    // Otherwise the only durable copy has just been deleted, and a second crash
    // takes work the user explicitly chose to recover.
    await openApp(page, crashed(DEAD, {
      7: { path: `${PROJECT}/part.py`, text: "UNSAVED = 1\n" },
    }));

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);

    await expect
      .poll(async () => {
        const written = await page.evaluate(() =>
          globalThis.__NEUTRALINO_STUB__
            .calls()
            .filter((call) => call.name === "writeFile")
            .map((call) => String(call.args[1] ?? "")),
        );
        return written.some((body) => body.includes("UNSAVED = 1"));
      }, { message: "the recovered text was never copied into this session's journal" })
      .toBe(true);
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
