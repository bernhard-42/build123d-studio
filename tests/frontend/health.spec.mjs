/** The subsystem chip: what the toolbar says when something below it dies.
 *
 * The kernel indicator beside it speaks for the kernel alone, so a measurement
 * backend, a model channel or a language server could stop and the window would
 * look exactly as it does when everything works. That is the failure this
 * application spent an afternoon on: a start that looks fine with one part dead,
 * after which every symptom points somewhere else.
 *
 * `src/health.js` is pure and has its own unit tests; what cannot be tested
 * there is whether any of it reaches the screen, which is all this file is
 * about - the chip appearing, what it says, where clicking it goes, and the one
 * behaviour that is easy to get wrong: not stealing the pane back every time
 * anything reports afterwards.
 *
 * Proved by un-applying, once, when written: `refreshHealthChip`'s
 * `chip.hidden = !unwell` inverted - the chip is absent while all is well;
 * `revealBackendOnFailure`'s `revealed` set deleted - a later report drags the
 * pane back off the console.
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

/** The frame the sidecar sends about itself; see Sidecar.report. */
function subsystem(sidecar, name, state, detail = "") {
  sidecar.send("subsystem", { name, state, detail });
}

test.describe("the toolbar says when something below it is unwell", () => {
  test("nothing is said while everything is well", async ({ page }) => {
    const { sidecar } = await open(page);
    subsystem(sidecar, "viewer", "ready", "model channel on port 51234");
    subsystem(sidecar, "measurement", "starting", "loading the geometry kernel");

    // `starting` is deliberately not a fault: the measurement backend is still
    // loading OCP when the window appears, and treating that as one would make
    // every good start look bad.
    await expect(page.locator("#health-chip")).toBeHidden();
  });

  test("a failure raises the chip, names the state, and carries the detail", async ({ page }) => {
    const { sidecar } = await open(page);
    subsystem(sidecar, "measurement", "failed", "no answer in 60s, restarted");

    const chip = page.locator("#health-chip");
    await expect(chip).toBeVisible();
    await expect(page.locator("#health-label")).toHaveText("failed");
    // The tooltip carries every subsystem, because two things failing at once
    // is a different story from one.
    await expect(chip).toHaveAttribute("title", /measurement: failed - no answer in 60s/);
  });

  test("a failure brings the Backend tab forward, where the reason is", async ({ page }) => {
    const { sidecar } = await open(page);
    // A good start ends on the console, which is what makes this observable.
    await expect(page.locator("#pane-console")).toBeVisible();

    subsystem(sidecar, "kernel", "failed", "the kernel process exited");
    await expect(page.locator("#pane-backend")).toBeVisible();
  });

  test("it does not keep taking the pane back afterwards", async ({ page }) => {
    const { sidecar } = await open(page);
    subsystem(sidecar, "kernel", "failed", "the kernel process exited");
    await expect(page.locator("#pane-backend")).toBeVisible();

    // The user goes back to the console, having read it - and the machinery
    // goes on reporting, as it does all session.
    await page.locator("#console-tab-console").click();
    await expect(page.locator("#pane-console")).toBeVisible();
    subsystem(sidecar, "completion", "ready", "");
    subsystem(sidecar, "viewer", "ready", "");

    await expect(page.locator("#pane-console")).toBeVisible();
    // And the chip is still up, because the kernel is still dead.
    await expect(page.locator("#health-chip")).toBeVisible();
  });

  test("degraded shows the chip and leaves the pane alone", async ({ page }) => {
    const { sidecar } = await open(page);
    await expect(page.locator("#pane-console")).toBeVisible();

    subsystem(sidecar, "completion", "degraded", "the language server restarted");

    await expect(page.locator("#health-chip")).toBeVisible();
    await expect(page.locator("#health-label")).toHaveText("degraded");
    await expect(page.locator("#pane-console")).toBeVisible();
  });

  test("clicking it opens the Backend tab", async ({ page }) => {
    const { sidecar } = await open(page);
    subsystem(sidecar, "completion", "degraded", "the language server restarted");
    await page.locator("#health-chip").click();

    await expect(page.locator("#pane-backend")).toBeVisible();
  });

  test("it goes away when the subsystem recovers", async ({ page }) => {
    const { sidecar } = await open(page);
    subsystem(sidecar, "measurement", "failed", "no answer in 60s, restarted");
    await expect(page.locator("#health-chip")).toBeVisible();

    subsystem(sidecar, "measurement", "ready", "");
    await expect(page.locator("#health-chip")).toBeHidden();
  });
});

test.describe("what the sidecar is told at launch", () => {
  test("the settings file it answers workspace_config() from is named, not derived", async ({ page }) => {
    // The kernel used to find settings.json as "the directory above the
    // environment root". True where the two share a parent - macOS, Linux -
    // and false on Windows since 0.5.0, where the environment is in Local and
    // the settings stay in Roaming: the kernel read a file that did not exist
    // and answered the shipped defaults for every setting, silently. The
    // frontend wrote the file, so the frontend says where it is.
    await open(page, { platform: "Windows" });

    const spawned = await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__
        .calls()
        .filter((call) => call.name === "spawnProcess")
        .map((call) => call.args[0])
        .find((command) => command.includes("sidecar/main.py")));

    expect(spawned, "the sidecar was never spawned").toBeDefined();
    expect(spawned).toContain("--settings ");
    expect(spawned).toContain("/appdata/build123d-studio/settings.json");
  });

  test("on Windows every command ends in `&& exit /b 0`, so cmd's AutoRun cannot fail it", async ({ page }) => {
    // A broken AutoRun entry makes cmd.exe report a successful command as
    // exit 1 - measured, and it discarded a finished download. The suffix
    // makes the shell return the command's own code; see shellCommandFor.
    // Proof, at writing: with the shellCommandFor call removed from spawn(),
    // this fails on the first command.
    await open(page, { platform: "Windows" });

    const commands = await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__
        .calls()
        .filter((call) => call.name === "spawnProcess")
        .map((call) => call.args[0]));

    expect(commands.length, "nothing was spawned").toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/ && exit \/b 0$/);
    }
  });
});

test.describe("what a reloaded page does about its predecessor", () => {
  // WebKit killed the page at 26 GB after a few large models, relaunched it and
  // reloaded; the new page started a sidecar and kernel of its own while the
  // old ones - spawned by the application process, which never died - ran on.
  // Measured: the previous tree was still alive beside the new one.
  //
  // Proof, at writing: with the stopLeftovers call removed from main(), the
  // first test fails on the missing exit call; with the health record removed
  // from reportWebglGone, the second fails on the hidden chip.

  test("processes a previous page left behind are stopped before anything is spawned", async ({ page }) => {
    await open(page, { leftovers: [{ id: 7, pid: 4242 }, { id: 8, pid: 4243 }] });

    const calls = await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__
        .calls()
        .filter((call) => call.name === "updateSpawnedProcess" || call.name === "spawnProcess")
        .map((call) => (call.name === "spawnProcess" ? "spawn" : `exit ${call.args[0]}`)));

    expect(calls.slice(0, 2)).toEqual(["exit 7", "exit 8"]);
    expect(calls.slice(2)).not.toContain("exit 7");
  });

  test("a lost WebGL context is a failed subsystem the chip names", async ({ page }) => {
    await open(page);
    await expect(page.locator("#health-chip")).toBeHidden();

    // What the browser dispatches on the canvas when the GPU takes the context
    // away; it does not bubble, which is what the capture listener is for.
    await page.evaluate(() => {
      const canvas = document.querySelector("#pane-viewer canvas");
      canvas.dispatchEvent(new Event("webglcontextlost"));
    });

    const chip = page.locator("#health-chip");
    await expect(chip).toBeVisible();
    await expect(page.locator("#health-label")).toHaveText("failed");
    await expect(chip).toHaveAttribute("title", /webgl: failed - The viewer cannot draw/);
  });
});
