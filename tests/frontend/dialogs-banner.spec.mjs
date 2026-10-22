/** Linux with no program to draw file dialogs: a banner says what to do.
 *
 * Without zenity, kdialog, matedialog or qarma, Neutralino's file dialogs on
 * Linux answer as though cancelled, so Open, Save As, Import and Export do
 * nothing. The sidecar notices at start and says `dialogs.missing`; see
 * sidecar/dialogs.py.
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

test.describe("no program to draw file dialogs", () => {
  test("is not mentioned when the sidecar does not say so", async ({ page }) => {
    await open(page, { platform: "Linux", files: FILES, settings: { workspace: WORKSPACE } });
    await page.waitForTimeout(300);
    await expect(page.locator("#dialogs-banner")).toBeHidden();
  });

  test("is said in a banner naming what to install", async ({ page }) => {
    const { sidecar } = await open(page, { platform: "Linux", files: FILES, settings: { workspace: WORKSPACE } });

    sidecar.send("dialogs.missing");

    const banner = page.locator("#dialogs-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("sudo apt install zenity");
    await expect(banner).toContainText("restart build123d Studio");
  });

  test("is shown when said during the sidecar's start, before it is ready", async ({ page }) => {
    // The order a real sidecar uses: it checks while starting, so the message
    // arrives before the handshake that startup waits for.
    const { sidecar } = await open(page, {
      platform: "Linux", files: FILES, settings: { workspace: WORKSPACE }, ready: false,
    });
    await expect.poll(() => sidecar.connections).toBeGreaterThan(0);

    sidecar.send("dialogs.missing");
    sidecar.send("ready", { connectionFile: "/appdata/kernel.json" });

    await expect(page.locator("#dialogs-banner")).toBeVisible();
  });

  test("and once dismissed it stays away, even when said again", async ({ page }) => {
    const { sidecar } = await open(page, { platform: "Linux", files: FILES, settings: { workspace: WORKSPACE } });
    sidecar.send("dialogs.missing");
    await expect(page.locator("#dialogs-banner")).toBeVisible();

    await page.locator("#dialogs-banner-dismiss").click();
    await expect(page.locator("#dialogs-banner")).toBeHidden();

    // A replaced sidecar starts again and says it again.
    sidecar.send("dialogs.missing");
    await page.waitForTimeout(300);
    await expect(page.locator("#dialogs-banner")).toBeHidden();
  });
});
