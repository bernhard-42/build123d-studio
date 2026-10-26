/** Export… in the variable explorer: the dialog, the save panel, the line run.
 *
 * The kernel's answer is a capture of the real one - exporting.forms() against
 * build123d 0.13.0 - so the controls drawn here are the ones a real signature
 * produces, not a shape written to suit the test. tests/sidecar/test_exporting.py
 * checks the capture's source against the installed build123d.
 *
 * The harness runs as macOS, where the save panel is Studio's own
 * `choose file name` script. The stub holds it open until a test answers - see
 * holdSavePanel - so a test can look at the window while the panel is up; a
 * path is a chosen file and an empty answer is the panel closed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORMS = JSON.parse(readFileSync(join(HERE, "fixtures", "export-forms.json"), "utf8")).forms;

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

const VARIABLES = [
  { name: "b", type: "Box", module: "build123d", size: null, repr: "Box at 0x1", label: "", expandable: false, export: "" },
  { name: "bp", type: "BuildPart", module: "build123d", size: null, repr: "BuildPart", label: "", expandable: false, export: ".part" },
  { name: "count", type: "int", module: "builtins", size: null, repr: "42", label: "", expandable: false, export: null },
];

async function openApp(page, settings = {}) {
  const handles = await open(page, { files: FILES, settings: { workspace: WORKSPACE, ...settings } });
  handles.sidecar.answer("export.forms", () => ({ forms: FORMS }));
  handles.sidecar.send("vars.data", { variables: VARIABLES });
  await expect(page.locator(".var-row .var-name")).toHaveCount(VARIABLES.length);
  return handles;
}

async function openExport(page, name) {
  await page.locator(".var-row", { has: page.locator(".var-name", { hasText: new RegExp(`^${name}$`) }) })
    .click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Export…" }).click();
  await expect(page.locator("#export-format")).toBeVisible();
}

function holdSavePanel(page) {
  return page.evaluate(() => globalThis.__NEUTRALINO_STUB__.holdSavePanel());
}

/** Wait for the held panel to be open, then answer it. */
async function answerSavePanel(page, path) {
  await expect.poll(() => page.evaluate(() => globalThis.__NEUTRALINO_STUB__.savePanelHeld())).toBe(true);
  await page.evaluate((answer) => globalThis.__NEUTRALINO_STUB__.releaseSavePanel(answer), path);
}

function executed(sidecar) {
  return sidecar.received.filter((frame) => frame.type === "kernel.execute").map((frame) => frame.code);
}

async function storedSettings(page) {
  return page.evaluate(() =>
    JSON.parse(String(globalThis.__NEUTRALINO_STUB__.wrote("/appdata/build123d-studio/settings.json") ?? "{}")));
}

test.describe("Export… in the variable explorer", () => {
  test("is offered on a shape and a builder, and greyed on anything else", async ({ page }) => {
    await openApp(page);
    const item = page.locator(".context-menu-item", { hasText: "Export…" });

    for (const [name, enabled] of [["b", true], ["bp", true], ["count", false]]) {
      await page.locator(".var-row", { has: page.locator(".var-name", { hasText: new RegExp(`^${name}$`) }) })
        .click({ button: "right" });
      if (enabled) {
        await expect(item, name).toBeEnabled();
      } else {
        await expect(item, name).toBeDisabled();
      }
      await page.keyboard.press("Escape");
    }
  });

  test("is greyed when more than one row is selected", async ({ page }) => {
    await openApp(page);
    await page.locator(".var-row", { hasText: "Box at" }).click();
    await page.locator(".var-row", { hasText: "BuildPart" }).click({ modifiers: ["Meta"] });
    await page.locator(".var-row", { hasText: "Box at" }).click({ button: "right" });
    await expect(page.locator(".context-menu-item", { hasText: "Export…" })).toBeDisabled();
  });

  test("opens on STEP with the signature's defaults", async ({ page }) => {
    await openApp(page);
    await openExport(page, "b");

    await expect(page.locator("#export-format")).toHaveValue("STEP");
    await expect(page.locator("#export-option-unit")).toHaveValue("MM");
    await expect(page.locator("#export-option-write_pcurves")).toBeChecked();
    await expect(page.locator("#export-option-precision_mode")).toHaveValue("AVERAGE");
    await expect(page.locator("#export-option-timestamp")).toHaveValue("");
    await expect(page.locator("#export-note")).toBeHidden();
  });

  test("switching format shows that format's options and keeps what was typed", async ({ page }) => {
    await openApp(page);
    await openExport(page, "b");
    await page.locator("#export-option-unit").selectOption("IN");

    await page.locator("#export-format").selectOption("STL");
    await expect(page.locator("#export-option-tolerance")).toHaveValue("0.001");
    await expect(page.locator("#export-option-unit")).toHaveCount(0);
    await expect(page.locator("#export-note")).toContainText("flattened");

    await page.locator("#export-format").selectOption("BREP");
    await expect(page.locator("#export-options")).toContainText("export_brep has no options");

    await page.locator("#export-format").selectOption("STEP");
    await expect(page.locator("#export-option-unit")).toHaveValue("IN");
  });

  test("Export closes the dialog, asks for the file, and runs the call with what changed", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await openExport(page, "b");
    await page.locator("#export-option-unit").selectOption("IN");
    await holdSavePanel(page);

    await page.locator("#export-run").click();

    // The dialog's step is over before the panel's begins.
    await expect(page.locator("#export-dialog")).toHaveCount(0);
    await answerSavePanel(page, `${PROJECT}/out.step`);
    const frame = await sidecar.waitFor("kernel.execute");
    expect(frame.code).toBe([
      "from build123d import export_step, Unit",
      `if export_step(b, "${PROJECT}/out.step", unit=Unit.IN):`,
      `    print("Exported b to ${PROJECT}/out.step")`,
      "else:",
      `    print("export_step returned False: ${PROJECT}/out.step was not written")`,
    ].join("\n"));

    const panel = await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.calls().filter((call) => call.name === "execCommand").map((call) => call.args[0]));
    expect(panel.some((command) => command.includes('default name \\"b.step\\"') || command.includes('default name "b.step"'))).toBe(true);

    await expect.poll(() => storedSettings(page)).toMatchObject({
      exportDialog: { format: "STEP", values: { STEP: { unit: "IN" } } },
    });
  });

  test("a builder exports what it built, under the builder's name", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await openExport(page, "bp");
    await page.locator("#export-format").selectOption("STL");
    await holdSavePanel(page);

    await page.locator("#export-run").click();
    await answerSavePanel(page, `${PROJECT}/bp.stl`);

    const frame = await sidecar.waitFor("kernel.execute");
    expect(frame.code).toContain(`if export_stl(bp.part, "${PROJECT}/bp.stl"):`);
  });

  test("a part inside an assembly exports by its expression, under its label", async ({ page }) => {
    // Proof, at writing: with exportTargetFor taking the name from
    // dataset.variable again, this fails on the suggested name.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: [...VARIABLES, {
      name: "asm", type: "Compound", module: "build123d", size: 2, repr: "", label: "asm", expandable: true, export: "",
    }] });
    await page.locator(".var-row", { hasText: "Compound" }).locator(".var-twisty").click();
    const asked = await sidecar.waitFor("vars.detail");
    const part = { type: "Box", module: "build123d", size: null, repr: "Box", expandable: false, export: "" };
    sidecar.send("vars.detail", { detail: { path: asked.path, type: "Compound", attributes: {}, offset: 0, total: 2, page: 50, children: [
      { ...part, name: "0", label: "base/plate", expression: "asm.children[0]" },
      { ...part, name: "1", label: "", expression: "asm.children[1]" },
    ] } });

    for (const [label, expression, suggested] of [
      ["base/plate", "asm.children[0]", "base_plate.step"],
      [/^1$/, "asm.children[1]", "asm.children[1].step"],
    ]) {
      await page.locator(".var-row", { has: page.locator(".var-child-name", { hasText: label }) }).click({ button: "right" });
      await page.locator(".context-menu-item", { hasText: "Export…" }).click();
      await expect(page.locator(".info-title")).toHaveText(`Export ${expression}`);
      await holdSavePanel(page);
      await page.locator("#export-run").click();
      await answerSavePanel(page, `${PROJECT}/${suggested}`);

      const panel = await page.evaluate(() =>
        globalThis.__NEUTRALINO_STUB__.calls().filter((call) => call.name === "execCommand").map((call) => call.args[0]));
      expect(panel.at(-1)).toContain(suggested);
      await expect.poll(() => executed(sidecar).at(-1) ?? "").toContain(`if export_step(${expression}, "${PROJECT}/${suggested}"):`);
    }
  });

  test("closing the save panel cancels the export, and the options are kept for next time", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await openExport(page, "b");
    await page.locator("#export-option-unit").selectOption("CM");
    await holdSavePanel(page);

    await page.locator("#export-run").click();
    await expect(page.locator("#export-dialog")).toHaveCount(0);
    await answerSavePanel(page, "");

    // One cancel ends the workflow: the dialog does not come back.
    await page.waitForTimeout(200);
    await expect(page.locator("#export-dialog")).toHaveCount(0);
    expect(executed(sidecar)).toEqual([]);

    await openExport(page, "b");
    await expect(page.locator("#export-option-unit")).toHaveValue("CM");
  });

  test("Cancel and Escape close it and run nothing", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await openExport(page, "b");
    await page.locator("#export-cancel").click();
    await expect(page.locator("#export-dialog")).toHaveCount(0);

    await openExport(page, "b");
    await page.keyboard.press("Escape");
    await expect(page.locator("#export-dialog")).toHaveCount(0);

    await page.waitForTimeout(200);
    expect(executed(sidecar)).toEqual([]);
  });

  test("a number that is not one is refused in the dialog, before the panel", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await openExport(page, "b");
    await page.locator("#export-format").selectOption("STL");
    await page.locator("#export-option-tolerance").fill("fine");

    await page.locator("#export-run").click();

    await expect(page.locator("#export-problems")).toHaveText("tolerance needs a number.");
    // Save panels only: startup also runs `ps -A` through execCommand, for the
    // recovery journal's owner - see liveness.js.
    const panels = await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.calls()
        .filter((call) => call.name === "execCommand" && String(call.args[0]).includes("choose file name"))
        .length);
    expect(panels).toBe(0);
    expect(executed(sidecar)).toEqual([]);
  });

  test("the last format and its options are where the next export starts", async ({ page }) => {
    await openApp(page, {
      exportDialog: { format: "GLTF", values: { GLTF: { binary: true, unit: "M" }, STEP: { unit: "PARSEC" } } },
    });
    await openExport(page, "b");

    await expect(page.locator("#export-format")).toHaveValue("GLTF");
    await expect(page.locator("#export-option-binary")).toBeChecked();
    await expect(page.locator("#export-option-unit")).toHaveValue("M");

    // A remembered value the options no longer accept falls back to the default.
    await page.locator("#export-format").selectOption("STEP");
    await expect(page.locator("#export-option-unit")).toHaveValue("MM");
  });

  test("says so when the kernel cannot answer", async ({ page }) => {
    const { sidecar } = await openApp(page);
    sidecar.answer("export.forms", () => ({ forms: null }));
    await page.locator(".var-row", { hasText: "Box at" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Export…" }).click();

    await expect(page.locator("#export-status")).toContainText("could not be read from the kernel");
    await expect(page.locator("#export-run")).toBeDisabled();
  });
});
