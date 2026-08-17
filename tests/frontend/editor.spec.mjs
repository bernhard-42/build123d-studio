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

  test("the extension it adds cannot overwrite silently", async ({ page }) => {
    await openWithBracket(page);

    // Without the .py, which is the whole case: the dialog approves it.
    await saveAsTyping(page, `${PROJECT}/bracket`);

    await expect(page.locator(".confirm-overlay")).toBeVisible();
    expect(await page.locator(".confirm-overlay").innerText()).toContain("bracket.py");
  });

  test("and cancelling it leaves the file alone", async ({ page }) => {
    await openWithBracket(page);

    await saveAsTyping(page, `${PROJECT}/bracket`);
    await expect(page.locator(".confirm-overlay")).toBeVisible();
    await page.locator('.confirm-overlay [data-answer="cancel"]').click();

    await expect
      .poll(() => onDisk(page, EXISTING), { message: "the file was replaced anyway" })
      .toBe("BRACKET = 1\n");
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
   * one does for as long as black takes: a quarter of a millisecond a line, so
   * seconds on a large file, against a thirty second timeout. Nothing here is
   * timing-dependent - the request is answered when the test says so.
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

    // black declining to change the buffer, which is the ordinary answer for a
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

  test("Shift-Alt-F replaces the buffer with what black sent back", async ({ page }) => {
    const { sidecar } = await openApp(page);
    sidecar.answer("editor.format", () => ({ source: `FORMATTED = 1\n${TIDY}` }));

    await focusEditor(page);
    await page.keyboard.press("Shift+Alt+f");

    await expect.poll(() => editorText(page)).toContain("FORMATTED = 1");
  });

  test("the line length from settings is what is asked for", async ({ page }) => {
    // The setting's only job is to reach black, and nothing on screen would
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

  // There was a case here asserting that a buffer black would not change is not
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

  test("and with it off, saving asks black nothing", async ({ page }) => {
    const { sidecar } = await openApp(page, { formatOnSave: false });

    await caretToEnd(page);
    await page.keyboard.type("UNFORMATTED");
    await page.keyboard.press("Meta+s");

    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
    expect(sidecar.received.filter((frame) => frame.type === "editor.format")).toHaveLength(0);
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
