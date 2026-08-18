// The in-window title bar, which exists on two platforms and must not on the third.
//
// macOS keeps its system frame, its system menu and its native clipboard roles;
// Windows and Linux give the frame up and get a bar of our own. The keyboard
// half - Alt shows the underlines, Alt-F opens File, the arrows walk it - is
// arithmetic and is tested in tests/unit/titlebar; what needs a window is that
// the bar is drawn, that a pick runs the same handler the native menu would, and
// that macOS is left alone.
//
// The window keeps its system frame on every platform: rounding, the shadow,
// dragging, resizing and the window buttons are the window manager's, which is
// what a frameless window gave up and could not give back - Neutralino exposes
// no way to draw a real shadow, and rounding needs a transparent window that
// would apply to macOS as well.

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

const openOn = (page, platform) =>
  open(page, { platform, files: FILES, settings: { workspace: WORKSPACE } });

const calls = (page, name) =>
  page.evaluate(
    (wanted) => globalThis.__NEUTRALINO_STUB__.calls().filter((call) => call.name === wanted),
    name,
  );

test.describe("on Windows", () => {
  test("the window keeps its frame, and the bar carries only the menus", async ({ page }) => {
    // The frame is the system's, so its buttons, its title, its rounding and
    // its shadow are too - and none of them is drawn here.
    await openOn(page, "Windows");

    await expect(page.locator("#titlebar")).toBeVisible();
    expect(await calls(page, "setBorderless")).toHaveLength(0);
    expect(await calls(page, "setDraggableRegion")).toHaveLength(0);
    await expect(page.locator("#titlebar-minimise")).toHaveCount(0);
    await expect(page.locator("#titlebar-title")).toHaveCount(0);
  });

  test("the menus are the ones the native menu would have had", async ({ page }) => {
    // Built from the same structure as the native menu, so an item added in
    // menu.js appears in both without being written twice.
    await openOn(page, "Windows");

    const titles = await page.locator(".titlebar-menu").allTextContents();
    expect(titles).toContain("File");
    expect(titles).toContain("Edit");
    expect(titles).toContain("Help");
    // And the native menu is not also installed, or there would be two.
    expect(await calls(page, "setMainMenu")).toHaveLength(0);
  });

  test("clicking a menu opens it, and clicking an item runs it", async ({ page }) => {
    await openOn(page, "Windows");

    await page.locator(".titlebar-menu", { hasText: "File" }).click();
    const dropdown = page.locator("#titlebar-dropdown");
    await expect(dropdown).toBeVisible();
    expect(await dropdown.innerText()).toContain("New");

    await dropdown.locator(".context-menu-item").first().click();

    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(dropdown).toBeHidden();
  });

  test("Alt-F opens File from anywhere, and Escape closes it", async ({ page }) => {
    // The gesture Windows has had since 3.0, and the reason the bar handles the
    // keyboard at all.
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.keyboard.press("Alt+f");

    const dropdown = page.locator("#titlebar-dropdown");
    await expect(dropdown).toBeVisible();
    expect(await dropdown.innerText()).toContain("Open Folder");

    await page.keyboard.press("Escape");
    await expect(dropdown).toBeHidden();
  });

  test("Alt on its own underlines the letters", async ({ page }) => {
    await openOn(page, "Windows");

    await expect(page.locator(".titlebar-mnemonic")).toHaveCount(0);

    await page.keyboard.press("Alt");

    await expect(page.locator(".titlebar-mnemonic").first()).toBeVisible();
    expect(await page.locator(".titlebar-menu").first().innerText()).toContain("File");
  });

  test("Alt then F is the same as Alt-F, as two keystrokes", async ({ page }) => {
    // Alt alone puts the bar in listening mode and shows the underlines; the
    // letter they invite then opens its menu.
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.keyboard.press("Alt");
    await expect(page.locator(".titlebar-mnemonic").first()).toBeVisible();

    await page.keyboard.press("f");

    await expect(page.locator("#titlebar-dropdown")).toBeVisible();
  });

  test("the items carry their own letters, underlined", async ({ page }) => {
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.keyboard.press("Alt+f");

    const marks = page.locator("#titlebar-dropdown .titlebar-mnemonic");
    await expect(marks.first()).toBeVisible();
    // New takes N, Open File takes O, and Open Folder takes the F of Folder -
    // Windows' rule, which prefers a word's initial to the next free letter.
    const items = await page.locator("#titlebar-dropdown .context-menu-item").allTextContents();
    expect(items[0]).toContain("New");
    expect(await marks.nth(0).innerText()).toBe("N");
    expect(await marks.nth(1).innerText()).toBe("O");
    expect(await marks.nth(2).innerText()).toBe("F");
  });

  test("and an item's letter runs it", async ({ page }) => {
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.keyboard.press("Alt+f");
    await page.keyboard.press("n");

    // N is New, so a second tab appears and the menu closes behind it.
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(page.locator("#titlebar-dropdown")).toBeHidden();
  });

  test("the bar still answers after an item has been run", async ({ page }) => {
    // Alt-F, F, Escape: the F runs Open Folder, whose chooser is cancelled.
    // Afterwards Alt must still underline and Alt-F must still open.
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.keyboard.press("Alt+f");
    await page.keyboard.press("f");
    await expect(page.locator("#titlebar-dropdown")).toBeHidden();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Alt+f");

    await expect(page.locator("#titlebar-dropdown")).toBeVisible();
  });

  test("something is always focused, even with no file open", async ({ page }) => {
    // Opening a folder closes every tab, and an editor with no model cannot
    // take focus - so without somewhere for the keyboard to go, the window has
    // nothing focused at all and hands its keys to the host. On Windows that is
    // a beep for every Alt, and the menu bar appears to have stopped working.
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      "/documents/empty",
    );
    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.openFolder" }),
    );

    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? ""))
      .not.toBe("");
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? ""))
      .not.toBe("BODY");
  });

  test("opening a folder bounces the window's activation", async ({ page }) => {
    // The folder chooser is SHBrowseForFolderW, which is modal on our own
    // thread: the window stays the active one throughout, so no WM_ACTIVATE is
    // sent, so Neutralino never calls MoveFocus and the keyboard is left with
    // the frame rather than the WebView. Another window taking the foreground
    // and exiting is that activation, performed rather than waited for.
    await openOn(page, "Windows");

    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      "/documents/empty",
    );
    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.openFolder" }),
    );

    await expect.poll(() => calls(page, "create").then((made) => made.length)).toBe(1);
    const [url, options] = (await calls(page, "create"))[0].args;
    expect(url).toBe("/reactivate.html");
    // A window that is never shown is never made the foreground window, and
    // then there is no activation to give back. The configured window mode says
    // hidden, so this has to say otherwise.
    expect(options.hidden).toBe(false);
  });

  test("the bar and the shell together are exactly the window", async ({ page }) => {
    // The bar sits above the shell, so a shell that is a whole viewport tall
    // makes the document thirty pixels too long. `overflow: hidden` hides that
    // rather than preventing it - and anything that scrolls, such as focusing
    // an element, then pushes the bar off the top and the menu looks deleted.
    await openOn(page, "Windows");

    const measured = await page.evaluate(() => ({
      bar: document.getElementById("titlebar").getBoundingClientRect().height,
      shell: document.getElementById("shell").getBoundingClientRect().height,
      window: globalThis.innerHeight,
      scrollable: document.documentElement.scrollHeight > globalThis.innerHeight,
    }));

    expect(measured.scrollable, "the document is taller than the window").toBe(false);
    expect(Math.round(measured.bar + measured.shell)).toBe(measured.window);
  });

  test("and the menus survive opening a folder", async ({ page }) => {
    await openOn(page, "Windows");
    const before = await page.locator(".titlebar-menu").allTextContents();
    expect(before.length).toBeGreaterThan(3);

    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      "/documents/empty",
    );
    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.openFolder" }),
    );

    await expect.poll(() => page.locator(".titlebar-menu").allTextContents())
      .toEqual(before);
  });

  test("opening with the mouse shows no underlines", async ({ page }) => {
    // They are the keyboard's invitation; somebody already pointing at the menu
    // does not need them.
    await openOn(page, "Windows");

    await page.locator(".titlebar-menu", { hasText: "File" }).click();

    await expect(page.locator("#titlebar-dropdown")).toBeVisible();
    await expect(page.locator(".titlebar-mnemonic")).toHaveCount(0);
  });

  test("the arrows walk the bar and Enter chooses", async ({ page }) => {
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.keyboard.press("Alt+f");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // The first item of File is New, so a second tab appears.
    await expect(page.locator(".tab")).toHaveCount(2);
  });

  test("and typing is not eaten by the bar", async ({ page }) => {
    // A bar that consumed keys it had no use for would be a bar that broke the
    // editor. Nothing is open, so every one of these belongs to Monaco.
    await openOn(page, "Windows");
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Meta+ArrowDown");
    await page.keyboard.press("End");

    await page.keyboard.type("TYPED");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");

    const text = await page.locator(".monaco-editor .view-lines").first().innerText();
    expect(text).toContain("TYPED");
  });

});

test.describe("on Linux", () => {
  test("it is the same bar", async ({ page }) => {
    await openOn(page, "Linux");

    await expect(page.locator("#titlebar")).toBeVisible();
    expect(await calls(page, "setBorderless")).toHaveLength(0);
    expect(await calls(page, "setMainMenu")).toHaveLength(0);
  });
});

test.describe("on macOS", () => {
  test("nothing changes: the system frame, the system menu, no bar", async ({ page }) => {
    // The menu belongs to the system there, the window buttons are the
    // system's, and the clipboard items only work as native roles.
    await openOn(page, "Darwin");

    await expect(page.locator("#titlebar")).toBeHidden();
    expect(await calls(page, "setBorderless")).toHaveLength(0);
    expect(await calls(page, "setDraggableRegion")).toHaveLength(0);
    expect(await calls(page, "setMainMenu")).not.toHaveLength(0);
  });

  test("and a folder is opened without bouncing anything", async ({ page }) => {
    // The activation bounce is a Windows repair. macOS restores the focus to
    // the web view itself, and a window flashing open here would be a bug.
    await openOn(page, "Darwin");

    await page.evaluate(
      (target) => globalThis.__NEUTRALINO_STUB__.answerDialogWith(target),
      "/documents/empty",
    );
    await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "file.openFolder" }),
    );

    await expect.poll(() => page.locator(".tab").count()).toBe(0);
    expect(await calls(page, "create")).toHaveLength(0);
  });

  test("and Alt-F is left to the editor", async ({ page }) => {
    await openOn(page, "Darwin");
    await page.locator(".monaco-editor .view-lines").first().click();

    await page.keyboard.press("Alt+f");

    await expect(page.locator("#titlebar-dropdown")).toBeHidden();
  });
});
