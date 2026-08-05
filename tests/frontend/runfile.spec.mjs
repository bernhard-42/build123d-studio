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
  test("the panes swap, and give themselves back when it ends", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await expect(page.locator("#pane-debug")).toBeHidden();

    await startRun(page, sidecar);
    await expect(page.locator("#pane-debug")).toBeVisible();

    sidecar.send("run.exited", { code: 0 });

    await expect(page.locator("#pane-debug")).toBeHidden();
  });

  test("the bar carries Stop and nothing to step with", async ({ page }) => {
    // Hidden rather than disabled. A row of five greyed buttons would say the
    // run is paused somewhere, which is exactly what it is not - there is no
    // debugger in it to pause.
    const { sidecar } = await openApp(page);

    await startRun(page, sidecar);

    await expect(page.locator("#debug-bar")).toBeVisible();
    await expect(page.locator("#debug-stop")).toBeVisible();
    for (const id of ["debug-continue", "debug-step-over", "debug-step-into", "debug-step-out"]) {
      await expect(page.locator(`#${id}`), `${id} is on screen during a plain run`).toBeHidden();
    }
  });

  test("what it prints appears in the console pane", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await startRun(page, sidecar);

    sidecar.send("run.output", { text: "SENTINEL_PRINTED\n" });

    await expect(page.locator("#debug-output")).toContainText("SENTINEL_PRINTED");
  });

  test("Stop asks the sidecar to kill it", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await startRun(page, sidecar);

    await page.locator("#debug-stop").click();

    await expect.poll(() => sent(sidecar, "run.stop").length).toBe(1);
    await expect(page.locator("#debug-bar")).toBeHidden();
  });

  test("a non-zero exit is reported in the output, not in a dialog", async ({ page }) => {
    // The traceback above it is the answer, and a modal over the top of the
    // thing worth reading is in the way.
    const { sidecar } = await openApp(page);
    await startRun(page, sidecar);

    sidecar.send("run.output", { text: "Traceback (most recent call last):\n" });
    sidecar.send("run.exited", { code: 1 });

    await expect(page.locator("#debug-output")).toContainText("exited with code 1");
    await expect(page.locator(".confirm-overlay")).toBeHidden();
    await expect(page.locator("#debug-bar")).toBeHidden();
  });
});
