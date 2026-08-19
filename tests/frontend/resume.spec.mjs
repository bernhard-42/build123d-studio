// Waking up: what survives a machine coming back from sleep.
//
// Windows resets loopback connections across a suspend, and the page holds two
// of them: one to the sidecar, one to Neutralino's own server. Both die, and
// they fail in completely different ways.
//
// The sidecar's is recoverable and now recovered. The sidecar clears its client
// and goes back to accepting, its token is a constant rather than single-use,
// and its kernel, console, language server and namespace are untouched - so the
// socket only has to be redialled. Reported as a dead backend, it cost the
// user everything in the namespace to fix a link.
//
// Neutralino's is not recoverable from JavaScript: the client builds its socket
// once at init, and with it down every native call is *queued and never
// rejected* - no file is written, no process is spawned, and app.exit() never
// happens, so the window cannot even be closed. Observed on Windows at
// 0.3.0.dev173: the log stopped mid-session, Restart never returned, and the X
// did nothing. All this half can do is say so and offer the one way back.

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

const openApp = (page) =>
  open(page, { files: FILES, settings: { workspace: WORKSPACE } });

const banner = (page) => page.locator("#backend-banner");
const bannerText = (page) => page.locator("#backend-banner-text");

test.describe("the socket to the sidecar drops", () => {
  test("it is dialled again, and nothing is said", async ({ page }) => {
    // The sidecar never went anywhere, so there is nothing to report and
    // nothing to restart: the namespace, the console and the kernel are all
    // still there behind the port that just stopped answering.
    const { sidecar } = await openApp(page);
    expect(sidecar.connections).toBe(1);

    await page.evaluate(() => {});
    sidecar.drop();

    await expect.poll(() => sidecar.connections, { timeout: 15000 }).toBe(2);
    await expect(banner(page)).toBeHidden();
  });

  test("and the session goes on working afterwards", async ({ page }) => {
    // A reconnection that leaves the page unable to send anything would be
    // worse than the banner: it would look fixed and not be.
    const { sidecar } = await openApp(page);
    sidecar.drop();
    await expect.poll(() => sidecar.connections, { timeout: 15000 }).toBe(2);

    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Alt+Enter");

    await sidecar.waitFor("kernel.execute");
    expect(sidecar.received.some((frame) => frame.type === "kernel.execute")).toBe(true);
  });
});

test.describe("the link to the application dies", () => {
  test("it says so, and offers the only way back", async ({ page }) => {
    await openApp(page);

    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("serverOffline", {}));

    await expect(banner(page)).toBeVisible();
    expect(await bannerText(page).innerText()).toContain("lost its link");
    await expect(page.locator("#backend-banner-restart")).toHaveText("Reload window");
  });

  test("and the banner does not cover the menus", async ({ page }) => {
    // The banner is fixed to the top of the window and the in-window menu strip
    // lives there too. Covering it hides File, and with it Save and Quit, at
    // the one moment somebody needs them - which is what happened on Windows,
    // where the strip exists and macOS's system menu does not.
    await open(page, { platform: "Windows", files: FILES, settings: { workspace: WORKSPACE } });

    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("serverOffline", {}));
    await expect(banner(page)).toBeVisible();

    const measured = await page.evaluate(() => ({
      bar: document.getElementById("titlebar").getBoundingClientRect(),
      banner: document.getElementById("backend-banner").getBoundingClientRect(),
    }));

    expect(measured.banner.top).toBeGreaterThanOrEqual(measured.bar.bottom);
  });

  test("on macOS it starts at the top, because there is no strip", async ({ page }) => {
    await open(page, { platform: "Darwin", files: FILES, settings: { workspace: WORKSPACE } });

    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("serverOffline", {}));

    await expect.poll(() =>
      page.evaluate(() => document.getElementById("backend-banner").getBoundingClientRect().top),
    ).toBe(0);
  });
});

test.describe("the link stops answering without closing", () => {
  // The half-open case, and the one that matters most: on Windows the socket to
  // Neutralino stayed open as far as the page could tell while every call
  // vanished into it. No close event, so no serverOffline, so nothing on
  // screen - saving, quitting and even logging silently did nothing.

  test("it is noticed, and the same way out is offered", async ({ page }) => {
    // At the shipped interval this takes two probes and their deadlines - about
    // forty seconds. Run against the real numbers rather than injected ones,
    // because the numbers are the design: they are what decides between telling
    // somebody to reload a window that was fine and leaving them wondering why
    // Save does nothing.
    test.setTimeout(120000);
    await openApp(page);

    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.goSilent());

    // Two missed probes at the shipped interval; the poll is what waits.
    await expect(banner(page)).toBeVisible({ timeout: 60000 });
    expect(await bannerText(page).innerText()).toContain("lost its link");
    await expect(page.locator("#backend-banner-restart")).toHaveText("Reload window");
  });
});

test.describe("work typed after the link died", () => {
  // The journal is written through Neutralino, so when that link dies every
  // copy is queued for ever - the one moment a window most needs to record
  // unsaved work is the moment it cannot. localStorage needs no native call and
  // survives the reload the dead link forces, so the dirty buffers are mirrored
  // there as well. Reported on Windows, 0.3.0.dev176: the reload came back with
  // the file exactly as it had been on disk.

  test("comes back after the reload the dead link forces", async ({ page }) => {
    await openApp(page);
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type("\nTYPED_AFTER_THE_LINK_DIED = 1");

    // The mirror is written on the same beat as the journal.
    await expect.poll(() =>
      page.evaluate(() =>
        (localStorage.getItem("build123d-studio.unsaved") ?? "").includes("TYPED_AFTER"),
      ),
    ).toBe(true);

    await page.reload();

    const prompt = page.locator(".confirm-overlay");
    await expect(prompt).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(async () =>
      (await page.locator(".monaco-editor .view-lines").first().innerText())
        .replace(/ /g, " "),
    ).toContain("TYPED_AFTER_THE_LINK_DIED");
  });

  test("is one file to recover when a journal holds it too", async ({ page }) => {
    // Both copies, seeded rather than typed - which matters, because a version
    // of this test that typed and waited only for the mirror found one copy,
    // had nothing to deduplicate, and passed against the very bug it was
    // written for. Reported on Windows, 0.3.0.dev177: "2 file(s) ...
    // untitled1.py, untitled1.py" for one file.
    const DEAD = "/appdata/build123d-studio/recovery/deadbeef";
    await open(page, {
      files: {
        ...FILES,
        [`${DEAD}/owner`]: "31337",
        [`${DEAD}/7.py`]: "PART = 1\n # from the journal",
        [`${DEAD}/7.json`]: JSON.stringify({ path: `${PROJECT}/part.py` }),
      },
      settings: { workspace: WORKSPACE },
      stored: {
        "build123d-studio.unsaved": JSON.stringify({
          pid: "4242",
          entries: [{ path: `${PROJECT}/part.py`, text: "PART = 1\n # from the mirror" }],
        }),
      },
    });

    const prompt = page.locator(".confirm-overlay");
    await expect(prompt).toBeVisible();
    const detail = await prompt.innerText();
    expect(detail).toContain("1 file(s)");
    expect(detail.match(/part\.py/g)).toHaveLength(1);

    // And the copy that wins is the mirror's, because it is the only one that
    // can be newer than the journal.
    await page.locator('.confirm-overlay [data-answer="save"]').click();
    await expect.poll(async () =>
      (await page.locator(".monaco-editor .view-lines").first().innerText()).replace(/\u00a0/g, " "),
    ).toContain("from the mirror");
  });

  test("is one file to recover, however many copies hold it", async ({ page }) => {
    // The journal has it and so does the mirror, and they are the same file.
    // Built from the raw list, the prompt said "2 file(s) ... untitled1.py,
    // untitled1.py" while only ever recovering one. Reported on Windows,
    // 0.3.0.dev177.
    await openApp(page);
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" # edited");

    // Both copies, and waiting for both is the whole point: the mirror is
    // written synchronously and the journal a second after the typing stops, so
    // a test that waits only for the mirror finds one copy, has nothing to
    // deduplicate, and passes against the bug it was written for.
    await expect.poll(() =>
      page.evaluate(() => localStorage.getItem("build123d-studio.unsaved") !== null),
    ).toBe(true);
    await expect.poll(() =>
      page.evaluate(() =>
        globalThis.__NEUTRALINO_STUB__.paths()
          .filter((path) => path.includes("/recovery/") && path.endsWith(".py")).length,
      ), { timeout: 10000 },
    ).toBeGreaterThan(0);

    await page.reload();

    const prompt = page.locator(".confirm-overlay");
    await expect(prompt).toBeVisible();
    const detail = await prompt.innerText();
    expect(detail).toContain("1 file(s)");
    expect(detail.match(/part\.py/g)).toHaveLength(1);
  });

  test("and stops being offered once it is saved", async ({ page }) => {
    // The mirror is written on content changes, and saving is not one - so
    // without a refresh when a buffer settles it would go on offering text that
    // is already on disk, and every start would ask about work nobody lost.
    await openApp(page);
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" # edited");
    await expect.poll(() =>
      page.evaluate(() => localStorage.getItem("build123d-studio.unsaved") !== null),
    ).toBe(true);

    await page.keyboard.press("Meta+KeyS");

    await expect.poll(() =>
      page.evaluate(() => localStorage.getItem("build123d-studio.unsaved")),
    ).toBe(null);
  });
});
