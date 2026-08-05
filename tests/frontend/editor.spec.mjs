/** Saving, the New File template, and the language features on screen.
 *
 * The language half is the reason this file exists, and the reason is a trap
 * this project has already fallen into: `editor.api.js` is the API only, and
 * every widget that *displays* what a provider returns is a separate
 * contribution import. A provider registered without its widget is never asked,
 * silently - before dev42 the editor had no completion of any kind, not even
 * the word-based suggestions the worker had always computed, and nothing said
 * so. Three more contributions have been imported since for the same reason.
 *
 * `editor/completion.js`, `signature.js`, `hover.js` and `diagnostics.js` are
 * pure and already unit-tested: given a reply, they produce the right shape.
 * What none of them can answer is whether Monaco then *shows* it. That is what
 * every case below asserts, and it is the one question that would have caught
 * the trap.
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

async function openApp(page, extra = {}) {
  const handles = await open(page, {
    files: FILES,
    settings: { workspace: WORKSPACE, ...extra },
  });
  await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
  return handles;
}

async function focusEditor(page) {
  await page.locator(".monaco-editor .view-lines").first().click();
}

/** What the editor is showing, with Monaco's whitespace normalised.
 *
 * `.view-lines` renders spaces as non-breaking ones, so a substring with a
 * space in it never matches however plainly it is on screen - "Default code for
 * new files" fails against text that visibly contains exactly that.
 */
async function editorText(page) {
  const text = await page.locator(".monaco-editor .view-lines").first().innerText();
  return text.replace(/\u00a0/g, " ");
}

async function caretToEnd(page) {
  await focusEditor(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("End");
}

test.describe("saving", () => {
  test("Cmd-S writes the buffer and clears the mark", async ({ page }) => {
    await openApp(page);

    await caretToEnd(page);
    await page.keyboard.type("SAVED");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);

    await page.keyboard.press("Meta+s");

    await expect(
      page.locator(".tab-close.tab-dirty"),
      "the tab still claims unsaved work after a save",
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/part.py`,
        ),
      )
      .toContain("SAVED");
  });

  test("saving an unchanged buffer is not a no-op that loses the file", async ({ page }) => {
    // A save that failed used to look exactly like one that worked. The weakest
    // useful assertion is that the contents are still there afterwards.
    await openApp(page);

    await focusEditor(page);
    await page.keyboard.press("Meta+s");

    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/part.py`,
        ),
      )
      .toContain("Box");
  });
});

test.describe("a new file", () => {
  test("starts from the configured template", async ({ page }) => {
    // Group 3 shipped this setting with no dialog to reach it, and group 5 gave
    // it one. What matters here is that the buffer a user gets is the text they
    // configured rather than the shipped default.
    await openApp(page, { newFileTemplate: "MY_OWN_TEMPLATE = 1\n" });

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );

    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(() => editorText(page)).toContain("MY_OWN_TEMPLATE");
  });

  test("and is not dirty before anything has been typed", async ({ page }) => {
    // Quitting should not offer to save something the user never wrote.
    await openApp(page);

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );
    await expect(page.locator(".tab")).toHaveCount(2);

    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
  });
});

test.describe("Save As", () => {
  test("an unnamed buffer asks where it should live, and goes there", async ({ page }) => {
    // A new file has no path, so Cmd-S cannot mean "write it back". Save All
    // skips these deliberately - a command for getting the project onto disk
    // that stops to ask about four scratch buffers is not that - so this is the
    // one route by which an unnamed buffer acquires a name.
    await openApp(page);

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );
    await expect(page.locator(".tab")).toHaveCount(2);
    // The template has to be on screen before anything is typed into it: the
    // new buffer's model is attached asynchronously, and a click that lands
    // first goes to the outgoing one.
    await expect.poll(() => editorText(page)).toContain("Default code for new files");

    // Typed without clicking first, deliberately. New File focuses the editor
    // itself, and a click on .view-lines at that moment lands somewhere that
    // *removes* focus from Monaco's input area - measured: the inputarea is the
    // active element before the click and the editor container after it, so
    // every keystroke afterwards goes nowhere and the buffer stays clean.
    await page.keyboard.type("UNNAMED");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);

    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      `${PROJECT}/brand-new.py`,
    );
    await page.keyboard.press("Meta+s");

    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/brand-new.py`,
        ),
      )
      .toContain("UNNAMED");

    // And the tab is that file now, not an unnamed buffer that happens to have
    // been written somewhere.
    await expect(page.locator(".tab-active .tab-label")).toHaveText("brand-new.py");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
  });

  test("cancelling the chooser writes nothing and keeps the buffer", async ({ page }) => {
    await openApp(page);

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(() => editorText(page)).toContain("Default code for new files");
    await page.keyboard.type("UNNAMED");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);

    // No answer queued: the stub returns the empty string, which is a cancel.
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(300);

    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(
      page.locator(".tab-close.tab-dirty"),
      "a cancelled Save As reported the buffer as saved",
    ).toHaveCount(1);
  });
});

test.describe("the language features reach the screen", () => {
  test("the suggestion widget shows what the sidecar offered", async ({ page }) => {
    // The contribution trap, stated as a test. Without the suggest widget
    // imported, the provider below is registered and never asked - and the only
    // symptom is that nothing appears.
    const { sidecar } = await openApp(page);

    sidecar.answer("editor.complete", () => ({
      matches: ["SENTINEL_MATCH"],
      // No start/end, deliberately. Monaco is the only thing that can say where
      // the word under the cursor begins, so an entry that arrives without a
      // span gets the fallback the provider carries along - and a span invented
      // here (0..0, four columns from the cursor) makes a replacement range that
      // does not contain the caret, which Monaco silently discards. The widget
      // then never opens and it looks exactly like the contribution trap.
      types: [{ text: "SENTINEL_MATCH", type: "function", signature: "(x: int)" }],
    }));

    await caretToEnd(page);
    await page.keyboard.type("\nb.");

    await expect(page.locator(".suggest-widget")).toBeVisible();
    await expect(page.locator(".suggest-widget")).toContainText("SENTINEL_MATCH");
  });

  test("the parameter hints popup shows the signature", async ({ page }) => {
    const { sidecar } = await openApp(page);

    // The shape the sidecar actually sends: everything nested under
    // `signature`, and parameters as plain strings rather than Monaco's
    // {label} objects - signature.js is what converts them. A flat reply is
    // accepted without complaint and produces no popup at all, which looks
    // exactly like the contribution being missing.
    sidecar.answer("editor.signature", () => ({
      signature: {
        signatures: [
          {
            label: "Box(length: float, width: float, height: float)",
            parameters: ["length: float", "width: float", "height: float"],
            documentation: "Create a box.",
          },
        ],
        activeSignature: 0,
        activeParameter: 0,
      },
    }));

    await caretToEnd(page);
    await page.keyboard.type("\nBox(");

    await expect(page.locator(".parameter-hints-widget")).toBeVisible();
    await expect(page.locator(".parameter-hints-widget")).toContainText("length: float");
  });

  test("hovering a name shows what it holds", async ({ page }) => {
    const { sidecar } = await openApp(page);

    // Nested under `hover`, and the value is markdown - which hover.js hands to
    // Monaco with isTrusted off, so nothing the server sends can execute.
    sidecar.answer("editor.hover", () => ({
      hover: { value: "```python\n(variable) b: SENTINEL_HOVER\n```" },
    }));

    // Aimed at a token rather than at the line box - a line's box extends past
    // the text, and hovering empty space is not hovering a name - and moved
    // rather than teleported. Monaco opens the hover on a mousemove that dwells;
    // a single jump to the coordinates delivers one event and the widget is
    // built but never shown, which reads as the feature being off.
    const token = await page.locator(".view-line span span").first().boundingBox();
    await page.mouse.move(token.x + token.width / 2, token.y + token.height / 2);
    await page.mouse.move(token.x + token.width / 2 + 1, token.y + token.height / 2);

    // Monaco keeps a second, hidden .monaco-hover parked in the overflow
    // widgets container, so "the last one" is the empty one and "the first one"
    // is only right by luck. The visible one is the one being asserted about.
    const hover = page.locator(".monaco-hover:not(.hidden)");
    await expect(hover).toBeVisible();
    await expect(hover).toContainText("SENTINEL_HOVER");
  });

  test("a pushed diagnostic becomes a squiggle in the gutter", async ({ page }) => {
    // Diagnostics are pushed rather than requested, so this is a subscription.
    // The conversion is the interesting part and is unit-tested: LSP counts from
    // zero and Monaco from one, which is how a squiggle ends up underlining the
    // line above the mistake.
    const { sidecar } = await openApp(page);

    // Matched to a buffer by `key`, which is the registry's own id - the first
    // buffer opened is 1. A frame with the wrong key is dropped in silence,
    // which is correct (its model may be disposed) and indistinguishable from
    // diagnostics being broken.
    sidecar.send("editor.diagnostics", {
      key: 1,
      path: `${PROJECT}/part.py`,
      diagnostics: [
        {
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 1 },
          },
          message: "SENTINEL_PROBLEM",
          severity: 1,
          source: "basedpyright",
          code: "reportUndefinedVariable",
        },
      ],
    });

    await expect(page.locator(".squiggly-error, .squiggly-warning").first()).toBeVisible();
  });

  test("and an empty list takes the squiggles away again", async ({ page }) => {
    // A fixed file has to publish an empty list rather than going quiet, or the
    // gutter keeps a mistake the user has already corrected.
    const { sidecar } = await openApp(page);

    sidecar.send("editor.diagnostics", {
      key: 1,
      path: `${PROJECT}/part.py`,
      diagnostics: [
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          message: "SENTINEL_PROBLEM",
          severity: 1,
          source: "basedpyright",
          code: "reportUndefinedVariable",
        },
      ],
    });
    await expect(page.locator(".squiggly-error, .squiggly-warning").first()).toBeVisible();

    sidecar.send("editor.diagnostics", {
      key: 1,
      path: `${PROJECT}/part.py`,
      diagnostics: [],
    });

    await expect(page.locator(".squiggly-error, .squiggly-warning")).toHaveCount(0);
  });
});
