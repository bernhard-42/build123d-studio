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

    await page.locator(".var-row").nth(0).click();

    const detail = await sidecar.waitFor("vars.detail");
    expect(detail.path, "the expansion asked about the wrong row").toEqual(["b"]);
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
