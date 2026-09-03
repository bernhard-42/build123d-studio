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
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/settings.js, an installPackages() added to Apply - Apply saves and
 *   closes, and touches nothing else
 * - src/keys.js, chordProblem() answering null for everything - a bare letter
 *   is refused with a reason
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
 *
 * The language server restart that precedes the kernel's is not among them: the
 * harness answers it the way a real sidecar always does, so a test about which
 * uv command a button ran does not have to play it.
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
  test("shows ruff's settings as they currently stand", async ({ page }) => {
    await openSettings(page, { formatLineLength: 100, formatOnSave: false });
    await page.locator("#tab-editor").click();

    await expect(page.locator("#settings-line-length")).toHaveValue("100");
    await expect(page.locator("#settings-format-on-save")).not.toBeChecked();
  });

  test("and defaults to 88 with format on save on", async ({ page }) => {
    // Both defaults are deliberate: 88 is ruff's own and the editor's ruler,
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

  test("dark mode pins nothing unless it is changed", async ({ page }) => {
    // The trap this avoids: opening the dialog and pressing Apply would
    // otherwise pin a preference that had been following the desktop, and the
    // theme would quietly stop tracking it. Written without assuming which
    // theme the machine running the suite is in - the point is that Apply
    // changes nothing, whichever it is.
    //
    // On the Viewer tab, where the control moved: the theme is a viewer
    // setting in every other host, and this application paints the editor with
    // it too - which is why it stays one application-level setting rather than
    // joining the viewer's own.
    await openSettings(page);
    await page.locator("#tab-viewer").click();

    await page.locator("#settings-apply").click();
    await expect(page.locator("#settings-apply")).toBeHidden();

    const stored = await page.evaluate(() =>
      JSON.parse(
        String(
          globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/settings.json") ?? "{}",
        ),
      ),
    );
    expect(stored.theme, "Apply pinned a theme nobody asked it to").toBeUndefined();
  });

  test("and changing it pins the one now showing", async ({ page }) => {
    await openSettings(page);
    await page.locator("#tab-viewer").click();
    const box = page.locator("#settings-dark-mode");
    const wasDark = await box.isChecked();

    await box.setChecked(!wasDark);
    await page.locator("#settings-apply").click();

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
      .toMatchObject({ theme: wasDark ? "light" : "dark" });
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

test.describe("the package source picker", () => {
  // Reported from a real build: choosing "Local checkout" and pressing Apply
  // without picking a folder saved the choice and installed from PyPI. The
  // dialog is where the choice is still being made, so it has to refuse -
  // startup deliberately tolerates the same state, because a half-made setting
  // must not stop the application starting, and that tolerance is exactly what
  // made the saved choice do nothing visible.
  //
  // Proved by un-applying: with the localSourceProblem check removed from
  // saveEverything, both tests below fail and nothing else does.

  test("a local checkout with no folder refuses Apply and says why", async ({ page }) => {
    await openSettings(page);
    await page.locator('input[name="src-build123d"][value="local"]').check();
    await page.locator("#settings-apply").click();

    await expect(page.locator("#settings-apply"), "the dialog must stay open").toBeVisible();
    const problem = page.locator("#local-problem-build123d");
    await expect(problem).toBeVisible();
    await expect(problem).toContainText("choose a folder");
  });

  test("and applies once a folder is given", async ({ page }) => {
    // The other half: the refusal is about this state, not about the choice.
    await openSettings(page);
    await page.locator('input[name="src-build123d"][value="local"]').check();
    await page.locator("#local-build123d").fill("/Users/me/src/build123d");
    await page.locator("#settings-apply").click();

    await expect(page.locator("#settings-apply")).toBeHidden();
  });
});

test.describe("what a package change tells the language server", () => {
  // basedpyright reads site-packages when it starts and does not watch it, so
  // after an install its index describes an environment that no longer exists:
  // the package just added is missing from completion and - the half that looks
  // like a broken editor - underlined as unresolved in code that is correct.

  const asked = (sidecar, type) =>
    sidecar.received.filter((frame) => frame.type === type).length;

  test("installing packages restarts it", async ({ page }) => {
    const { sidecar } = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "app.settings" }),
    );
    await page.locator('.settings-tab[data-tab="packages"]').click();
    await page.locator("#settings-install").click();

    await expect.poll(() => asked(sidecar, "editor.restartLanguageServer")).toBe(1);
  });

  test("but restarting the kernel does not", async ({ page }) => {
    // "Restart Kernel" means "clear my namespace". Rebuilding the language
    // server's index every time somebody presses it would spend seconds on a
    // question they did not ask.
    const { sidecar } = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    await page.locator("#btn-restart").click();

    await sidecar.waitFor("kernel.restart");
    await page.waitForTimeout(300);
    expect(asked(sidecar, "editor.restartLanguageServer")).toBe(0);
  });
});

// --- the environment's pyproject.toml is what the dialog shows -------------
//
// The file is the user's now: it is written when an environment is built and
// again by Apply, and never on a start. So the dialog has to read it, or it
// would show settings.json's idea of the world over a file somebody has edited
// - which is the exact confusion this whole change exists to end.

/** Put a pyproject.toml in front of the dialog before it opens. */
async function withProjectFile(page, file) {
  await page.evaluate((next) => globalThis.__HARNESS_PROJECT__.set(next), file);
}

async function projectWrites(page) {
  return page.evaluate(() => globalThis.__HARNESS_PROJECT_WRITES__ ?? []);
}

test.describe("Settings reads the environment's pyproject.toml", () => {
  test("the additional packages shown are the ones in the file", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE, customPackages: "stale" } });
    await withProjectFile(page, {
      user: ["cadquery", "mylib>=0.3"],
      app: ["ruff==0.16.3"],
      coreCad: ["build123d>=0.11.1"],
      sources: {},
    });
    await page.locator("#btn-settings").click();

    // settings.json says "stale"; the file says otherwise, and the file wins.
    await expect(page.locator("#settings-custom")).toHaveValue("cadquery\nmylib>=0.3");
  });

  test("a local checkout in the file lights the Local radio and shows its folder", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    await withProjectFile(page, {
      user: [],
      app: [],
      coreCad: [],
      sources: { build123d: '{ path = "/Users/me/src/build123d", editable = true }' },
    });
    await page.locator("#btn-settings").click();

    await expect(page.locator('input[name="src-build123d"][value="local"]')).toBeChecked();
    await expect(page.locator("#local-build123d")).toHaveValue("/Users/me/src/build123d");
  });

  test("what the release declares is shown, and not as something to type in", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    await withProjectFile(page, {
      user: [],
      app: ["basedpyright==1.39.9"],
      coreCad: ["build123d>=0.11.1"],
      sources: {},
    });
    await page.locator("#btn-settings").click();

    const declared = page.locator("#settings-declared");
    await expect(declared).toContainText("basedpyright==1.39.9");
    await expect(declared).toContainText("build123d>=0.11.1");
    expect(await declared.evaluate((el) => el.tagName)).toBe("PRE");
  });

  test("a file the dialog cannot read says so rather than showing stale values", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    // No `user` group at all - a file somebody edited past what this can follow.
    await withProjectFile(page, { user: null, app: null, coreCad: null, sources: {} });
    await page.locator("#btn-settings").click();

    await expect(page.locator("#settings-unreadable")).toBeVisible();
  });

  test("Apply writes the two regions it owns, and runs no uv", async ({ page }) => {
    await openSettings(page);
    await page.locator("#settings-custom").fill("cadquery");
    await page.locator("#settings-apply").click();

    await expect(page.locator("#settings-apply")).toBeHidden();
    const writes = await projectWrites(page);
    expect(writes.length, "Apply did not write the environment's pyproject.toml").toBe(1);
    expect(writes[0].custom).toBe("cadquery");
    expect(await environmentCalls(page), "Apply ran uv").toEqual([]);
  });

  test("a local checkout comes back as the path that was typed", async ({ page }) => {
    // Stored as `cadquery` in the group plus a path source, so showing the
    // field again means putting the two halves back together. It came back as
    // the bare package name, and the next Apply would have written that over
    // the checkout.
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    await withProjectFile(page, {
      user: ["cadquery"],
      app: [],
      coreCad: [],
      sources: {
        cadquery: '{ path = "/Users/bernhard/Development/CAD/cadquery", editable = true }',
      },
    });
    await page.locator("#btn-settings").click();

    await expect(page.locator("#settings-custom"))
      .toHaveValue("/Users/bernhard/Development/CAD/cadquery");
  });
});

test.describe("the splash these buttons raise", () => {
  /**
   * Which build is on screen, on the one screen that is up before anything else
   * exists. The About dialog answers it too, and is behind a window that does
   * not exist yet during a first run - so a report of "it stopped on the
   * splash" could never say which version stopped.
   *
   * It matters most here rather than at startup: Install, Upgrade and
   * Re-install raise this same overlay, and it stays up for as long as uv and
   * the OCP verification take.
   *
   * textContent rather than innerText, because the splash is hidden by the time
   * the application is ready and innerText answers "" for anything invisible.
   */
  test("says which build is running", async ({ page }) => {
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });

    const title = await page.locator(".splash-title").textContent();

    expect(title).toMatch(/^build123d Studio \d+\.\d+\.\d+/);
  });
});
