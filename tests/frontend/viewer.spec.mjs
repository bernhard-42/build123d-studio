/** show(): a model frame arrives, and geometry appears.
 *
 * Deliberately the whole of the viewer's coverage here. `tests/integration.py`
 * already proves show() end to end with a real kernel - the model reaches the
 * socket in 0.07 s - and what it cannot see is the last step, because it drives
 * the sidecar rather than a window. Whether three-cad-viewer then *drew*
 * anything is only answerable in a browser, and that is this file.
 *
 * Group 7 changes what gets shown - every show reading the tree status first
 * and reapplying it afterwards - so nothing here asserts on tree state or on
 * what survives a second show. "A frame arrives and geometry appears" is true
 * before and after that work.
 *
 * The fixture is a real tessellation captured from the pinned environment
 * (`Box(1, 2, 3)` through ocp_vscode's `_convert`, split by the kernel's own
 * `split_buffers`), not a header written by hand. A hand-written one would only
 * ever prove that the test agrees with the test: rehydrate() reads dtypes,
 * offsets and lengths that ocp_tessellate chose, and inventing them is
 * inventing the thing under test.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { KIND_MODEL } from "../../src/frame.js";
import { open } from "./app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = JSON.parse(readFileSync(join(HERE, "fixtures", "box-model.json"), "utf8"));
const PAYLOAD = Buffer.from(MODEL.payloadBase64, "base64");

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

async function openApp(page) {
  return open(page, { files: FILES, settings: { workspace: WORKSPACE } });
}

test.describe("a model frame renders", () => {
  test("a real tessellation reaches the viewer and is drawn", async ({ page }) => {
    const { sidecar, problems } = await openApp(page);

    sidecar.sendBinary(KIND_MODEL, PAYLOAD, MODEL.header);

    // The application's own account of what it did, which names the shape count
    // and the payload size - and is the line a user is asked for when the
    // viewer looks wrong.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            String(
              globalThis.__NEUTRALINO_STUB__.wrote(
                "/appdata/build123d-studio/build123d-studio.log",
              ) ?? "",
            ),
          ),
        { message: "the viewer never reported rendering a model" },
      )
      .toContain("Model rendered");

    // And the tree the viewer builds for it, which is the visible evidence that
    // geometry arrived rather than an empty scene.
    await expect(page.locator(".pane-viewer .tcv_cad_tree, .pane-viewer canvas").first())
      .toBeVisible();

    expect(problems, "rendering the model raised errors").toEqual([]);
  });

  test("the canvas is given the pane's size rather than a default", async ({ page }) => {
    // The viewer is constructed against a measured container. A pane that was
    // measured before the layout settled leaves a canvas that never fills it,
    // which is only visible once something has drawn.
    const { sidecar } = await openApp(page);
    sidecar.sendBinary(KIND_MODEL, PAYLOAD, MODEL.header);

    const canvas = page.locator(".pane-viewer canvas").first();
    await expect(canvas).toBeVisible();

    const [pane, drawn] = await Promise.all([
      page.locator("#pane-viewer").boundingBox(),
      canvas.boundingBox(),
    ]);
    expect(drawn.width).toBeGreaterThan(pane.width / 2);
    expect(drawn.height).toBeGreaterThan(pane.height / 4);
  });
});

test.describe("a model with no geometry", () => {
  test("is refused rather than hanging the window", async ({ page }) => {
    // The force-quit. show_all(locals()) handed _convert an ordinary list of
    // floats, which produced a header describing shapes with no buffers behind
    // them, and three-cad-viewer does not come back from one - the application
    // had to be killed. Three fixes followed and this is the last of them: a
    // hang is not an acceptable answer to a bad frame from anywhere, and the
    // viewer is the only place that can refuse it.
    const { sidecar } = await openApp(page);

    sidecar.sendBinary(KIND_MODEL, new Uint8Array(0), MODEL.header);

    await expect
      .poll(() =>
        page.evaluate(() =>
          String(
            globalThis.__NEUTRALINO_STUB__.wrote(
              "/appdata/build123d-studio/build123d-studio.log",
            ) ?? "",
          ),
        ),
      )
      .toContain("Ignored a model with no geometry");

    // Still alive, which is the whole point: the window answers afterwards.
    await expect(page.locator("#pane-editor")).toBeVisible();
    sidecar.sendBinary(KIND_MODEL, PAYLOAD, MODEL.header);
    await expect(page.locator(".pane-viewer canvas").first()).toBeVisible();
  });
});
