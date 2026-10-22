/** File > Import…: the open dialog, the options dialog, the assignment run.
 *
 * The kernel's answer is a capture of the real one - importing.forms() against
 * build123d 0.13.0 - so the controls are the ones a real signature produces.
 * tests/sidecar/test_importing.py checks the capture's source against the
 * installed build123d.
 *
 * The open dialog is Neutralino's own; the stub answers it from the dialog
 * queue, a list with one path being a chosen file and an empty list a cancel.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORMS = JSON.parse(readFileSync(join(HERE, "fixtures", "import-forms.json"), "utf8")).forms;

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

async function openApp(page, settings = {}) {
  const handles = await open(page, { files: FILES, settings: { workspace: WORKSPACE, ...settings } });
  handles.sidecar.answer("import.forms", () => ({ forms: FORMS }));
  return handles;
}

/** Choose File > Import…, with the open dialog answering `entries`. */
async function importVia(page, entries) {
  await page.evaluate((answer) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(answer), entries);
  await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.import" }));
}

/**
 * The editor's lines as drawn, top to bottom.
 *
 * Sorted by position rather than read as the container's text: Monaco reuses
 * line elements after an edit, so their order in the page is not the order on
 * screen, and the container's text runs them together.
 */
async function editorText(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".monaco-editor .view-lines .view-line")];
    lines.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    // Monaco draws spaces as other space characters; any of them is a space.
    return lines.map((line) => line.textContent.replace(/\s/g, " ").trimEnd()).join("\n").replace(/\n+$/, "");
  });
}

function executed(sidecar) {
  return sidecar.received.filter((frame) => frame.type === "kernel.execute").map((frame) => frame.code);
}

async function storedSettings(page) {
  return page.evaluate(() =>
    JSON.parse(String(globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/settings.json") ?? "{}")));
}

test.describe("File > Import…", () => {
  test("asks for a CAD file first, filtered to what build123d imports", async ({ page }) => {
    await openApp(page);
    await importVia(page, []);

    const asked = await expect
      .poll(() => page.evaluate(() =>
        globalThis.__NEUTRALINO_STUB__.calls().filter((call) => call.name === "showOpenDialog")))
      .toHaveLength(1)
      .then(() => page.evaluate(() =>
        globalThis.__NEUTRALINO_STUB__.calls().find((call) => call.name === "showOpenDialog").args));
    const [title, options] = asked;
    expect(title).toBe("Import a CAD file");
    expect(options.defaultPath).toBe(PROJECT);
    expect([...options.filters[0].extensions].sort()).toEqual(["brep", "dxf", "step", "stl", "stp", "svg"]);
  });

  test("a cancelled open dialog ends it: no dialog, nothing run", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await importVia(page, []);

    await page.waitForTimeout(300);
    await expect(page.locator("#import-dialog")).toHaveCount(0);
    expect(executed(sidecar)).toEqual([]);
  });

  test("a STEP file is imported under the name of the file", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await importVia(page, [`${PROJECT}/frame-v2.step`]);

    await expect(page.locator("#import-dialog .info-title")).toHaveText("Import frame-v2.step");
    await expect(page.locator("#import-variable")).toHaveValue("frame_v2");
    await expect(page.locator("#import-options")).toContainText("import_step has no options");

    await page.locator("#import-run").click();

    await expect(page.locator("#import-dialog")).toHaveCount(0);
    await expect.poll(() => executed(sidecar)).toEqual([
      "# Importing frame-v2.step as frame_v2 ...",
      [
        "from build123d import import_step",
        "from build123d_studio import show, Camera",
        `frame_v2 = import_step("${PROJECT}/frame-v2.step")`,
        'show(frame_v2, names=["frame_v2"], reset_camera=Camera.RESET)',
      ].join("\n"),
    ]);
  });

  test("an STL's unit is an option, passed when changed and remembered", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await importVia(page, [`${PROJECT}/bracket.stl`]);
    await expect(page.locator("#import-option-model_unit")).toHaveValue("MM");

    await page.locator("#import-option-model_unit").selectOption("IN");
    await page.locator("#import-variable").fill("holder");
    await page.locator("#import-run").click();

    await expect.poll(() => executed(sidecar).at(-1)).toContain(
      `from build123d import import_stl, Unit\nfrom build123d_studio import show, Camera\nholder = import_stl("${PROJECT}/bracket.stl", model_unit=Unit.IN)`,
    );
    await expect.poll(() => storedSettings(page)).toMatchObject({
      importDialog: { values: { STL: { model_unit: "IN" } } },
    });
  });

  test("the last options for a format are where the next import of it starts", async ({ page }) => {
    await openApp(page, { importDialog: { values: { SVG: { flip_y: false, align: "CENTER" } } } });
    await importVia(page, [`${PROJECT}/logo.svg`]);

    await expect(page.locator("#import-option-flip_y")).not.toBeChecked();
    await expect(page.locator("#import-option-align")).toHaveValue("CENTER");
    await expect(page.locator("#import-option-label_by")).toHaveValue("id");
  });

  test("a name Python cannot assign to is refused in the dialog", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await importVia(page, [`${PROJECT}/frame.step`]);
    await page.locator("#import-variable").fill("2frame");

    await page.locator("#import-run").click();

    await expect(page.locator("#import-problems")).toContainText("not a Python name");
    await expect(page.locator("#import-dialog")).toHaveCount(1);
    expect(executed(sidecar)).toEqual([]);

    await page.locator("#import-variable").fill("frame2");
    await page.locator("#import-run").click();
    await expect.poll(() => executed(sidecar)).toHaveLength(2);
  });

  test("the box for the file is unticked, and unticked the file is left alone", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await importVia(page, [`${PROJECT}/frame.step`]);
    await expect(page.locator("#import-insert")).not.toBeChecked();
    await expect(page.locator("#import-insert")).toBeEnabled();

    await page.locator("#import-run").click();

    await expect.poll(() => executed(sidecar)).toHaveLength(2);
    expect(await editorText(page)).toBe("PART = 1");
  });

  // What goes into the file: the import statement alone.
  const LINES = (variable) => [
    "from build123d import import_step",
    `${variable} = import_step("${PROJECT}/${variable}.step")`,
  ];

  test("ticked, with the caret at the end of a line, the import goes below it", async ({ page }) => {
    // The caret is where the user left it, not where giving the keyboard back
    // after the open dialog puts it - the top of the buffer.
    const { sidecar } = await openApp(page);
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Meta+ArrowUp");
    await page.keyboard.press("End");
    await importVia(page, [`${PROJECT}/frame.step`]);
    await page.locator("#import-insert").check();

    await page.locator("#import-run").click();

    await expect.poll(() => executed(sidecar)).toHaveLength(2);
    await expect.poll(() => editorText(page)).toBe(["PART = 1", ...LINES("frame")].join("\n"));
  });

  test("ticked, with the caret at the start of a line, the import goes above it", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Meta+ArrowUp");
    await page.keyboard.press("Home");
    await importVia(page, [`${PROJECT}/frame.step`]);
    await page.locator("#import-insert").check();

    await page.locator("#import-run").click();

    await expect.poll(() => executed(sidecar)).toHaveLength(2);
    await expect.poll(() => editorText(page)).toBe([...LINES("frame"), "PART = 1"].join("\n"));
  });

  test("ticked, into a file that imports build123d already, only the assignment goes in", async ({ page }) => {
    const handles = await open(page, {
      files: { [`${PROJECT}/part.py`]: "from build123d import *\n" },
      settings: { workspace: WORKSPACE },
    });
    handles.sidecar.answer("import.forms", () => ({ forms: FORMS }));
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Meta+ArrowDown");
    await importVia(page, [`${PROJECT}/frame.step`]);
    await page.locator("#import-insert").check();

    await page.locator("#import-run").click();

    // The console still imports and shows; the file gets the statement alone.
    await expect.poll(() => executed(handles.sidecar).at(-1)).toContain("show(frame");
    await expect.poll(() => editorText(page)).toBe([
      "from build123d import *",
      `frame = import_step("${PROJECT}/frame.step")`,
    ].join("\n"));
  });

  test("with every tab closed the box is greyed", async ({ page }) => {
    // A start always has a tab - an empty scratch one at least - so no file
    // open is what closing them all leaves.
    await openApp(page);
    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.closeAll" }));
    await expect(page.locator(".tab")).toHaveCount(0);
    await importVia(page, [`${PROJECT}/frame.step`]);

    await expect(page.locator("#import-insert")).toBeDisabled();
  });

  test("Cancel and Escape end it and run nothing", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await importVia(page, [`${PROJECT}/frame.step`]);
    await expect(page.locator("#import-variable")).toBeVisible();
    await page.locator("#import-cancel").click();
    await expect(page.locator("#import-dialog")).toHaveCount(0);

    await importVia(page, [`${PROJECT}/frame.step`]);
    await expect(page.locator("#import-variable")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#import-dialog")).toHaveCount(0);

    await page.waitForTimeout(200);
    expect(executed(sidecar)).toEqual([]);
  });

  test("a file build123d does not import is said so, with nothing to run", async ({ page }) => {
    await openApp(page);
    await importVia(page, [`${PROJECT}/notes.txt`]);

    await expect(page.locator("#import-status")).toHaveText(
      "notes.txt is not a file build123d imports: BREP, DXF, STEP, STL or SVG.",
    );
    await expect(page.locator("#import-run")).toBeDisabled();
  });

  test("says so when the kernel cannot answer", async ({ page }) => {
    const { sidecar } = await openApp(page);
    sidecar.answer("import.forms", () => ({ forms: null }));
    await importVia(page, [`${PROJECT}/frame.step`]);

    await expect(page.locator("#import-status")).toContainText("could not be read from the kernel");
    await expect(page.locator("#import-run")).toBeDisabled();
  });
});
