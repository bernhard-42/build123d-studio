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

/** A session that crashed with unsaved work in it.
 *
 * It names the process that owned it, which is the whole of how a dead session
 * is told from a live one now - the operating system is asked which pids are
 * still windows of this application, and 31337 is not one of them. There is no
 * clock in this any more, and no beat: an age could not distinguish a window
 * that had died from a machine that had slept, and got both wrong.
 */
const DEAD_PID = 31337;

function crashed(root, entries, pid = DEAD_PID) {
  const files = { [`${root}/owner`]: String(pid) };
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

  test("and joins the empty tab a start with nothing to reopen leaves", async ({ page }) => {
    // The workspace remembers paths and never contents, so an untitled buffer
    // is not among the tabs that reopen. When it was the only one, the start
    // has nothing to restore and puts up an empty scratch tab - and recovery
    // used to open its own beside it, leaving two untitled tabs, one empty and
    // one holding the work. Reported on Windows against 0.3.0.dev167.
    await open(page, {
      files: { ...FILES, ...crashed(DEAD, { 3: { path: null, text: "SCRATCH = 1\n" } }) },
      settings: { sampleShown: true },
    });

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(() => tabLabels(page)).toHaveLength(1);
    await expect.poll(() => editorText(page)).toContain("SCRATCH = 1");
    // And it is dirty: the text has never been anywhere but memory.
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

  test("and the same file in two sessions gives one tab, holding the newer copy", async ({ page }) => {
    // Two tabs on one path is a state with no correct behaviour left in it, so
    // the loser stays on disk as an ordinary source file instead.
    //
    // Which one loses is decided by when each session last wrote a copy - the
    // one somebody was working in most recently wins. Seeded here so the answer
    // cannot come out of the order the fixture happens to be built in.
    await open(page, {
      files: {
        ...FILES,
        // Deliberately against the order they are seeded in: the session that
        // should win is the one listed *first*, so an implementation that keeps
        // the scan order instead of sorting by time picks the other one.
        ...crashed(DEAD, { 7: { path: `${PROJECT}/same.py`, text: "NEWER\n" } }),
        ...crashed(ALSO_DEAD, { 4: { path: `${PROJECT}/same.py`, text: "OLDER\n" } }),
      },
      settings: { workspace: WORKSPACE },
      times: {
        [`${DEAD}/7.py`]: 2_000_000,
        [`${ALSO_DEAD}/4.py`]: 1_000_000,
      },
    });

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(async () => (await tabLabels(page)).filter((l) => l === "same.py").length)
      .toBe(1);
    await expect.poll(() => editorText(page), { message: "the older copy won" })
      .toContain("NEWER");
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
    // window takes it from somebody who is still typing it, and then deletes
    // the only copy protecting them.
    //
    // What makes it live here is the same thing that makes it live in
    // production: its pid is in the process listing. Not a fresh timestamp,
    // which is what this used to assert and which was also true of a session
    // that had died two seconds ago.
    const LIVE_PID = 4321;
    const files = crashed(DEAD, {
      7: { path: `${PROJECT}/theirs.py`, text: "THEIRS = 1\n" },
    }, LIVE_PID);
    await open(page, {
      files: { ...FILES, ...files },
      settings: { workspace: WORKSPACE },
      running: [LIVE_PID],
    });

    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
    await expect.poll(() => tabLabels(page)).not.toContain("theirs.py");
  });

  test("but this window's own previous journal is not a sibling", async ({ page }) => {
    // A reload gives the page a new instance and a new journal while the
    // process id stays exactly what it was - so the page's *own* last journal
    // looked like a live window's and was skipped out of politeness to itself.
    // That is not a corner case: reloading is what a window does when its link
    // to the application dies, which is precisely when there is unsaved work
    // waiting on the other side. Reported on Windows, 0.3.0.dev176 - the reload
    // came back with the file as it was on disk and no prompt at all.
    const OUR_PID = 4242; // what the harness reports as NL_PID
    const files = crashed(DEAD, {
      7: { path: `${PROJECT}/mine.py`, text: "MINE = 1\n" },
    }, OUR_PID);
    await open(page, {
      files: { ...FILES, ...files },
      settings: { workspace: WORKSPACE },
      running: [OUR_PID],
    });

    const prompt = page.locator(".confirm-overlay");
    await expect(prompt).toBeVisible();
    expect(await prompt.innerText()).toContain("mine.py");
  });

  test("and Discard, answered for a dead session, does not take its copies too", async ({ page }) => {
    // The half that costs work rather than attention. Two journals are here:
    // one whose window died, one whose window is running. Answering the prompt
    // for the dead one must not clear the live one, which would leave a window
    // somebody is typing in with no crash protection and nothing said about it.
    const LIVE_PID = 4321;
    const files = {
      ...crashed(DEAD, { 7: { path: `${PROJECT}/theirs.py`, text: "THEIRS = 1\n" } }, LIVE_PID),
      ...crashed(ALSO_DEAD, { 8: { path: `${PROJECT}/gone.py`, text: "GONE = 1\n" } }),
    };
    await open(page, {
      files: { ...FILES, ...files },
      settings: { workspace: WORKSPACE },
      running: [LIVE_PID],
    });

    // Only the dead one is named.
    const prompt = page.locator(".confirm-overlay");
    await expect(prompt).toBeVisible();
    expect(await prompt.innerText()).toContain("gone.py");
    expect(await prompt.innerText()).not.toContain("theirs.py");

    await page.locator('.confirm-overlay [data-answer="discard"]').click();

    await expect
      .poll(() => page.evaluate((root) => String(
        globalThis.__NEUTRALINO_STUB__.wrote(`${root}/7.py`) ?? "",
      ), DEAD), { message: "a running window's copies were discarded with somebody else's" })
      .toContain("THEIRS = 1");
    await expect
      .poll(() => page.evaluate((root) => String(
        globalThis.__NEUTRALINO_STUB__.wrote(`${root}/8.py`) ?? "",
      ), ALSO_DEAD), { message: "the dead session's copies were not discarded" })
      .toBe("");
  });
});

test.describe("a session killed moments before this one started", () => {
  test("is offered at once, with no window to wait out", async ({ page }) => {
    // The way anybody actually reaches this state: kill the application, start
    // it again. Measured at seven seconds between the two - and under the old
    // heartbeat that was inside the ninety-second window in which a dead
    // session still looked alive, so nothing was offered. Every retry landed in
    // the same window, so it was deferred for ever rather than to the next
    // start.
    //
    // Nothing here has aged at all. The pid is simply not running.
    const files = crashed(DEAD, {
      4: { path: `${PROJECT}/killed.py`, text: "KILLED = 1\n" },
    });
    await open(page, {
      files: { ...FILES, ...files },
      settings: { workspace: WORKSPACE },
    });

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();
    await expect.poll(() => tabLabels(page)).toContain("killed.py");
  });
});

test.describe("a process listing that cannot be established", () => {
  test("offers the work anyway, and deletes nothing", async ({ page }) => {
    // `ps` failing must not mean somebody is told nothing about work they have
    // just lost - but it must not mean deleting a journal either, because "I
    // could not find out" is not "nobody is there". So the copies are offered
    // and left where they are, to be offered again next time.
    const files = crashed(DEAD, {
      5: { path: `${PROJECT}/unsure.py`, text: "UNSURE = 1\n" },
    });
    await open(page, {
      files: { ...FILES, ...files },
      settings: { workspace: WORKSPACE },
      brokenListing: true,
    });

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="discard"]').click();

    await expect
      .poll(() => page.evaluate((root) => String(
        globalThis.__NEUTRALINO_STUB__.wrote(`${root}/5.py`) ?? "",
      ), DEAD), { message: "a journal was deleted without knowing whether it was live" })
      .toContain("UNSURE = 1");
  });
});

test.describe("an ordinary start", () => {
  test("asks nothing when nothing crashed", async ({ page }) => {
    await openApp(page);

    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
    await expect.poll(() => tabLabels(page)).toEqual(["part.py"]);
  });
});
