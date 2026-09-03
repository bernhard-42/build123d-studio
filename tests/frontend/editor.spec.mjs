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
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/editor/monaco.js, each Monaco contribution import on its own:
 *   suggestController, parameterHints, hoverContribution and quickCommand -
 *   the suggestion widget, the parameter hints popup, the hover tooltip and
 *   the command palette, one test each and no others
 * - src/editor/monaco.js, the comment contribution - Cmd-/ comments the line,
 *   and Monaco's own actions are in the palette
 * - src/editor/monaco.js, find **and** multicursor together - Cmd-F opens the
 *   find widget. One import at a time proves nothing here: multicursor imports
 *   findController, so removing the find import alone leaves Cmd-F working
 * - src/editor/monaco.js, folding **and** stickyScroll together - a block gets
 *   a fold control. Same shape: stickyScrollController imports the folding
 *   contribution, so folding survives its own import being taken out
 * - src/editor/monaco.js, formatLineLength() in the format request replaced by
 *   a literal - the line length from settings is what is asked for
 *
 * Not proved, and said here rather than left to look proved: nothing in this
 * file can redden formatEdits' identity check. Monaco discards a no-op edit
 * itself, so an edit replacing the text with the same text produces neither an
 * undo stop nor a dirty mark. That property is asserted in format.test.mjs
 * instead, where it fails properly; the case written for it here was deleted.
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

  test("Save All asks where an unnamed buffer should go, rather than skipping it", async ({ page }) => {
    // A buffer that has never been saved is the one with no other copy
    // anywhere, so leaving it out of "save all" leaves out the only thing that
    // cannot be recovered from disk.
    await openApp(page);

    await caretToEnd(page);
    await page.keyboard.type("NAMED");
    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(() => editorText(page)).toContain("Default code for new files");
    await page.keyboard.type("SCRATCH");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(2);

    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      `${PROJECT}/scratch.py`,
    );
    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.saveAll" }),
    );

    await expect
      .poll(() => page.evaluate(
        (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
        `${PROJECT}/scratch.py`,
      ), { message: "the unnamed buffer was skipped" })
      .toContain("SCRATCH");
    await expect
      .poll(() => page.evaluate(
        (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
        `${PROJECT}/part.py`,
      ))
      .toContain("NAMED");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
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

  test("the toolbar button leaves the stops live, as the menu does", async ({ page }) => {
    // The path a user actually presses, and the one that was broken: the button
    // used to place the caret after the file was made, which is how Monaco is
    // told a snippet session is over - so the stops were consumed and nothing
    // could be tabbed between. The menu did not do that, so a test driving the
    // menu event could not see it.
    await openApp(page, { newFileTemplate: "part = ${1:Box}(1)\nshow(part)$0\n" });

    await page.locator("#btn-new").click();
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(() => editorText(page)).toContain("part = Box(1)");

    await page.keyboard.type("Cylinder");
    await expect.poll(() => editorText(page)).toContain("part = Cylinder(1)");
  });

  test("the template is a snippet, and Tab walks its stops", async ({ page }) => {
    // The template is inserted rather than being the text the buffer starts
    // with, which is what makes the stops exist at all - a snippet session is
    // live editing state, not a string.
    await openApp(page, {
      newFileTemplate: "part = ${1:Box}(${2:1, 2, 3})\nshow(part)$0\n",
    });

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect.poll(() => editorText(page)).toContain("part = Box(1, 2, 3)");

    // The first stop is selected, so typing replaces it rather than inserting
    // beside it.
    await page.keyboard.type("Cylinder");
    await expect.poll(() => editorText(page)).toContain("part = Cylinder(1, 2, 3)");

    // And Tab moves to the second, which is the half a plain insertion cannot do.
    await page.keyboard.press("Tab");
    await page.keyboard.type("2, 4");
    await expect.poll(() => editorText(page)).toContain("part = Cylinder(2, 4)");
  });

  test("a template with no stops still opens at its first line", async ({ page }) => {
    // Inserting leaves the caret after what was inserted, which for a long
    // template scrolls the first line out of sight - so the file appears to
    // start in the middle of its own comment.
    await openApp(page, {
      newFileTemplate: `# FIRST LINE\n${"# filler\n".repeat(60)}# LAST LINE\n`,
    });

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );
    await expect(page.locator(".tab")).toHaveCount(2);

    await expect.poll(() => editorText(page)).toContain("FIRST LINE");
  });

  test("a variable in the template is filled in", async ({ page }) => {
    await openApp(page, { newFileTemplate: "# $CURRENT_YEAR\n" });

    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.new" }),
    );
    await expect(page.locator(".tab")).toHaveCount(2);

    const year = String(new Date().getFullYear());
    await expect.poll(() => editorText(page)).toContain(year);
    expect(await editorText(page)).not.toContain("CURRENT_YEAR");
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
    // A new file has no path, so Cmd-S cannot mean "write it back": it opens
    // the panel instead, and the buffer acquires a name from what is typed
    // into it.
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

test.describe("the user's own snippets", () => {
  // The shape build123d-portable ships, with its comments removed. The marks on
  // the prefixes are deliberate: they keep these clear of anything basedpyright
  // would suggest, and they are exactly what Monaco's own word handling cannot
  // filter on - see src/editor/snippets.js.
  const SNIPPETS = JSON.stringify({
    BuildPart: { scope: "python", prefix: "?bdp", body: ["with BuildPart() as p$1:", "    $0"] },
    BuildSketch: { scope: "python", prefix: "?bds", body: ["with BuildSketch($1) as s$2:", "    $0"] },
    Extrude: { scope: "python", prefix: ">ext", body: ["extrude(amount=$1)"] },
  });

  async function openWithSnippets(page) {
    await open(page, {
      files: { ...FILES, "/appdata/build123d-studio/snippets.json": SNIPPETS },
      settings: { workspace: WORKSPACE },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
  }

  test("the shipped set is there with no file of your own", async ({ page }) => {
    // What a new installation has: build123d-portable's set, vendored.
    await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");

    await caretToEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("?bdp");
    await expect(page.locator(".suggest-widget .monaco-list-row").first()).toBeVisible();
    await page.keyboard.press("Enter");

    await expect.poll(() => editorText(page)).toContain("with BuildPart() as p:");
  });

  test("and a snippet of your own replaces the shipped one with that prefix", async ({ page }) => {
    await open(page, {
      files: {
        ...FILES,
        "/appdata/build123d-studio/snippets.json": JSON.stringify({
          Mine: { prefix: "?bdp", body: ["MY OWN BUILD PART$0"] },
        }),
      },
      settings: { workspace: WORKSPACE },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");

    await caretToEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("?bdp");
    await expect(page.locator(".suggest-widget .monaco-list-row").first()).toBeVisible();
    await page.keyboard.press("Enter");

    await expect.poll(() => editorText(page)).toContain("MY OWN BUILD PART");
    expect(await editorText(page)).not.toContain("with BuildPart()");
  });

  test("typing a prefix offers the snippets it starts", async ({ page }) => {
    await openWithSnippets(page);
    await caretToEnd(page);
    await page.keyboard.press("Enter");

    await page.keyboard.type("?b");

    const rows = page.locator(".suggest-widget .monaco-list-row");
    await expect(rows.first()).toBeVisible();
    const labels = await rows.allTextContents();
    expect(labels.join(" ")).toContain("?bdp");
    expect(labels.join(" ")).toContain("?bds");
    // The list has narrowed: the > snippet is a different mark.
    expect(labels.join(" ")).not.toContain(">ext");
  });

  test("and accepting one replaces the mark rather than inserting beside it", async ({ page }) => {
    // Without an explicit range the snippet lands after the `?`, leaving
    // `?with BuildPart() as p:` in the file.
    await openWithSnippets(page);
    await caretToEnd(page);
    await page.keyboard.press("Enter");

    await page.keyboard.type("?bdp");
    await expect(page.locator(".suggest-widget .monaco-list-row").first()).toBeVisible();
    await page.keyboard.press("Enter");

    await expect.poll(() => editorText(page)).toContain("with BuildPart() as p:");
    expect(await editorText(page)).not.toContain("?with");
  });

  test("and its tab stops are live", async ({ page }) => {
    await openWithSnippets(page);
    await caretToEnd(page);
    await page.keyboard.press("Enter");

    await page.keyboard.type("?bdp");
    await expect(page.locator(".suggest-widget .monaco-list-row").first()).toBeVisible();
    await page.keyboard.press("Enter");
    // $1 sits after "as p", so typing names the part.
    await page.keyboard.type("art");

    await expect.poll(() => editorText(page)).toContain("with BuildPart() as part:");
  });

  test("a .code-snippets file works unedited, comments and all", async ({ page }) => {
    // The reason jsonc-parser is a dependency: the sets people copy are JSONC,
    // and requiring them to be stripped first makes "copy this in" a step with
    // an edit in it.
    await open(page, {
      files: {
        ...FILES,
        "/appdata/build123d-studio/snippets.json": `{
          // build123d speedmodelling snippets
          "BuildPart": {
            "prefix": "?bdp", // the shortcut
            "body": ["with BuildPart() as p$1:", "    $0",],
          },
        }`,
      },
      settings: { workspace: WORKSPACE },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");

    await caretToEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("?bdp");
    await expect(page.locator(".suggest-widget .monaco-list-row").first()).toBeVisible();
    await page.keyboard.press("Enter");

    await expect.poll(() => editorText(page)).toContain("with BuildPart() as p:");
  });

  test("a file that cannot be read costs the editor nothing", async ({ page }) => {
    // Comments parse - that is the whole point of the parser - so a genuinely
    // broken file is a truncated one. It must leave a working editor and a line
    // in the log, not a broken completion provider.
    await open(page, {
      files: {
        ...FILES,
        "/appdata/build123d-studio/snippets.json": '{ "A": ',
      },
      settings: { workspace: WORKSPACE },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");

    await caretToEnd(page);
    await page.keyboard.type("\nx = 1");

    await expect.poll(() => editorText(page)).toContain("x = 1");
  });
});

test.describe("the command palette", () => {
  test("F1 opens it, and this application's own actions are in it", async ({ page }) => {
    // The contribution trap once more, and this one had been sitting there
    // unnoticed: there was no palette at all, because the import was missing.
    // F1 is the chord the contribution binds for itself, so what this holds is
    // that the palette exists and that the actions registered through addAction
    // are reachable by name - which is the whole reason it is worth having.
    await openApp(page);
    await focusEditor(page);

    await page.keyboard.press("F1");

    await expect(page.locator(".quick-input-widget")).toBeVisible();
    await page.keyboard.type("Run Cell");
    await expect(page.locator(".quick-input-list")).toContainText("Run Cell");
  });

  test("and Monaco's own actions are in it too, not only ours", async ({ page }) => {
    // What the palette was first opened on: it listed our twelve actions and
    // essentially nothing else, because an action belongs to a contribution and
    // this editor had imported six of them. The palette was right and the
    // editor was empty - there was no Find to list.
    await openApp(page);
    await focusEditor(page);

    await page.keyboard.press("F1");
    await expect(page.locator(".quick-input-widget")).toBeVisible();
    await page.keyboard.type("comment");

    await expect(page.locator(".quick-input-list")).toContainText("Toggle Line Comment");
  });
});

test.describe("the editing contributions", () => {
  test("Cmd-F opens the find widget", async ({ page }) => {
    await openApp(page);
    await focusEditor(page);

    await page.keyboard.press("Meta+f");

    await expect(page.locator(".editor-widget.find-widget")).toBeVisible();
  });

  test("Cmd-/ comments the line, and again takes it back", async ({ page }) => {
    await openApp(page);
    await focusEditor(page);
    // The last line of the file is the empty one after the trailing newline,
    // so Cmd-Down alone comments nothing anybody can see.
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.press("ArrowUp");

    await page.keyboard.press("Meta+/");
    await expect.poll(() => editorText(page)).toContain("# b = Box(1, 2, 3)");

    await page.keyboard.press("Meta+/");
    await expect.poll(() => editorText(page)).not.toContain("# b = Box(1, 2, 3)");
  });

  test("a block gets a fold control, in the space the gutter already reserved", async ({ page }) => {
    // Folding is why the margin has a sixteen pixel column at all. Until this
    // was imported the column was laid out on every line and nothing could ever
    // draw in it.
    await openApp(page);
    await focusEditor(page);
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type("\nfor i in range(3):\n    print(i)");

    // The controls are drawn on hover, which is Monaco's default and VS Code's,
    // so the margin has to be under the pointer before there is anything to
    // find. The class is the codicon's - `.folding` alone matches nothing.
    const margin = page.locator(".monaco-editor .margin-view-overlays");
    await margin.hover();

    await expect(margin.locator(".codicon-folding-expanded").first()).toBeVisible();
  });
});

test.describe("a buffer too large for the journal", () => {
  /**
   * The gap that opened when saving stopped replacing the file.
   *
   * A save now writes into the file, which empties it before the new content
   * lands - so for that moment the only whole copy of the work is the buffer
   * and whatever the journal holds. Past MAX_RECORDED_CHARS the journal holds
   * nothing, deliberately: copying megabytes on every pause in typing is what
   * that limit exists to prevent.
   *
   * So one copy is made before the write, and dropped when the save succeeds.
   * Asserted by order rather than by existence, because by the time the save
   * has finished the copy is correctly gone.
   */
  const HUGE = `${PROJECT}/generated.py`;
  const HUGE_SOURCE = "x = 1\n".repeat(400000);

  const writes = (page) => page.evaluate(() =>
    globalThis.__NEUTRALINO_STUB__.calls()
      .map((call, index) => ({ index, name: call.name, path: call.args?.[0] }))
      .filter((call) => call.name === "writeFile" && typeof call.path === "string"));

  const isRecovery = (path) => path.includes("/recovery/") && path.endsWith(".py");

  test("is copied once before the write, and not while it is typed in", async ({ page }) => {
    test.slow();
    await open(page, {
      files: { ...FILES, [HUGE]: HUGE_SOURCE },
      settings: { workspace: { folder: PROJECT, tabs: [{ path: HUGE, caret: null }], active: HUGE } },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("generated.py");

    await focusEditor(page);
    await page.keyboard.type("y = 2");
    // Longer than the journal's own beat, so a copy it was going to make has
    // been made. There must not be one: that is what the size limit is for.
    await page.waitForTimeout(1200);
    expect(
      (await writes(page)).filter((call) => isRecovery(call.path)),
      "a buffer past the limit was journalled while it was typed in",
    ).toHaveLength(0);

    await page.keyboard.press("Meta+s");
    await expect.poll(async () => (await writes(page)).some((c) => c.path === HUGE)).toBe(true);

    const all = await writes(page);
    const copy = all.find((call) => isRecovery(call.path));
    const file = all.find((call) => call.path === HUGE);
    expect(copy, "no recovery copy was made before the file was emptied").toBeDefined();
    expect(copy.index, "the copy was made after the write it exists to survive")
      .toBeLessThan(file.index);
  });
});

test.describe("a file changed by something else, noticed without saving", () => {
  /**
   * Until now an outside edit was found only when the user tried to save, so a
   * file rewritten by a formatter, a git checkout or a second window sat stale
   * in the tab and was read as current - which is worse than being asked,
   * because nothing looks wrong.
   *
   * Checked when the window is focused and when a tab is chosen: the moment
   * somebody is about to read it. The buffer on screen only - a dialog per open
   * tab would be a queue nobody asked for, and a background tab is checked when
   * it is selected.
   */
  const onDisk = (page, path) =>
    page.evaluate((p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""), path);

  async function changedElsewhere(page) {
    const handles = await openApp(page);
    await page.evaluate(
      (p) => globalThis.__NEUTRALINO_STUB__.given(p, "THEIRS = 1\n"),
      `${PROJECT}/part.py`,
    );
    return handles;
  }

  const focusWindow = (page) =>
    page.evaluate(() => globalThis.__NEUTRALINO_STUB__.emit("windowFocus", {}));

  test("focusing the window asks about it, without a save being attempted", async ({ page }) => {
    await changedElsewhere(page);

    await focusWindow(page);

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    expect(await page.locator(".confirm-overlay").innerText()).toContain("changed on disk");
  });

  test("Reload brings the other program's text into the buffer", async ({ page }) => {
    await changedElsewhere(page);
    await focusWindow(page);
    await expect(page.locator(".confirm-overlay")).toBeVisible();

    await page.locator('.confirm-overlay [data-answer="discard"]').click();

    await expect.poll(() => editorText(page)).toContain("THEIRS = 1");
    await expect(
      page.locator(".tab-active .tab-close.tab-dirty"),
      "a reloaded buffer agrees with its file",
    ).toHaveCount(0);
  });

  test("Cancel keeps the buffer and marks the tab modified", async ({ page }) => {
    // The whole point of the third answer: "I will deal with it later" has to
    // survive being closed, and a clean tab is closed without a word.
    await changedElsewhere(page);
    await focusWindow(page);
    await expect(page.locator(".confirm-overlay")).toBeVisible();

    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    await expect(page.locator(".tab-active .tab-close.tab-dirty")).toHaveCount(1);
    expect(await editorText(page), "the buffer was reloaded behind the answer")
      .not.toContain("THEIRS = 1");
  });

  test("and having answered, it does not ask again about the same change", async ({ page }) => {
    await changedElsewhere(page);
    await focusWindow(page);
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="cancel"]').click();
    // Hidden rather than removed: the overlay is one element reused for every
    // question, so "no dialog" is invisibility and never absence.
    await expect(page.locator(".confirm-overlay")).toBeHidden();

    await focusWindow(page);

    await expect(page.locator(".confirm-overlay")).toBeHidden();
  });

  test("Overwrite puts the buffer on disk", async ({ page }) => {
    await changedElsewhere(page);
    await focusWindow(page);
    await expect(page.locator(".confirm-overlay")).toBeVisible();

    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).not.toContain("THEIRS");
  });
});

test.describe("a file that changed on disk", () => {
  /**
   * D5. Nothing compared anything: openPath deliberately never re-reads a file
   * already in a tab, and the only external change ever noticed was deletion,
   * on a manual refresh. So editing a file in another program - or in a second
   * window of this one, which is a supported workflow - and then saving here
   * replaced those edits without a word.
   *
   * The other program is the stub writing the file directly, which is exactly
   * what a formatter, a git checkout or a second window does.
   *
   * Un-applied by removing the changedSince check from saveBuffer: no dialog
   * appears and the first assertion below finds the outside edit gone.
   */
  const onDisk = (page, path) =>
    page.evaluate((p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""), path);

  async function editedElsewhere(page) {
    await openApp(page);
    // Somebody else writes it while it sits in the tab.
    await page.evaluate(
      (p) => globalThis.__NEUTRALINO_STUB__.given(p, "THEIRS = 1\n"),
      `${PROJECT}/part.py`,
    );
    await caretToEnd(page);
    await page.keyboard.type("MINE");
    await page.keyboard.press("Meta+s");
    await expect(page.locator(".confirm-overlay")).toBeVisible();
  }

  test("it asks rather than replacing what somebody else wrote", async ({ page }) => {
    await editedElsewhere(page);

    const text = await page.locator(".confirm-overlay").innerText();
    expect(text).toContain("changed on disk");
    expect(await onDisk(page, `${PROJECT}/part.py`), "it was written before asking")
      .toBe("THEIRS = 1\n");
  });

  test("Cancel leaves both the file and the buffer alone", async ({ page }) => {
    await editedElsewhere(page);
    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    expect(await onDisk(page, `${PROJECT}/part.py`)).toBe("THEIRS = 1\n");
    await expect(
      page.locator(".tab-active .tab-close.tab-dirty"),
      "the buffer must still know it has unsaved work",
    ).toHaveCount(1);
  });

  test("Overwrite is allowed, because it was asked for", async ({ page }) => {
    await editedElsewhere(page);
    await page.locator('.confirm-overlay [data-answer="save"]').click();

    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toContain("MINE");
    await expect(page.locator(".tab-active .tab-close.tab-dirty")).toHaveCount(0);
  });

  test("Reload takes their version and does not write ours", async ({ page }) => {
    await editedElsewhere(page);
    await page.locator('.confirm-overlay [data-answer="discard"]').click();

    await expect.poll(() => editorText(page)).toContain("THEIRS = 1");
    expect(await onDisk(page, `${PROJECT}/part.py`)).toBe("THEIRS = 1\n");
    await expect(
      page.locator(".tab-active .tab-close.tab-dirty"),
      "a reloaded buffer matches disk",
    ).toHaveCount(0);
  });

  test("Reload can be undone, because it is an edit and not a replacement", async ({ page }) => {
    // Reload is offered exactly when somebody has unsaved work to lose, so a
    // misread click must not be final. setValue replaces the text and throws
    // away the undo stack; an edit keeps it.
    await editedElsewhere(page);
    await page.locator('.confirm-overlay [data-answer="discard"]').click();
    await expect.poll(() => editorText(page)).toContain("THEIRS = 1");

    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Meta+z");

    await expect
      .poll(() => editorText(page), { message: "the reload could not be undone" })
      .toContain("MINE");
  });

  test("and an untouched file is never asked about", async ({ page }) => {
    // The false positive matters as much: a dialog on every save is one people
    // learn to click through without reading.
    await openApp(page);

    await caretToEnd(page);
    await page.keyboard.type("MINE");
    await page.keyboard.press("Meta+s");

    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toContain("MINE");
    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
  });

  test("and neither is a second save straight after the first", async ({ page }) => {
    // The stamp has to be re-read after a save, or the file we just wrote looks
    // like somebody else's work the next time round.
    await openApp(page);

    await caretToEnd(page);
    await page.keyboard.type("ONE");
    await page.keyboard.press("Meta+s");
    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toContain("ONE");

    await page.keyboard.type("TWO");
    await page.keyboard.press("Meta+s");

    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toContain("TWO");
    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
  });
});

test.describe("Save As does not land on a file nobody asked about", () => {
  /**
   * D7. The native dialog vets the name the user typed, and .py is appended
   * after it has closed - so typing "bracket" where bracket.py already exists
   * got no overwrite prompt from anybody. The dialog had approved a name that
   * does not exist; the write went to one that does.
   */
  const EXISTING = `${PROJECT}/bracket.py`;

  async function openWithBracket(page) {
    const handles = await open(page, {
      files: { ...FILES, [EXISTING]: "BRACKET = 1\n" },
      settings: { workspace: WORKSPACE },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
    return handles;
  }

  const onDisk = (page, path) =>
    page.evaluate((p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""), path);

  async function saveAsTyping(page, typed) {
    await caretToEnd(page);
    await page.keyboard.type("MINE");
    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      typed,
    );
    // Save As has no chord; it is a menu item, and Neutralino delivers a click
    // as a mainMenuItemClicked event carrying the id.
    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.saveAs" }),
    );
  }

  test("the name is taken as typed, with nothing appended to it", async ({ page }) => {
    // The panel asks before replacing a file and can only ask about the name it
    // was given, so a save must land on exactly that name. Appending `.py`
    // behind it would write to a file the panel never mentioned - and would
    // need a second prompt of our own to cover the gap.
    await openWithBracket(page);

    await saveAsTyping(page, `${PROJECT}/bracket`);

    await expect
      .poll(() => onDisk(page, `${PROJECT}/bracket`), { message: "it did not save as typed" })
      .toContain("MINE");
    expect(await onDisk(page, EXISTING), "the .py file was written instead")
      .toBe("BRACKET = 1\n");
    await expect(page.locator(".confirm-overlay")).toHaveCount(0);
    await expect(page.locator(".tab-active .tab-label")).toHaveText("bracket");
  });

  test("saving onto another file is not reported as that file changing", async ({ page }) => {
    // The stamp a buffer carries describes the file it came from, and a Save As
    // has just chosen a different one - so comparing them asked "does
    // bracket.py look like part.py did?", which it does not, and every Save As
    // over an existing file ended in "It changed on disk" about a file nothing
    // had touched.
    //
    // Not merely noise. That prompt offers Reload, so the way out of a save was
    // an offer to replace the buffer with the contents of the file the user had
    // just chosen to overwrite.
    await openWithBracket(page);

    // With the extension, so the application's own replace prompt is not the
    // thing being seen: this is the platform dialog's Replace, and afterwards
    // there should be no second question at all.
    await saveAsTyping(page, EXISTING);

    await expect
      .poll(() => onDisk(page, EXISTING), { message: "the save never happened" })
      .toContain("MINE");
    await expect(page.locator(".confirm-overlay")).toBeHidden();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("bracket.py");
  });

  test("the panel is asked for the file's name, not its whole path", async ({ page }) => {
    // Neutralino's own dialog has one string for both, and its macOS half reads
    // anything that is not a directory as the *name* - so the panel opened with
    // "/documents/bracket/part.py" typed into the Save As field. The script the
    // application runs instead says the two separately.
    await openWithBracket(page);
    await saveAsTyping(page, `${PROJECT}/other.py`);

    const asked = await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__
        .calls()
        .filter((call) => call.name === "execCommand")
        .map((call) => call.args[0])
        .join("\n"),
    );
    expect(asked, "the panel was never run").toContain("choose file name");
    expect(asked).toContain(`default name "part.py"`);
    expect(asked).toContain(`set theFolder to POSIX file "${PROJECT}" as alias`);
    expect(asked).toContain("default location theFolder");
    expect(asked, "the whole path went into the name field")
      .not.toContain(`default name "${PROJECT}/part.py"`);
  });

  test("a path another tab holds is refused rather than taken from it", async ({ page }) => {
    // Two buffers on one path have no correct behaviour left between them:
    // both dirty against the same bytes, and whichever saves last wins.
    await open(page, {
      files: { ...FILES, [EXISTING]: "BRACKET = 1\n" },
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [{ path: `${PROJECT}/part.py`, caret: null }, { path: EXISTING, caret: null }],
          active: `${PROJECT}/part.py`,
        },
      },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");

    await saveAsTyping(page, EXISTING);

    // A refusal is a native message box rather than the in-page overlay: the
    // overlay is for questions, this is a statement.
    await expect
      .poll(() =>
        page.evaluate(() =>
          globalThis.__NEUTRALINO_STUB__
            .calls()
            .filter((call) => call.name === "showMessageBox")
            .map((call) => call.args.join(" "))
            .join("\n"),
        ),
      )
      .toContain("another tab");
    expect(await onDisk(page, EXISTING), "the other tab's file was written")
      .toBe("BRACKET = 1\n");
  });
});

test.describe("a save carries its own buffer", () => {
  /**
   * D1: the window is live while a save is in flight.
   *
   * saveFile has two awaits in it - the format, which takes as long as the
   * sidecar takes, and the write - and it used to read the buffer *after* them
   * by asking what was on screen. A click on another tab in between therefore
   * changed which buffer it meant, having already decided which path it was
   * writing to.
   *
   * Reproduced here by holding the format request open, which is what the real
   * one does while ruff runs - against a thirty second timeout. Nothing here is
   * timing-dependent: the request is answered when the test says so.
   *
   * Un-applied by reading getValue() and calling markSaved()/setCurrentFile()
   * without a key, as before: the first assertion finds other.py's text inside
   * part.py, and the second finds two tabs called part.py.
   */
  const OTHER = `${PROJECT}/other.py`;
  const OTHER_SOURCE = "OTHER_FILE = 1\n";

  async function openTwo(page) {
    const handles = await open(page, {
      files: { ...FILES, [OTHER]: OTHER_SOURCE },
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [{ path: `${PROJECT}/part.py`, caret: null }, { path: OTHER, caret: null }],
          active: `${PROJECT}/part.py`,
        },
      },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
    return handles;
  }

  function onDisk(page, path) {
    return page.evaluate(
      (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
      path,
    );
  }

  async function saveAndSwitchAway(page, sidecar) {
    // Held, so the save is still in flight when the tab changes.
    sidecar.answer("editor.format", () => undefined);

    await caretToEnd(page);
    await page.keyboard.type("MINE");
    await page.keyboard.press("Meta+s");
    await expect
      .poll(() => sidecar.held.filter((frame) => frame.type === "editor.format").length)
      .toBe(1);

    await page.locator(".tab", { hasText: "other.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("other.py");

    // ruff declining to change the buffer, which is the ordinary answer for a
    // file somebody is part-way through typing.
    sidecar.release("editor.format", { source: null });
  }

  test("the file that was saved gets its own text, not the tab switched to", async ({ page }) => {
    const { sidecar } = await openTwo(page);

    await saveAndSwitchAway(page, sidecar);

    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toContain("MINE");
    expect(
      await onDisk(page, `${PROJECT}/part.py`),
      "the other tab's text was written into this file",
    ).not.toContain("OTHER_FILE");
  });

  test("the tab switched to is not renamed to the file that was saved", async ({ page }) => {
    const { sidecar } = await openTwo(page);

    await saveAndSwitchAway(page, sidecar);
    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toContain("MINE");

    const labels = await page.locator(".tab .tab-label").allTextContents();
    expect(labels.filter((label) => label === "part.py"), "two tabs claim one file")
      .toHaveLength(1);
    expect(labels).toContain("other.py");
  });

  /**
   * Typing while ruff is answering, which is M11's territory.
   *
   * The formatted text replaces the whole document, so applying it after
   * somebody has typed overwrites the one thing in the buffer with no other
   * copy. The formatting can be had again by saving once more; the keystrokes
   * cannot.
   *
   * Held and released so the typing lands *during* the request, which is the
   * whole of the race and cannot be reached by timing alone.
   */
  test("typing while ruff answers keeps the typing, not the formatting", async ({ page }) => {
    const { sidecar } = await openTwo(page);
    sidecar.answer("editor.format", () => undefined);

    await caretToEnd(page);
    await page.keyboard.type("FIRST");
    await page.keyboard.press("Meta+s");
    await expect
      .poll(() => sidecar.held.filter((frame) => frame.type === "editor.format").length)
      .toBe(1);

    // Lands while the request is open, so ruff's answer is already stale.
    await page.keyboard.type("_TYPED_LATER");
    sidecar.release("editor.format", { source: "REFORMATTED = 1\n" });

    await expect
      .poll(() => onDisk(page, `${PROJECT}/part.py`), {
        message: "the formatted text overwrote what was typed during the save",
      })
      .toContain("_TYPED_LATER");
  });

  /**
   * M10 at the size it actually fails at.
   *
   * The small-buffer version of this test passes, and on a real machine the
   * small case cannot even be reached - the format returns before a hand can
   * reach another tab. Reported failing on all three platforms with a million
   * line file: the log says `Format: formatted`, the save completes, and the
   * file on disk still holds the unformatted text.
   *
   * The size is the whole point, so it is written large rather than held: what
   * is being reproduced is a format whose result is thrown away, and every
   * cheaper way of writing it has already passed against the broken code.
   */
  // Under the 50 000 line limit on purpose: this test is about a tab changing
  // mid-save, and a buffer past the limit is not formatted at all.
  const LINES = 40000;
  const BIG_SOURCE = "x=1\n".repeat(LINES);
  const BIG_FORMATTED = "x = 1\n".repeat(LINES);

  test("a large buffer keeps its formatting when the tab changes during the save", async ({ page }) => {
    test.slow();
    const BIG = `${PROJECT}/big.py`;
    const { sidecar } = await open(page, {
      files: { ...FILES, [BIG]: BIG_SOURCE, [OTHER]: OTHER_SOURCE },
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [{ path: BIG, caret: null }, { path: OTHER, caret: null }],
          active: BIG,
        },
      },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("big.py");

    sidecar.answer("editor.format", () => undefined);
    await page.keyboard.press("Meta+s");
    await expect
      .poll(() => sidecar.held.filter((frame) => frame.type === "editor.format").length)
      .toBe(1);

    await page.locator(".tab", { hasText: "other.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("other.py");

    sidecar.release("editor.format", { source: BIG_FORMATTED });

    await expect
      .poll(
        async () => (await onDisk(page, BIG)).slice(0, 6),
        { message: "the large file was written with the layout it already had" },
      )
      .toBe("x = 1\n");
  });

  /**
   * M10: save, then switch tabs before ruff answers.
   *
   * The three tests above hold the format open and switch away, but every one
   * of them releases it with `source: null` - ruff declining - so none of them
   * ever asks whether the *formatting* survives the switch. It did not. The file
   * was written, correctly and with its own text, and simply was not formatted:
   * saved with the layout it already had, on all three platforms.
   *
   * Released with real formatted text here, which is the only difference from
   * saveAndSwitchAway, and the only thing that makes the gap visible.
   */
  test("the formatting survives switching tabs while ruff is still answering", async ({ page }) => {
    const { sidecar } = await openTwo(page);
    sidecar.answer("editor.format", () => undefined);

    await caretToEnd(page);
    await page.keyboard.type("MINE");
    await page.keyboard.press("Meta+s");
    await expect
      .poll(() => sidecar.held.filter((frame) => frame.type === "editor.format").length)
      .toBe(1);

    await page.locator(".tab", { hasText: "other.py" }).click();
    await expect(page.locator(".tab-active .tab-label")).toHaveText("other.py");

    sidecar.release("editor.format", { source: "FORMATTED_BY_RUFF = 1\n" });

    await expect
      .poll(() => onDisk(page, `${PROJECT}/part.py`), {
        message: "the file was saved with the layout it already had",
      })
      .toContain("FORMATTED_BY_RUFF");
  });

  /**
   * The line above which format on save stands aside.
   *
   * A buffer this size is generated, and the journal already refuses to keep a
   * recovery copy of one - so its edits exist nowhere but in memory, and
   * holding the save open while a formatter works is the one moment that
   * cannot be afforded. It is written immediately instead.
   *
   * Asserted by what is *not* sent: the whole point is that nothing crosses the
   * socket, not merely that the answer is ignored.
   */
  test("a buffer past the line limit is written without asking ruff at all", async ({ page }) => {
    test.slow();
    const HUGE = `${PROJECT}/generated.py`;
    const { sidecar } = await open(page, {
      files: { ...FILES, [HUGE]: "x=1\n".repeat(60000) },
      settings: {
        workspace: {
          folder: PROJECT,
          tabs: [{ path: HUGE, caret: null }],
          active: HUGE,
        },
      },
    });
    await expect(page.locator(".tab-active .tab-label")).toHaveText("generated.py");

    await caretToEnd(page);
    await page.keyboard.type("y=2");
    await page.keyboard.press("Meta+s");

    await expect.poll(() => onDisk(page, HUGE)).toContain("y=2");
    expect(
      sidecar.received.filter((frame) => frame.type === "editor.format"),
      "a buffer past the limit was sent to ruff anyway",
    ).toHaveLength(0);
    expect(await onDisk(page, HUGE), "it was formatted despite being past the limit")
      .toContain("x=1\n");
  });

  test("and the buffer that was written is the one marked clean", async ({ page }) => {
    const { sidecar } = await openTwo(page);

    await saveAndSwitchAway(page, sidecar);
    await expect.poll(() => onDisk(page, `${PROJECT}/part.py`)).toContain("MINE");

    await page.locator(".tab", { hasText: "part.py" }).click();
    await expect(
      page.locator(".tab-active .tab-close.tab-dirty"),
      "the saved buffer still claims unsaved work",
    ).toHaveCount(0);
  });
});

test.describe("formatting", () => {
  const TIDY = "b = Box(1, 2, 3)\n";

  test("Shift-Alt-F replaces the buffer with what ruff sent back", async ({ page }) => {
    const { sidecar } = await openApp(page);
    sidecar.answer("editor.format", () => ({ source: `FORMATTED = 1\n${TIDY}` }));

    await focusEditor(page);
    await page.keyboard.press("Shift+Alt+f");

    await expect.poll(() => editorText(page)).toContain("FORMATTED = 1");
  });

  test("the line length from settings is what is asked for", async ({ page }) => {
    // The setting's only job is to reach ruff, and nothing on screen would
    // show that it had not - a buffer formatted at 88 when 60 was asked for
    // looks perfectly reasonable.
    const { sidecar } = await openApp(page, { formatLineLength: 60 });
    sidecar.answer("editor.format", () => ({ source: TIDY }));

    await focusEditor(page);
    await page.keyboard.press("Shift+Alt+f");

    await expect
      .poll(() => sidecar.received.find((frame) => frame.type === "editor.format")?.lineLength)
      .toBe(60);
  });

  // There was a case here asserting that a buffer ruff would not change is not
  // edited with itself, and it was deleted rather than kept. It could not be
  // made to fail: with formatEdits' guard removed it still passed, because
  // Monaco discards a no-op edit of its own accord - neither the undo stop nor
  // the dirty mark it was written to catch ever happens. The property is real
  // and worth keeping, so it is asserted in format.test.mjs where removing the
  // guard genuinely reddens it. A green test that never had the chance to be
  // red is worse than none, because it gets believed.

  test("Format on save formats before it writes, so disk and screen agree", async ({ page }) => {
    const { sidecar } = await openApp(page, { formatOnSave: true });
    sidecar.answer("editor.format", () => ({ source: "SAVED_FORMATTED = 1\n" }));

    await caretToEnd(page);
    await page.keyboard.type("x");
    await page.keyboard.press("Meta+s");

    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/part.py`,
        ),
      )
      .toContain("SAVED_FORMATTED = 1");
    await expect.poll(() => editorText(page)).toContain("SAVED_FORMATTED = 1");
  });

  test("a new file is formatted on its first save, not the second", async ({ page }) => {
    // The save that opens a chooser, and the bug it hid. Reported from a real
    // run: the file landed on disk exactly as typed, and pressing Cmd-S again
    // formatted it - so ruff had run, the sidecar's log said so, and the write
    // did not carry what it produced.
    //
    // The delay is the whole test. afterNativeDialog puts the caret back in the
    // editor *after* awaiting a native focus call, and Monaco's format action
    // cancels when the position moves while its provider is working. On a real
    // machine that focus takes milliseconds and the caret lands mid-format; in
    // this harness it used to resolve in the same microtask, so the caret moved
    // before the format began and nothing ever raced. Written without the delay
    // first, where it passed against the broken code.
    const { sidecar } = await openApp(page, { formatOnSave: true });
    sidecar.answer("editor.format", () => ({ source: "b = Box(1, 2, 3)\n" }));
    await page.evaluate(() => globalThis.__NEUTRALINO_STUB__.focusDelay(30));

    await page.locator("#btn-new").click();
    await focusEditor(page);
    await page.keyboard.type("b = Box(1,2,3)");

    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      `${PROJECT}/fresh.py`,
    );
    await page.keyboard.press("Meta+s");

    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/fresh.py`,
        ),
      )
      .toContain("Box(1, 2, 3)");
  });

  test("the caret moving while ruff answers does not lose the formatting", async ({ page }) => {
    // The property behind a reported bug: the first save of a new file wrote
    // the text unformatted, and a second Cmd-S formatted it. ruff had run - the
    // sidecar logged it - and the edits never reached the buffer.
    //
    // Monaco's format action carries a cancellation token tied to the editor's
    // position and value, and the save path went through that action. Anything
    // that moves the caret while the provider is working therefore throws the
    // formatting away silently, and a save has several candidates: the caret
    // being put back after the native chooser, or the windowFocus the operating
    // system sends when it activates the window again.
    //
    // Held and released so the move happens *during* the request, which is the
    // whole of the race and cannot be reached by timing alone.
    const { sidecar } = await openApp(page, { formatOnSave: true });
    sidecar.answer("editor.format", () => undefined);

    await caretToEnd(page);
    await page.keyboard.type("x = 1");
    await page.keyboard.press("Meta+s");
    await expect
      .poll(() => sidecar.held.filter((frame) => frame.type === "editor.format").length)
      .toBe(1);

    // What the focus restoration does: move the caret. An arrow key is the
    // smallest way to say it and needs nothing the harness does not have.
    await page.keyboard.press("ArrowLeft");

    sidecar.release("editor.format", { source: "FORMATTED_BY_RUFF = 1\n" });

    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/part.py`,
        ),
      )
      .toContain("FORMATTED_BY_RUFF = 1");
  });

  test("and with it off, saving asks ruff nothing", async ({ page }) => {
    const { sidecar } = await openApp(page, { formatOnSave: false });

    await caretToEnd(page);
    await page.keyboard.type("UNFORMATTED");
    await page.keyboard.press("Meta+s");

    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
    expect(sidecar.received.filter((frame) => frame.type === "editor.format")).toHaveLength(0);
  });
});

test.describe("only Python reaches the language server", () => {
  /**
   * A STEP export opened to be looked at.
   *
   * Every buffer used to be created as a Python model, so the sidecar was told
   * `languageId: "python"` about all of them. Measured on a real 10 320 line
   * export: basedpyright answers in half a second with **6779 diagnostics**,
   * because OpenCascade's exchange format is not valid Python. Cheap, and a
   * wall of red over a file nobody is editing.
   *
   * Asserted by what is not sent, because ignoring the answer is not the same
   * as not asking.
   */
  const STEP = `${PROJECT}/screw.step`;
  const STEP_SOURCE = "ISO-10303-21;\nHEADER;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n";

  async function openOne(page, path, text) {
    return open(page, {
      files: { ...FILES, [path]: text },
      settings: { workspace: { folder: PROJECT, tabs: [{ path, caret: null }], active: path } },
    });
  }

  function syncs(sidecar) {
    return sidecar.received.filter((frame) => frame.type === "editor.sync");
  }

  test("a STEP file is never sent for analysis", async ({ page }) => {
    const { sidecar } = await openOne(page, STEP, STEP_SOURCE);
    await expect(page.locator(".tab-active .tab-label")).toHaveText("screw.step");

    await focusEditor(page);
    await page.keyboard.type("#2=DIRECTION('',(0.,0.,1.));");
    // Longer than SYNC_DELAY, so a sync that was going to happen has happened.
    await page.waitForTimeout(900);

    expect(syncs(sidecar), "a STEP file was sent to the language server").toHaveLength(0);
  });

  test("and a Python file still is, so the check is not simply off", async ({ page }) => {
    const { sidecar } = await openOne(page, `${PROJECT}/part.py`, "x = 1\n");

    await focusEditor(page);
    await page.keyboard.type("y = 2");
    await expect.poll(() => syncs(sidecar).length).toBeGreaterThan(0);
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

test.describe("Alt-Enter while the find widget is open", () => {
  /**
   * Monaco registers Select All Matches on Alt-Enter under
   * `precondition: CONTEXT_FIND_WIDGET_VISIBLE`, and this application puts Run
   * All on the same chord. The collision was known and written down; who won it
   * was not. addAction registers at weight 1000 and findController's action at
   * 105, so Run All won always - including with the find box open and a search
   * typed into it, which is the one moment nobody wants to run a file.
   *
   * Asserted both ways round, because either half alone would pass against a
   * chord that simply stopped working: every match is selected, *and* nothing
   * was sent to the kernel.
   */
  const MANY = `${PROJECT}/part.py`;

  async function withMatches(page) {
    return open(page, {
      files: { ...FILES, [MANY]: "a = 1\nb = 1\nc = 1\n" },
      settings: {
        workspace: { folder: PROJECT, tabs: [{ path: MANY, caret: null }], active: MANY },
      },
    });
  }

  const ran = (sidecar) => sidecar.received.filter((frame) => frame.type === "kernel.execute");

  test("selects every match rather than running the file", async ({ page }) => {
    const { sidecar } = await withMatches(page);
    await focusEditor(page);

    await page.keyboard.press("Meta+f");
    await page.keyboard.type("1");
    await page.keyboard.press("Alt+Enter");
    // selectAllMatches focuses the editor itself, so this lands on every
    // selection at once - which is what makes the selection observable without
    // reaching into Monaco.
    await page.keyboard.type("9");

    // Every match, not just the one the caret was on. editorText reads the
    // rendered lines, which arrive without their newlines, so the three are
    // asserted by count rather than by shape.
    await expect.poll(async () => (await editorText(page)).match(/9/g)?.length ?? 0).toBe(3);
    expect(await editorText(page), "a match was left behind").not.toContain("1");
    expect(ran(sidecar), "the file was run instead of the matches being selected")
      .toHaveLength(0);
  });

  test("and still runs everything when the find widget is closed", async ({ page }) => {
    // Only the chord yields, and only while the widget is up. Losing Run All
    // altogether would pass the test above and be a worse bug than the one it
    // is about.
    const { sidecar } = await withMatches(page);
    await focusEditor(page);

    await page.keyboard.press("Alt+Enter");

    await expect.poll(() => ran(sidecar).length).toBeGreaterThan(0);
  });
});
