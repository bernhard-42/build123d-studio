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
 * (`Box(1, 2, 3)` through the shared core's `_convert`, split by the kernel's
 * own `split_buffers`), not a header written by hand. A hand-written one would
 * only ever prove that the test agrees with the test: rehydrate() reads dtypes,
 * offsets and lengths that ocp_tessellate chose, and inventing them is
 * inventing the thing under test.
 *
 * **Recaptured when this host adopted `ocp_viewer_core`, and that is not
 * bookkeeping.** The old capture carried its config in Python's names -
 * `render_edges`, `reset_camera`, `helper_scale` - because the frontend used to
 * do that conversion itself. The core converts once at the wire, so what
 * arrives now is `renderEdges`, `resetCamera`, `helperScale`. Feeding the old
 * frame to the new pipeline is feeding it a message no host produces: almost
 * every key is unrecognised, the renderer silently keeps what it had, and the
 * test measures the previous format rather than this one. A captured fixture
 * has to be recaptured whenever the thing it captured changes.
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/viewer/viewer.js, the zero-length payload check - a model with no
 *   geometry is refused rather than hanging
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

  test("what the browser prints reaches its own log file", async ({ page }) => {
    // On macOS there is no developer console at all - Safari lists a WKWebView
    // only when `isInspectable` is set, which no Neutralino release does - so a
    // file is the only place a fault can be read from a user's machine. What
    // matters there is what *nobody here wrote*: a renderer refusing a model, a
    // failed request, a library's own warning.
    //
    // Raised deliberately rather than by provoking a real one. This asserted on
    // three-cad-viewer's NaN bounding sphere while a bad fixture was producing
    // it; the fixture was wrong, the warning went away, and the test went with
    // it. What this application owns is the mirror, so that is what is tested -
    // and `console.error` is the level Settings forwards by default.
    await openApp(page);
    await page.evaluate(() => console.error("probe: a library complaining"));

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            String(
              globalThis.__NEUTRALINO_STUB__.wrote(
                "/appdata/build123d-studio/console.log",
              ) ?? "",
            ),
          ),
        { message: "the browser's console output never reached console.log" },
      )
      .toContain("console.error: probe: a library complaining");

    // And not into the application's own log, which stays the narrative a user
    // is asked for rather than a firehose.
    const own = await page.evaluate(() =>
      String(
        globalThis.__NEUTRALINO_STUB__.wrote(
          "/appdata/build123d-studio/build123d-studio.log",
        ) ?? "",
      ),
    );
    expect(own).not.toContain("probe: a library complaining");
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

test.describe("the modifier keys the viewer is built with", () => {
  // The viewer is constructed once, at the splash, and its help overlay is
  // rendered from the keymap it was constructed with - `{{meta}}` in the
  // template becomes whichever key the map says. Later shows re-apply theme,
  // glass and tools and nothing more, so what the splash was given is what the
  // user gets. This host sent only the theme, so on Windows and Linux the help
  // said <meta> and the chords were on the Win key, which the desktop keeps.
  const help = (page) =>
    page.evaluate(() => document.querySelector(".tcv_cad_help_layout")?.innerHTML ?? "");

  test("on Windows the meta chords are on the Alt key, and the help says so", async ({ page }) => {
    await open(page, { platform: "Windows", files: FILES, settings: { workspace: WORKSPACE } });
    await expect(page.locator(".pane-viewer canvas").first()).toBeVisible();

    const html = await help(page);
    expect(html).toContain("&lt;alt&gt; + &lt;left mouse button&gt;");
    expect(html).not.toContain("&lt;meta&gt;");
  });

  test("and a show afterwards leaves them there", async ({ page }) => {
    // The report was "not only a splash issue - still there when showing a
    // model". True of the build that sent no keymap: the viewer built at the
    // splash keeps its map through every show, so a wrong one stayed wrong and
    // a right one stays right. A show reuses the viewer - clear(), then render
    // - and neither touches the keymap; only setKeyMap does, and the help is
    // rewritten in the same call, so the help after a show is the map after a
    // show.
    const { sidecar } = await open(page, {
      platform: "Windows", files: FILES, settings: { workspace: WORKSPACE },
    });
    await expect(page.locator(".pane-viewer canvas").first()).toBeVisible();

    // The fixture was recorded on macOS and its header carries that keymap.
    // On Windows the kernel answers workspace_config() with the Alt map, so
    // the header a real show carries there is this one.
    sidecar.sendBinary(KIND_MODEL, PAYLOAD, {
      ...MODEL.header,
      config: {
        ...(MODEL.header.config ?? {}),
        keymap: { shift: "shiftKey", ctrl: "ctrlKey", meta: "altKey", alt: "metaKey" },
      },
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          String(globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/build123d-studio.log") ?? "")))
      .toContain("Model rendered");

    const html = await help(page);
    expect(html).toContain("&lt;alt&gt; + &lt;left mouse button&gt;");
    expect(html).not.toContain("&lt;meta&gt;");
  });

  test("on macOS they stay on Cmd", async ({ page }) => {
    // The control, and the reason this went unnoticed: on macOS the logo's
    // own map and this platform's are the same map.
    await open(page, { platform: "Darwin", files: FILES, settings: { workspace: WORKSPACE } });
    await expect(page.locator(".pane-viewer canvas").first()).toBeVisible();

    const html = await help(page);
    expect(html).toContain("&lt;meta&gt; + &lt;left mouse button&gt;");
  });

  const renderModel = async (page, sidecar) => {
    sidecar.sendBinary(KIND_MODEL, PAYLOAD, MODEL.header);
    await expect
      .poll(() =>
        page.evaluate(() =>
          String(globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/build123d-studio.log") ?? "")))
      .toContain("Model rendered");
  };

  const changeMetaTo = async (page, modifier) => {
    await page.locator("#btn-settings").click();
    await page.locator("#tab-viewer").click();
    await page.locator("#viewer-modifier_keys-meta").selectOption(modifier);
    await page.locator("#settings-apply").click();
    await expect(page.locator("#settings-apply")).toBeHidden();
  };

  test("changing the keys in Settings takes effect at the next show, not before", async ({ page }) => {
    // The keys are a construction-time option the viewer is given once, and a
    // show re-applies theme, glass and tools and nothing more - so until now a
    // change took effect at the next startup and never before, on every
    // platform. It now travels the way every other viewer setting does: the
    // next show's header carries the map the kernel read from the file just
    // written, and the render puts that map onto the viewer. Applying the
    // dialog changes nothing on screen by itself.
    const { sidecar } = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    await renderModel(page, sidecar);
    expect(await help(page)).toContain("&lt;meta&gt; + &lt;left mouse button&gt;");

    await changeMetaTo(page, "ctrlKey");
    expect(await help(page)).toContain("&lt;meta&gt; + &lt;left mouse button&gt;");

    // The kernel would answer workspace_config() from the file just written;
    // the harness's model carries its header, so give it the changed keymap
    // the way the sidecar would.
    sidecar.sendBinary(KIND_MODEL, PAYLOAD, {
      ...MODEL.header,
      config: { ...(MODEL.header.config ?? {}), keymap: { shift: "shiftKey", ctrl: "ctrlKey", meta: "ctrlKey", alt: "altKey" } },
    });
    // The second render, not the first: the log already says it once.
    await expect
      .poll(() =>
        page.evaluate(() =>
          String(globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/build123d-studio.log") ?? "")
            .split("Model rendered").length - 1))
      .toBe(2);

    const html = await help(page);
    expect(html).toContain("&lt;ctrl&gt; + &lt;left mouse button&gt; double");
    expect(html).not.toContain("&lt;meta&gt;");
  });

  test("and a map stored in Settings wins over the platform's default", async ({ page }) => {
    // The keys are the user's to change, and the dialog stores only what
    // differs - so a stored map is a deliberate one and has to reach the
    // viewer ahead of anything this host would have chosen.
    await open(page, {
      platform: "Windows",
      files: FILES,
      settings: {
        workspace: WORKSPACE,
        viewer: { modifier_keys: { shift: "shiftKey", ctrl: "ctrlKey", meta: "ctrlKey", alt: "altKey" } },
      },
    });
    await expect(page.locator(".pane-viewer canvas").first()).toBeVisible();

    const html = await help(page);
    expect(html).toContain("&lt;ctrl&gt; + &lt;left mouse button&gt; double");
  });
});
