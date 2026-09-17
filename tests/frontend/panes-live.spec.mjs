/** What the three receiving panes do with what the sidecar sends them.
 *
 * The other half of every workflow. `run.spec.mjs` asserts what leaves for the
 * sidecar when a chord is pressed; this asserts what arrives on screen when the
 * sidecar answers - the console's bytes, the explorer's rows, the toolbar's
 * indicator. Between them a Run is covered end to end at this layer, and
 * `tests/integration.py` covers the layer below with a real kernel.
 *
 * The frames are built with the shipped encoder, so the two ends cannot drift:
 * `src/frame.js` is what the sidecar's channel.py mirrors, and it is already
 * unit-tested on its own.
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/vars/explorer.js, the `row.expandable !== false` guard - only a row
 *   that leads somewhere offers to open
 * - src/vars/explorer.js, the icon-font chevron back to a character - the
 *   chevron uses the icon font, and the two panes draw it the same way
 * - src/console/terminal.js, the terminal.onData that forwards - a keystroke
 *   in the console is sent back as input
 */

import { expect, test } from "@playwright/test";

import { KIND_CONSOLE } from "../../src/frame.js";
import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "PART = 1\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

const VARIABLES = [
  { name: "b", type: "Box", module: "build123d", size: null, repr: "Box at 0x1", label: "", expandable: true },
  { name: "count", type: "int", module: "builtins", size: null, repr: "42", label: "", expandable: false },
];

async function openApp(page) {
  return open(page, { files: FILES, settings: { workspace: WORKSPACE } });
}

test.describe("the console shows what the kernel printed", () => {
  test("bytes arriving as a binary frame reach the terminal", async ({ page }) => {
    // The hot path, and the reason it is binary: pty output and tessellated
    // geometry never get base64-encoded. A text frame would have been simpler
    // and is not what ships, so the test uses the real encoder.
    const { sidecar } = await openApp(page);

    sidecar.sendBinary(KIND_CONSOLE, new TextEncoder().encode("In [1]: SENTINEL_OUTPUT\r\n"));

    await expect
      .poll(async () => (await page.locator(".pane-console").innerText()).includes("SENTINEL_OUTPUT"), {
        message: "the console never showed what arrived",
      })
      .toBe(true);
  });

  test("a keystroke in the console is sent back as input", async ({ page }) => {
    // The other direction, which is what makes the pane a console rather than a
    // transcript.
    const { sidecar } = await openApp(page);

    // xterm listens on a helper textarea it keeps out of the way; clicking the
    // screen is what focuses it, and is what a person does.
    await page.locator(".pane-console .xterm-screen").first().click();
    await page.keyboard.type("z");

    // Out as KIND_CONSOLE *bytes*, not as a JSON frame - the same reason the
    // output direction is binary. Looking for a "console.input" text frame,
    // which is what this test did first, finds nothing however well the console
    // is working.
    await expect
      .poll(() => sidecar.binaryTextOf(KIND_CONSOLE).join(""), {
        message: "the keystroke never reached the sidecar",
      })
      .toContain("z");
  });
});

test.describe("the variable explorer shows the namespace", () => {
  test("Show in a row's menu runs show() on the kernel for that variable", async ({ page }) => {
    // Proof, at writing: with the "show" branch removed from the pane's onPick
    // in main.js, this fails waiting for the kernel.execute frame.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    await page.locator(".var-row", { hasText: "count" }).click({ button: "right" });
    const show = page.locator(".context-menu-item", { hasText: "Show" });
    await expect(show).toBeEnabled();
    await show.click();

    const frame = await sidecar.waitFor("kernel.execute");
    expect(frame.code).toBe("from build123d_studio import show; show(count)");
  });

  test("but Show is greyed out on a row below a variable", async ({ page }) => {
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);
    // Opening b asks the sidecar for its children; answer with one.
    await page.locator(".var-row", { hasText: "b" }).locator(".var-twisty").click();
    const asked = await sidecar.waitFor("vars.detail");
    sidecar.send("vars.detail", {
      detail: {
        path: asked.path,
        type: "Box",
        attributes: {},
        children: [{ name: "0", type: "Face", module: "build123d", size: null, repr: "Face", label: "top", expandable: false }],
        offset: 0,
        total: 1,
        page: 50,
      },
    });
    await expect(page.locator(".var-child-name")).toHaveCount(1);

    await page.locator(".var-row", { has: page.locator(".var-child-name") }).click({ button: "right" });
    await expect(page.locator(".context-menu-item", { hasText: "Show" })).toBeDisabled();
  });

  test("the filter box narrows the rows by name, survives a refresh, and Escape clears it", async ({ page }) => {
    // Proof, at writing: with filterRows replaced by the unfiltered rows in
    // render(), this fails on the count after typing.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    const box = page.locator(".var-filter-input");
    await box.fill("COU");
    await expect(page.locator(".var-row .var-name")).toHaveCount(1);
    await expect(page.locator(".var-row .var-name").first()).toContainText("count");

    // The kernel goes idle and sends the namespace again: the filter stays.
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(1);
    await expect(box).toHaveValue("COU");

    await box.fill("zzz");
    await expect(page.locator(".var-empty")).toHaveText('No variable matches "zzz".');

    await box.press("Escape");
    await expect(box).toHaveValue("");
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);
  });

  test("the filter row is the tab row's height and stays put while the table scrolls", async ({ page }) => {
    // It used to be sticky inside the scrolling pane, above the pane's own
    // padding: rows scrolled through the gap over it. A fixed row over a
    // scrolling body has no gap, and one CSS variable gives both rows one
    // height so the two panes line up.
    const { sidecar } = await openApp(page);
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `v${i}`, type: "int", module: "builtins", size: null, repr: String(i), label: "", expandable: false,
    }));
    sidecar.send("vars.data", { variables: many });
    await expect(page.locator(".var-row .var-name")).toHaveCount(200);

    const before = await page.evaluate(() => ({
      tabs: document.getElementById("console-tabs").getBoundingClientRect().height,
      filter: document.querySelector(".var-filter").getBoundingClientRect(),
      pane: document.getElementById("pane-vars").getBoundingClientRect(),
    }));
    expect(before.filter.height).toBe(before.tabs);
    expect(before.filter.top).toBe(before.pane.top);

    await page.evaluate(() => {
      const body = document.querySelector(".var-body");
      body.scrollTop = body.scrollHeight;
    });
    const after = await page.evaluate(() => ({
      filterTop: document.querySelector(".var-filter").getBoundingClientRect().top,
      paneTop: document.getElementById("pane-vars").getBoundingClientRect().top,
      scrolled: document.querySelector(".var-body").scrollTop,
      headerTop: document.querySelector(".var-header th").getBoundingClientRect().top,
      bodyTop: document.querySelector(".var-body").getBoundingClientRect().top,
    }));
    expect(after.scrolled).toBeGreaterThan(0);
    expect(after.filterTop).toBe(after.paneTop);
    // And the column names stay at the top of the body, the rows under them.
    expect(after.headerTop).toBe(after.bodyTop);
  });

  test("a click on Name or Type sorts, a second reverses, a third restores the kernel's order", async ({ page }) => {
    // Proof, at writing: with sortRows replaced by the unsorted rows in
    // render(), this fails on the first order.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);
    const names = () => page.locator(".var-row .var-name").allTextContents();
    const plain = (texts) => texts.map((t) => t.replace(/[^a-z_0-9]/gi, ""));

    // The kernel's order: b, count.
    expect(plain(await names())).toEqual(["b", "count"]);

    const nameHeader = page.locator(".var-header th", { hasText: "Name" });
    const geometry = () =>
      page.evaluate(() => {
        const th = [...document.querySelectorAll(".var-header th")].find((t) => t.textContent.includes("Name"));
        const mark = th.querySelector(".var-sort");
        return { height: th.getBoundingClientRect().height, markLeft: mark.getBoundingClientRect().left };
      });
    const unsorted = await geometry();

    await nameHeader.click();
    expect(plain(await names())).toEqual(["b", "count"]);
    await expect(nameHeader.locator(".var-sort-asc")).toHaveCount(1);
    const ascending = await geometry();
    await nameHeader.click();
    expect(plain(await names())).toEqual(["count", "b"]);
    await expect(nameHeader.locator(".var-sort-desc")).toHaveCount(1);
    const descending = await geometry();
    await nameHeader.click();
    expect(plain(await names())).toEqual(["b", "count"]);
    await expect(nameHeader.locator(".icon")).toHaveCount(0);

    // The mark is a fixed square: the header is one height in all three
    // states, and up and down sit at the same x.
    expect(ascending.height).toBe(unsorted.height);
    expect(descending.height).toBe(unsorted.height);
    expect(descending.markLeft).toBe(ascending.markLeft);

    // Type: Box before int.
    await page.locator(".var-header th", { hasText: "Type" }).click();
    expect(plain(await names())).toEqual(["b", "count"]);
    await page.locator(".var-header th", { hasText: "Type" }).click();
    expect(plain(await names())).toEqual(["count", "b"]);
  });

  test("a vars.data frame becomes rows", async ({ page }) => {
    const { sidecar } = await openApp(page);

    sidecar.send("vars.data", { variables: VARIABLES });

    await expect(page.locator(".var-row .var-name")).toHaveCount(2);
    // The name cell carries the twisty as well as the name, so the text of the
    // cell is "▸b" for an expandable row - assert containment rather than
    // equality, which would be asserting the marker's shape by accident.
    const names = await page.locator(".var-row .var-name").allTextContents();
    expect(names[0]).toContain("b");
    expect(names[1]).toContain("count");
    expect(await page.locator(".pane-vars").innerText()).toContain("Box");
  });

  test("only a row that leads somewhere offers to open", async ({ page }) => {
    // A chevron on an int is a promise the row cannot keep. Decided in group 3
    // and computed kernel-side, but it is the pane that has to honour it.
    const { sidecar } = await openApp(page);

    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    // Every row has the twisty box - it is what keeps the names lined up - so
    // the question is whether there is a chevron *in* it.
    const rows = page.locator(".var-row");
    await expect(
      rows.nth(0).locator(".var-twisty .icon-chevron"),
      "an expandable row had no way to open it",
    ).toHaveCount(1);
    await expect(
      rows.nth(1).locator(".var-twisty .icon-chevron"),
      "an int was offered a chevron it cannot keep",
    ).toHaveCount(0);
  });

  test("expanding a row asks the sidecar for its detail", async ({ page }) => {
    const { sidecar } = await openApp(page);

    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    // The chevron opens the row; a click on the name selects it and nothing
    // more - see the selection tests above.
    await page.locator(".var-row").nth(0).locator(".var-twisty").click();

    const detail = await sidecar.waitFor("vars.detail");
    expect(detail.path, "the expansion asked about the wrong row").toEqual(["b"]);
  });

  test("a click on the name selects the row and does not open it", async ({ page }) => {
    // Proof, at writing: with the twisty's stopPropagation removed and the
    // old head click restored, this fails on the vars.detail frame arriving.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    await page.locator(".var-row", { hasText: "b" }).click();
    await expect(page.locator(".var-row", { hasText: "b" })).toHaveClass(/var-selected/);
    await expect(page.locator(".var-row", { hasText: "count" })).not.toHaveClass(/var-selected/);
    await page.waitForTimeout(200);
    expect(sidecar.received.filter((f) => f.type === "vars.detail")).toHaveLength(0);
    await expect(page.locator(".var-child-name")).toHaveCount(0);
  });

  test("Cmd-click adds to the selection, and Show and Copy act on all of it", async ({ page }) => {
    // Proof, at writing: with variables.join replaced by variables[0] in
    // main.js, this fails on the show line.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    await page.locator(".var-row", { hasText: "b" }).click();
    await page.locator(".var-row", { hasText: "count" }).click({ modifiers: ["Meta"] });
    await expect(page.locator(".var-row.var-selected")).toHaveCount(2);

    await page.locator(".var-row", { hasText: "count" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Copy" }).click();
    const copied = await page.evaluate(() =>
      globalThis.__NEUTRALINO_STUB__.calls().filter((c) => c.name === "clipboard.writeText").map((c) => c.args[0]));
    expect(copied).toEqual(["b, count"]);

    await page.locator(".var-row", { hasText: "b" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Show" }).click();
    const frame = await sidecar.waitFor("kernel.execute");
    expect(frame.code).toBe("from build123d_studio import show; show(b, count)");
  });

  test("Shift-click extends the row selection and cancels the browser's text selection", async ({ page }) => {
    // The browser extends its own selection on a Shift-click - the rows in
    // between flashed blue on macOS - unless the mousedown is cancelled. A
    // synthetic click in this harness does not extend a selection, so what
    // is held is the cancellation itself: dispatchEvent answers false for a
    // cancelled event. Proof, at writing: with the shift mousedown
    // preventDefault removed, this fails on `cancelled`.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    await page.locator(".var-row", { hasText: "b" }).click();
    await page.locator(".var-row", { hasText: "count" }).click({ modifiers: ["Shift"] });
    await expect(page.locator(".var-row.var-selected")).toHaveCount(2);

    const cancelled = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".var-row")].find((r) => r.textContent.includes("count"));
      const shifted = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
      const plain = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      return { shifted: !row.dispatchEvent(shifted), plain: !row.dispatchEvent(plain) };
    });
    expect(cancelled).toEqual({ shifted: true, plain: false });
  });

  test("a right-click outside the selection selects that row alone", async ({ page }) => {
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    await page.locator(".var-row", { hasText: "b" }).click();
    await page.locator(".var-row", { hasText: "count" }).click({ button: "right" });
    await expect(page.locator(".var-row.var-selected")).toHaveCount(1);
    await expect(page.locator(".var-row", { hasText: "count" })).toHaveClass(/var-selected/);
    await page.locator(".context-menu-item", { hasText: "Show" }).click();
    const frame = await sidecar.waitFor("kernel.execute");
    expect(frame.code).toBe("from build123d_studio import show; show(count)");
  });
});

test.describe("the toolbar says what the kernel is doing", () => {
  test("busy and idle reach the indicator", async ({ page }) => {
    // It answers one question - "is the kernel running my code" - and it used to
    // flicker because every shell request published busy and idle, not only the
    // ones that execute something. That gate is the sidecar's; what this holds
    // is that whatever it forwards is what the user sees.
    const { sidecar } = await openApp(page);

    sidecar.send("kernel.status", { state: "busy" });
    await expect(page.locator("#kernel-label")).toHaveText("busy");
    await expect(page.locator("#kernel-status")).toHaveClass(/busy/);

    sidecar.send("kernel.status", { state: "idle" });
    await expect(page.locator("#kernel-label")).toHaveText("idle");
    await expect(page.locator("#kernel-status")).toHaveClass(/idle/);
  });

  test("pressing Interrupt says so, and the dot stays busy", async ({ page }) => {
    // Asked for: a button that appears to do nothing while a long boolean runs
    // is a button people press again. The dot is deliberately unchanged - the
    // kernel *is* busy, it has just been asked not to be.
    const { sidecar } = await openApp(page);

    sidecar.send("kernel.status", { state: "busy" });
    await expect(page.locator("#kernel-label")).toHaveText("busy");

    await page.locator("#btn-interrupt").click();

    await expect(page.locator("#kernel-label")).toHaveText("interrupting");
    await expect(page.locator("#kernel-status")).toHaveClass(/busy/);
    await expect
      .poll(() => sidecar.received.filter((f) => f.type === "kernel.interrupt").length)
      .toBe(1);
  });

  test("and it says idle again the moment the kernel stops", async ({ page }) => {
    // The word must not outlive the request. A kernel that stopped is idle,
    // whatever was asked of it a moment earlier.
    const { sidecar } = await openApp(page);

    sidecar.send("kernel.status", { state: "busy" });
    await expect(page.locator("#kernel-label")).toHaveText("busy");
    await page.locator("#btn-interrupt").click();
    await expect(page.locator("#kernel-label")).toHaveText("interrupting");

    sidecar.send("kernel.status", { state: "idle" });

    await expect(page.locator("#kernel-label")).toHaveText("idle");
    await expect(page.locator("#kernel-status")).toHaveClass(/idle/);
  });

  test("a kernel that obeyed and was given more work is not offered a restart", async ({ page }) => {
    // Reported: interrupt two cells, then run them again straight away, and
    // five seconds later "The kernel did not stop" appeared over a kernel that
    // had stopped exactly when asked. The grace sampled the state at its
    // deadline and found `busy` - the *new* work.
    //
    // Six seconds of real waiting, because the grace is five and the whole
    // claim is that nothing happens when it passes. Nothing here can be
    // hurried: a shorter grace would be testing a different constant.
    test.slow();
    const { sidecar } = await openApp(page);

    sidecar.send("kernel.status", { state: "busy" });
    await page.locator("#btn-interrupt").click();
    await expect(page.locator("#kernel-label")).toHaveText("interrupting");

    // It obeys, and the user immediately runs something else.
    sidecar.send("kernel.status", { state: "idle" });
    await expect(page.locator("#kernel-label")).toHaveText("idle");
    sidecar.send("kernel.status", { state: "busy" });
    await expect(page.locator("#kernel-label")).toHaveText("busy");

    await page.waitForTimeout(6000);

    await expect(
      page.locator(".confirm-overlay"),
      "a kernel that stopped when asked was offered a restart",
    ).toBeHidden();
  });

  test("a kernel that died is not still reported as busy", async ({ page }) => {
    // A dead ZMQ peer raises nothing, so an exhausted kernel used to look
    // exactly like an idle one and the toolbar kept whatever it last had -
    // reading "busy" until the application was restarted. Running out of memory
    // tessellating a large model is the ordinary way in.
    const { sidecar } = await openApp(page);

    sidecar.send("kernel.status", { state: "busy" });
    await expect(page.locator("#kernel-label")).toHaveText("busy");

    sidecar.send("kernel.status", { state: "dead" });
    await expect(page.locator("#kernel-label")).not.toHaveText("busy");
  });
});

test.describe("the expand marker is drawn by the bundled font", () => {
  // Found by this suite and then fixed. The explorer drew its marker as a
  // literal "▸"/"▾", which is what the file tree used to do - and those
  // characters have no glyph in WKWebView, so they come out as a dot. Group 2
  // gave the tree the bundled Material Symbols subset, "which either renders or
  // nothing does", and this pane was not given the same treatment.
  //
  // The symptom is still not reproducible here: Playwright's WebKit does have a
  // glyph for U+25B8 - measured in harness.spec.mjs - so what this holds is the
  // fix rather than the defect, and a real build is what confirms it on screen.
  test("the chevron uses the icon font rather than a character", async ({ page }) => {
    const { sidecar } = await openApp(page);

    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    const chevron = page.locator(".var-row .var-twisty .icon-chevron").first();
    await expect(chevron).toBeVisible();

    const painted = await chevron.evaluate((el) => {
      const before = getComputedStyle(el, "::before");
      return { font: before.fontFamily, content: before.content };
    });
    expect(painted.font.toLowerCase()).toContain("material symbols");
    expect(painted.content, "the chevron has no glyph to paint").not.toBe("none");

    const box = await chevron.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  test("and the two panes now draw it the same way", async ({ page }) => {
    // The disagreement is what gave this away, so it is worth holding: the file
    // tree and the explorer use one control and should keep using one.
    const { sidecar } = await openApp(page);
    sidecar.send("vars.data", { variables: VARIABLES });
    await expect(page.locator(".var-row .var-name")).toHaveCount(2);

    const fonts = await page.evaluate(() =>
      [".tree-twisty .icon", ".var-twisty .icon"].map((selector) => {
        const el = document.querySelector(selector);
        return el === null ? null : getComputedStyle(el, "::before").fontFamily;
      }),
    );
    expect(fonts[1]).toContain("Material Symbols");
  });
});

test.describe("the camera shortcut beside the console tabs", () => {
  // Proof, at writing: with the render() call removed from the viewer.defaults
  // handler in camerashortcut.js, the first test fails on the button staying
  // hidden; with the press's execute removed, the second fails waiting for
  // the kernel.execute frame.

  test("it shows what the kernel says the default is, and nothing before that", async ({ page }) => {
    const { sidecar } = await openApp(page);
    const button = page.locator("#camera-shortcut");
    await expect(button).toBeHidden();

    sidecar.send("viewer.defaults", { reset_camera: "RESET" });
    await expect(button).toBeVisible();
    await expect(button.locator(".icon")).toHaveClass(/icon-camera-reset/);

    sidecar.send("viewer.defaults", { reset_camera: "KEEP" });
    await expect(button.locator(".icon")).toHaveClass(/icon-camera-keep/);
    await expect(button).toHaveAttribute("title", /kept on show \(KEEP\)/);

    // CENTER from Settings is the other state as well, and says so.
    sidecar.send("viewer.defaults", { reset_camera: "CENTER" });
    await expect(button.locator(".icon")).toHaveClass(/icon-camera-keep/);
    await expect(button).toHaveAttribute("title", /kept on show \(CENTER\)/);

    // A kernel that cannot say has no button.
    sidecar.send("viewer.defaults", { reset_camera: null });
    await expect(button).toBeHidden();
  });

  test("a press runs set_defaults on the kernel, and the icon follows the kernel's answer", async ({ page }) => {
    const { sidecar } = await openApp(page);
    sidecar.send("viewer.defaults", { reset_camera: "RESET" });
    const button = page.locator("#camera-shortcut");
    await expect(button).toBeVisible();

    await button.click();
    const frame = await sidecar.waitFor("kernel.execute");
    expect(frame.code).toBe(
      "from build123d_studio import set_defaults, Camera; set_defaults(reset_camera=Camera.KEEP)",
    );
    // Not flipped by the press: the kernel has not said so yet.
    await expect(button.locator(".icon")).toHaveClass(/icon-camera-reset/);

    sidecar.send("viewer.defaults", { reset_camera: "KEEP" });
    await expect(button.locator(".icon")).toHaveClass(/icon-camera-keep/);

    await button.click();
    await expect
      .poll(() => sidecar.received.filter((f) => f.type === "kernel.execute").length)
      .toBe(2);
    expect(sidecar.received.filter((f) => f.type === "kernel.execute")[1].code).toContain("Camera.RESET");
  });
});
