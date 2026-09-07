/** Ctrl-F5: the file from disk, in a process of its own.
 *
 * The distinction this file exists to hold is the one the toolbar used to get
 * wrong. Run All sends the buffer's *text* to the kernel; Run File saves and
 * runs the *file*, somewhere else entirely. Every case below is about which of
 * those happened, because on screen they look almost the same - and the way to
 * tell is which frame left for the sidecar.
 *
 * The pane swap is the other half. While a run is on, every pane in the window
 * describes the run rather than the kernel, exactly as it does while debugging,
 * and the only difference is that there is nothing to step - so the bar carries
 * Stop and nothing else.
 */

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

async function openApp(page) {
  const handles = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
  await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
  return handles;
}

const sent = (sidecar, type) => sidecar.received.filter((frame) => frame.type === type);

async function startRun(page, sidecar) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+F5");
  await sidecar.waitFor("run.start");
  sidecar.send("run.started", { path: `${PROJECT}/part.py` });
}

test.describe("what Ctrl-F5 runs", () => {
  test("it asks for the file on disk, not the buffer on the kernel", async ({ page }) => {
    const { sidecar } = await openApp(page);

    await startRun(page, sidecar);

    expect(sent(sidecar, "run.start")[0].path).toBe(`${PROJECT}/part.py`);
    expect(sent(sidecar, "kernel.execute"), "it ran on the kernel as well").toHaveLength(0);
  });

  test("the buffer is saved first, so what runs is what is on screen", async ({ page }) => {
    // The whole reason it runs from disk is that the file is the thing. An
    // unsaved buffer would run yesterday's code while the user reads today's.
    const { sidecar } = await openApp(page);

    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.type("EDITED");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);

    await page.keyboard.press("Control+F5");
    await sidecar.waitFor("run.start");

    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/part.py`,
        ),
      )
      .toContain("EDITED");
  });
});

test.describe("while it runs", () => {
  test("the Run/Debug tab comes up, and keeps what was printed", async ({ page }) => {
    // The reason it is a tab rather than a swap: output that vanishes with the
    // process is output you cannot read.
    const { sidecar } = await openApp(page);
    await expect(page.locator("#pane-debug")).toBeHidden();

    await startRun(page, sidecar);
    await expect(page.locator("#pane-debug")).toBeVisible();
    sidecar.send("run.output", { text: "SENTINEL_KEPT\n" });

    sidecar.send("run.exited", { code: 0 });

    await expect(page.locator("#pane-debug")).toBeVisible();
    await expect(page.locator("#debug-output")).toContainText("SENTINEL_KEPT");
  });

  test("no evaluate line and an empty explorer, during and after", async ({ page }) => {
    // The bug he found: when the run ended, the evaluate line and the kernel's
    // explorer came back underneath a Run/Debug tab that was still showing the
    // run's output - three panes describing three different things.
    //
    // Nothing is put back. The tab still belongs to the run, so the panes
    // beside it still describe the run, which is now nothing running.
    const { sidecar } = await openApp(page);

    await expect(page.locator("#pane-vars")).toBeVisible();

    await startRun(page, sidecar);
    await expect(page.locator("#debug-prompt")).toBeHidden();
    await expect(page.locator("#pane-vars")).toBeHidden();
    await expect(page.locator("#splitter-v-bottom")).toBeHidden();

    sidecar.send("run.exited", { code: 0 });

    await expect(page.locator("#pane-debug")).toBeVisible();
    await expect(page.locator("#debug-prompt"), "the evaluate line came back").toBeHidden();
    await expect(page.locator("#pane-vars"), "the explorer came back").toBeHidden();
  });

  test("and the Console tab brings the kernel's explorer back", async ({ page }) => {
    // Which is the other half of the rule: the tab decides what the panes
    // beside it are about, so choosing the kernel's tab chooses the kernel.
    const { sidecar } = await openApp(page);
    await startRun(page, sidecar);
    sidecar.send("run.exited", { code: 0 });

    await page.locator("#console-tab-console").click();

    await expect(page.locator("#pane-vars")).toBeVisible();
    await expect(page.locator("#splitter-v-bottom")).toBeVisible();
    await expect
      .poll(() => sidecar.received.filter((frame) => frame.type === "vars.refresh").length)
      .toBeGreaterThan(0);
  });

});

test.describe("which tab comes up", () => {
  test("a kernel run raises Console, even from the Run/Debug tab", async ({ page }) => {
    // The rule that keeps the tabs from becoming another way to lose output:
    // whatever you asked to run, the panel that will show its output is the one
    // you are looking at when it starts.
    const { sidecar } = await openApp(page);
    await startRun(page, sidecar);
    sidecar.send("run.exited", { code: 0 });
    await expect(page.locator("#pane-debug")).toBeVisible();

    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Alt+Enter");

    await expect(page.locator("#pane-console")).toBeVisible();
    await expect(page.locator("#pane-debug")).toBeHidden();
  });

  test("and Run File raises Run/Debug from the Console tab", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await expect(page.locator("#pane-console")).toBeVisible();

    await startRun(page, sidecar);

    await expect(page.locator("#pane-debug")).toBeVisible();
    await expect(page.locator("#pane-console")).toBeHidden();
  });

  test("the step controls are in the console pane's tab bar now", async ({ page }) => {
    // They were right-aligned in the editor's tab strip, where they sat among
    // the file tabs and were hard to find. Same behaviour, beside the output
    // they act on.
    const { sidecar } = await openApp(page);

    await startRun(page, sidecar);

    await expect(page.locator("#console-tabs #debug-bar")).toBeVisible();
    await expect(page.locator("#tab-row #debug-bar")).toHaveCount(0);
  });
});

test.describe("the toolbar's groups", () => {
  test("the file group comes first, and the kernel's five are one group", async ({ page }) => {
    // The grouping said the wrong thing: running code in the kernel and
    // controlling that kernel were separated by a rule, as though they were
    // different subjects, while the two that never touch the kernel at all sat
    // in the middle of them.
    await openApp(page);

    const order = await page.evaluate(() =>
      [...document.querySelectorAll(".toolbar .btn, .toolbar .toolbar-sep, .toolbar .kernel-status")]
        .map((element) => element.id || "|"),
    );
    const runFile = order.indexOf("btn-run-file");
    const runCell = order.indexOf("btn-run-cell");
    expect(runFile, "Run File is not before Run Cell").toBeLessThan(runCell);
    // No separator between the kernel's runs and the kernel's controls.
    expect(order.slice(runCell, order.indexOf("kernel-status") + 1)).toEqual([
      "btn-run-cell", "btn-run-sel", "btn-run-all", "btn-restart", "btn-interrupt", "kernel-status",
    ]);
  });

  test("the file buttons name their chords too, from the menu's own table", async ({ page }) => {
    // These chords are the menu's rather than the keymap's, so the toolbar asks
    // menubar.js rather than keeping a second copy - a button and a menu item
    // claiming different keys for Save is the failure worth preventing.
    await openApp(page);

    await expect(page.locator("#btn-new")).toHaveAttribute("title", "New File (⌘N)");
    await expect(page.locator("#btn-open")).toHaveAttribute("title", "Open File (⌘O)");
    await expect(page.locator("#btn-save")).toHaveAttribute("title", "Save File (⌘S)");
    await expect(page.locator("#btn-settings")).toHaveAttribute("title", "Settings (⌘,)");
  });

  test("the palette button opens the palette, and the theme button is gone", async ({ page }) => {
    // F1 only works while the caret is in the editor, so somebody who has just
    // clicked in the console had no way in.
    await openApp(page);
    await expect(page.locator("#btn-theme")).toHaveCount(0);

    await page.locator("#btn-palette").click();

    await expect(page.locator(".quick-input-widget")).toBeVisible();
  });
});

/* Run -> Test, which is the same process-of-its-own with a different argv.
 *
 * Both items ask where to look before they do anything, so what a test can hold
 * is the pair: which chooser was raised, and what left for the sidecar
 * afterwards. Everything downstream - the pane swap, Stop, the exit line - is
 * Run File's and is covered above.
 */

const choose = (page, answer) =>
  page.evaluate((target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target), answer);

const pick = (page, id) =>
  page.evaluate(
    (command) => globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: command }),
    id,
  );

const called = (page, name) =>
  page.evaluate(
    (wanted) => globalThis.__NEUTRALINO_STUB__.calls().filter((call) => call.name === wanted),
    name,
  );

test.describe("testing", () => {
  test("Test Folder asks for a folder and runs pytest over what came back", async ({ page }) => {
    const { sidecar } = await openApp(page);

    await choose(page, `${PROJECT}/tests`);
    await pick(page, "test.folder");

    const frame = await sidecar.waitFor("run.tests");
    expect(frame.path).toBe(`${PROJECT}/tests`);
    // Off unless Settings says otherwise, which is pytest's own default.
    expect(frame.ignoreWarnings).toBe(false);
    expect((await called(page, "showFolderDialog")).length).toBe(1);
  });

  test("Test File asks for a file, and only for Python ones", async ({ page }) => {
    const { sidecar } = await openApp(page);

    // The open dialog answers with a list, as the real one does.
    await choose(page, [`${PROJECT}/test_part.py`]);
    await pick(page, "test.file");

    const frame = await sidecar.waitFor("run.tests");
    expect(frame.path).toBe(`${PROJECT}/test_part.py`);
    const [dialog] = await called(page, "showOpenDialog");
    expect(dialog.args[1].filters).toEqual([{ name: "Python", extensions: ["py"] }]);
    // One path, because one run: the frame carries a single target.
    expect(dialog.args[1].multiSelections).toBe(false);
  });

  test("cancelling the chooser runs nothing at all", async ({ page }) => {
    const { sidecar } = await openApp(page);

    // Nothing queued, so the stub answers as a cancel does.
    await pick(page, "test.folder");
    await page.waitForTimeout(300);

    expect(sent(sidecar, "run.tests")).toEqual([]);
  });

  test("Ignore warnings in Settings reaches the run that starts next", async ({ page }) => {
    // Read when the run starts rather than held by the sidecar: a run carrying
    // its own arguments cannot be stale.
    const { sidecar } = await open(page, {
      files: FILES,
      settings: { workspace: WORKSPACE, testIgnoreWarnings: true },
    });

    await choose(page, `${PROJECT}/tests`);
    await pick(page, "test.folder");

    expect((await sidecar.waitFor("run.tests")).ignoreWarnings).toBe(true);
  });

  test("and it will not start while something is already running", async ({ page }) => {
    // One child at a time, and the sidecar would refuse anyway - said here so
    // the answer arrives as a sentence rather than as a run that never began.
    const { sidecar } = await openApp(page);
    await startRun(page, sidecar);

    await choose(page, `${PROJECT}/tests`);
    await pick(page, "test.folder");

    // A native message box rather than a panel in the page, like every other
    // refusal here - so what a test can see is the call, not the DOM.
    await expect.poll(async () => (await called(page, "showMessageBox")).length).toBeGreaterThan(0);
    const [box] = await called(page, "showMessageBox");
    expect(box.args[0]).toBe("Test Folder");
    expect(sent(sidecar, "run.tests")).toEqual([]);
    // And the chooser never opened: there was nothing to ask about.
    expect(await called(page, "showFolderDialog")).toEqual([]);
  });
});
