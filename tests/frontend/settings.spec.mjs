/** The Settings dialog: four buttons that do different things, and the chords.
 *
 * The four buttons are the case worth holding down, because the difference
 * between them is a *decision* rather than a mechanism. Apply saves and closes
 * and touches nothing else; Install, Re-install and Upgrade act on the
 * environment and return to the dialog, on success as well as failure, so there
 * is never a question of what happened or where you now are. That rule is the
 * kind that erodes quietly - one handler learning to close, and suddenly two
 * buttons out of four behave differently for no reason anybody wrote down.
 *
 * `applyPackageSources`, `upgradePackages` and `reinstallPackage` are replaced
 * by the harness's bootstrap stub, so what is asserted is which one a button
 * asked for - not that uv did anything, which belongs nowhere near a browser.
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

async function openSettings(page, extra = {}) {
  const handles = await open(page, {
    files: FILES,
    settings: { workspace: WORKSPACE, ...extra },
  });
  await page.locator("#btn-settings").click();
  await expect(page.locator("#settings-apply")).toBeVisible();
  return handles;
}

/** Which environment operations the stub was asked to perform. */
async function environmentCalls(page) {
  return page.evaluate(() => globalThis.__HARNESS_ENV_CALLS__ ?? []);
}

/** Drive an environment action to the end, and say it came back.
 *
 * The three action buttons do more than call uv, and the extra steps are the
 * design rather than plumbing: the dialog closes, the splash takes over and
 * shows the output, the kernel is restarted because the running one has already
 * imported whatever was replaced, and the result waits for the user to dismiss
 * it - by hand, not on a timer, because after a failure the log is the only
 * thing that says why. Only then does Settings reopen.
 *
 * A test that clicks the button and immediately asks whether the dialog is
 * still there answers "no" and blames the application. All four steps have to
 * be played through.
 */
async function finishEnvironmentAction(page, sidecar, what) {
  // The restart first and the acknowledgement second, in that order. The OK
  // button is raised in the `finally` *after* the restart has been awaited, so
  // waiting for it before answering the restart deadlocks: neither side can
  // move until the other has.
  await sidecar.waitFor("kernel.restart");
  sidecar.send("kernel.restarted");

  await expect(page.locator("#splash-ok")).toBeVisible();
  await page.locator("#splash-ok").click();

  await expect(page.locator("#settings-apply"), `${what} did not return to the dialog`)
    .toBeVisible();
}

test.describe("the four buttons", () => {
  test("Apply saves and closes, and touches nothing else", async ({ page }) => {
    await openSettings(page);

    await page.locator("#settings-apply").click();

    await expect(page.locator("#settings-apply")).toBeHidden();
    expect(
      await environmentCalls(page),
      "Apply ran something against the environment",
    ).toEqual([]);
  });

  test("Cancel closes without saving", async ({ page }) => {
    await openSettings(page);

    await page.locator("#settings-cancel").click();

    await expect(page.locator("#settings-apply")).toBeHidden();
    expect(await environmentCalls(page)).toEqual([]);
  });

  test("Install runs the install and comes back to the dialog", async ({ page }) => {
    const { sidecar } = await openSettings(page);

    await page.locator("#settings-install").click();

    await expect
      .poll(async () => (await environmentCalls(page)).map((call) => call.name))
      .toContain("applyPackageSources");
    await finishEnvironmentAction(page, sidecar, "Install");
  });

  test("Upgrade runs the upgrade and comes back to the dialog", async ({ page }) => {
    const { sidecar } = await openSettings(page);

    await page.locator("#settings-upgrade").click();

    await expect
      .poll(async () => (await environmentCalls(page)).map((call) => call.name))
      .toContain("upgradePackages");
    await finishEnvironmentAction(page, sidecar, "Upgrade");
  });

  test("Re-install names the one package it is for", async ({ page }) => {
    // The only thing that picks up edits to a local checkout: uv installs a path
    // source as a built copy, and with the lock unchanged an ordinary Install is
    // a no-op.
    const { sidecar } = await openSettings(page);

    await page.locator("#reinstall-build123d").click();

    await expect
      .poll(async () => (await environmentCalls(page)).filter((c) => c.name === "reinstallPackage"))
      .toHaveLength(1);
    const call = (await environmentCalls(page)).find((c) => c.name === "reinstallPackage");
    expect(call.package).toBe("build123d");
    await finishEnvironmentAction(page, sidecar, "Re-install");
  });
});

test.describe("the tabs", () => {
  test("every tab reaches its own panel", async ({ page }) => {
    await openSettings(page);

    for (const [tab, panel] of [
      ["packages", "packages"],
      ["newfile", "newfile"],
      ["editor", "editor"],
      ["debugging", "debugging"],
      ["shortcuts", "shortcuts"],
    ]) {
      await page.locator(`#tab-${tab}`).click();
      await expect(page.locator(`[data-panel="${panel}"]`)).toBeVisible();
    }
  });
});

test.describe("the Editor tab", () => {
  test("shows black's settings as they currently stand", async ({ page }) => {
    await openSettings(page, { formatLineLength: 100, formatOnSave: false });
    await page.locator("#tab-editor").click();

    await expect(page.locator("#settings-line-length")).toHaveValue("100");
    await expect(page.locator("#settings-format-on-save")).not.toBeChecked();
  });

  test("and defaults to 88 with format on save on", async ({ page }) => {
    // Both defaults are deliberate: 88 is black's own and the editor's ruler,
    // and a formatter nobody remembers to press is a file that drifts.
    await openSettings(page);
    await page.locator("#tab-editor").click();

    await expect(page.locator("#settings-line-length")).toHaveValue("88");
    await expect(page.locator("#settings-format-on-save")).toBeChecked();
  });

  test("a changed line length is stored, and the dialog closes", async ({ page }) => {
    await openSettings(page);
    await page.locator("#tab-editor").click();

    await page.locator("#settings-line-length").fill("120");
    await page.locator("#settings-format-on-save").uncheck();
    await page.locator("#settings-apply").click();

    await expect(page.locator("#settings-apply")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(
            String(
              globalThis.__NEUTRALINO_STUB__.wrote(
                "/appdata/build123d-studio/settings.json",
              ) ?? "{}",
            ),
          ),
        ),
      )
      .toMatchObject({ formatLineLength: 120, formatOnSave: false });
  });

  test("a line length that is not a number is refused where it was typed", async ({ page }) => {
    // Refused rather than rounded or silently defaulted: the value is on screen
    // and the user is looking at it, so this is the one moment where saying no
    // costs nothing and guessing costs trust.
    await openSettings(page);
    await page.locator("#tab-editor").click();

    await page.locator("#settings-line-length").fill("4");
    await page.locator("#settings-apply").click();

    await expect(page.locator("#settings-apply")).toBeVisible();
    // In the Editor panel's own message line, not the packages one. Reporting
    // there and then switching tabs would hide the message with the panel it
    // lives in, and the dialog would refuse to close saying nothing.
    await expect(page.locator("#settings-editor-problems")).toContainText("between 20 and 1000");
    await expect(page.locator("#settings-editor-problems")).toBeVisible();
    await expect(page.locator('[data-panel="editor"]')).toBeVisible();
  });
});

test.describe("the shortcut editor", () => {
  test("shows every command with the chords it currently has", async ({ page }) => {
    await openSettings(page);
    await page.locator("#tab-shortcuts").click();

    const rows = page.locator(".settings-shortcut");
    await expect(rows).not.toHaveCount(0);
    // Run Cell's default is Shift-Enter, written the way macOS writes it.
    await expect(page.locator(".settings-chord").first()).toBeVisible();
    const chords = await page.locator(".settings-chord").allTextContents();
    expect(chords.join(" "), "the shipped defaults are not shown").toMatch(/⇧|Shift/);
  });

  test("a recorded chord is added to the command", async ({ page }) => {
    // Recorded from event.code rather than event.key, because key carries the
    // *result* of the modifiers - Shift-2 is @ on a US layout and " on a German
    // one - so a chord recorded from it would mean something other than what
    // gets registered.
    await openSettings(page);
    await page.locator("#tab-shortcuts").click();

    const row = page.locator(".settings-shortcut", { hasText: "Run File" });
    const before = await row.locator(".settings-chord").count();
    await row.locator(".settings-record").click();
    await expect(row.locator(".settings-record")).toHaveText(/Press a chord/);

    await page.keyboard.press("Control+Shift+Digit9");

    await expect(row.locator(".settings-chord")).toHaveCount(before + 1);
  });

  test("a bare letter is refused with a reason", async ({ page }) => {
    // It would swallow that key while typing. A bare function key is not
    // refused, because F5 is a shipped default.
    await openSettings(page);
    await page.locator("#tab-shortcuts").click();

    const row = page.locator(".settings-shortcut", { hasText: "Run File" });
    const before = await row.locator(".settings-chord").count();
    await row.locator(".settings-record").click();
    await page.keyboard.press("KeyQ");

    await expect(page.locator("#settings-chord-problems")).toBeVisible();
    await expect(row.locator(".settings-chord")).toHaveCount(before);
  });

  test("clicking a chord removes it", async ({ page }) => {
    await openSettings(page);
    await page.locator("#tab-shortcuts").click();

    const row = page.locator(".settings-shortcut", { hasText: "Run File" });
    const before = await row.locator(".settings-chord").count();
    expect(before).toBeGreaterThan(0);

    await row.locator(".settings-chord").first().click();

    await expect(row.locator(".settings-chord")).toHaveCount(before - 1);
  });

  test("a conflict is reported rather than prevented", async ({ page }) => {
    // Which of two commands the user meant to keep is theirs to decide, and
    // silently refusing the second would look like the dialog ignored them.
    await openSettings(page);
    await page.locator("#tab-shortcuts").click();

    // Give Run File the chord Run Cell already has.
    const runFile = page.locator(".settings-shortcut", { hasText: "Run File" });
    await runFile.locator(".settings-record").click();
    await page.keyboard.press("Shift+Enter");

    await expect(page.locator("#settings-chord-problems")).toBeVisible();
    await expect(page.locator("#settings-chord-problems")).toContainText(/Run/);
    // Reported, and still added: the user is being told, not overruled.
    await expect(runFile.locator(".settings-chord")).toHaveCount(2);
  });
});
