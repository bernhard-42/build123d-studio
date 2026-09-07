// The About dialog's two jobs beyond naming versions.
//
// It is where a bug report gets its paths from, and it is the only place that
// says how to reach the kernel from outside the application. Both come down to
// one path reaching a clipboard intact: every path here wraps across two or
// three lines in a narrow column and contains a space on macOS and Windows, so
// selecting one by hand is the step people get wrong - and the connection file
// is useless without the command that consumes it, quotes included.

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const CONNECTION = "/env/runtime/instances/994a93cb-3281/kernel.json";

const INFO = {
  info: {
    python: "3.14.6",
    implementation: "CPython",
    connectionFile: CONNECTION,
    packages: [{ name: "build123d", version: "0.10.0" }],
    // The full list is what the connection section had to get in front of: a
    // reader who has to scroll past a hundred alphabetised rows to reach it
    // will not find it at all.
    allPackages: [
      { name: "anyio", version: "4.12.0" },
      { name: "build123d", version: "0.10.0" },
    ],
  },
};

/** Open About and let the sidecar answer, as it does within a frame or two. */
async function about(page, sidecar, answer = INFO) {
  await page.click("#btn-info");
  await sidecar.waitFor("app.info");
  sidecar.send("app.info", answer);
  const dialog = page.locator("#info-dialog");
  await expect(dialog).toBeVisible();
  // The rows arrive with the answer above, so wait for a row rather than for
  // the panel, which was appended before anything had been gathered.
  await expect(dialog.locator('.info-label:text-is("Kernel connection file")')).toBeVisible();
  return dialog;
}

const rowFor = (page, dialog, label) =>
  dialog
    .locator("tr")
    .filter({ has: page.locator(`.info-label:text-is("${label}")`) });

const copied = (page) =>
  page.evaluate(() =>
    globalThis.__NEUTRALINO_STUB__
      .calls()
      .filter((call) => call.name === "clipboard.writeText")
      .map((call) => call.args[0]),
  );

test.describe("the kernel connection", () => {
  test("has a section of its own, with the command to use it", async ({ page }) => {
    const { sidecar } = await open(page);
    const dialog = await about(page, sidecar);

    // The note is the point of the section: the path alone never said that
    // anything could be done with it.
    const note = dialog.locator(".info-note").last();
    await expect(note).toContainText('jupyter-console --existing "<Kernel connection file>"');
    // Ctrl-D rather than exit, because a typed exit shuts this kernel down -
    // measured against a live kernel, not inferred.
    await expect(note).toContainText("Ctrl-D");
    // Their own jupyter-console, not the one in the environment: that tree is
    // Settings' to manage, and a path into it invites people to install into
    // it.
    await expect(note).toContainText("install jupyter-console outside of build123d Studio");

    const titles = await dialog.locator(".info-heading").allTextContents();
    const table = dialog.locator(".info-table").nth(titles.indexOf("Kernel connection"));
    await expect(table).toContainText(CONNECTION);
  });

  test("comes after everything a reader is meant to find, and before the long list", async ({ page }) => {
    const { sidecar } = await open(page);
    const dialog = await about(page, sidecar);

    // The package list is last because it is the one section nobody scrolls
    // past on purpose.
    const titles = await dialog.locator(".info-heading").allTextContents();
    expect(titles.slice(-2)).toEqual(["Kernel connection", "All installed packages (2)"]);
  });

  test("and no longer sits in the environment section", async ({ page }) => {
    const { sidecar } = await open(page);
    const dialog = await about(page, sidecar);

    // Tables follow their headings in order: Application, then the environment.
    await expect(dialog.locator(".info-table").nth(1)).not.toContainText("Kernel connection file");
  });
});

test.describe("copying a path", () => {
  test("every path has a button and every version has none", async ({ page }) => {
    const { sidecar } = await open(page);
    const dialog = await about(page, sidecar);

    await expect(rowFor(page, dialog, "Location").locator(".info-copy")).toHaveCount(1);
    await expect(rowFor(page, dialog, "Log").locator(".info-copy")).toHaveCount(1);
    await expect(rowFor(page, dialog, "File").locator(".info-copy")).toHaveCount(1);
    await expect(rowFor(page, dialog, "Kernel connection file").locator(".info-copy")).toHaveCount(1);

    // A version is short, never wraps, and the header's Copy already yields the
    // whole dialog as text.
    await expect(rowFor(page, dialog, "Monaco editor").locator(".info-copy")).toHaveCount(0);
    await expect(rowFor(page, dialog, "Platform").locator(".info-copy")).toHaveCount(0);
  });

  test("in a column wider than the labels beside it", async ({ page }) => {
    const { sidecar } = await open(page);
    const dialog = await about(page, sidecar);

    // The values are what this dialog exists to hand over, and they are the
    // half that wraps: the longest label in it is 145px against paths of five
    // hundred. A label column sized as a share of the panel took 265px of 630
    // and spent most of it on nothing.
    const [label, value] = await dialog.evaluate((panel) => {
      const row = panel.querySelector(".info-table tr");
      return [
        row.querySelector(".info-label").getBoundingClientRect().width,
        row.querySelector(".info-value").getBoundingClientRect().width,
      ];
    });
    expect(value).toBeGreaterThan(label * 2);
  });

  test("puts exactly that path on the clipboard, and nothing around it", async ({ page }) => {
    const { sidecar } = await open(page);
    const dialog = await about(page, sidecar);

    await rowFor(page, dialog, "Kernel connection file").locator(".info-copy").click();
    expect(await copied(page)).toEqual([CONNECTION]);
  });

  test("and there is nothing to copy before the sidecar has answered", async ({ page }) => {
    const { sidecar } = await open(page);
    const dialog = await about(page, sidecar, { info: { python: "3.14.6" } });

    const row = rowFor(page, dialog, "Kernel connection file");
    await expect(row).toContainText("starting…");
    await expect(row.locator(".info-copy")).toHaveCount(0);
  });
});
