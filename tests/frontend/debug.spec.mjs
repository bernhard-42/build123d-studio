/** Debugging, at the layer where it is two worlds rather than one.
 *
 * The design decision this holds down is the one his objection settled: while a
 * session runs, *every pane in the window describes the debugged process*, and
 * otherwise every pane describes the kernel. The panes swap rather than sharing.
 * The alternative - a debug console beside the Jupyter one - was the plan, and
 * it means somebody has to remember which pane means what while the variable
 * explorer describes the kernel and the editor describes the debuggee.
 *
 * The viewer is the deliberate exception, because a picture is not state.
 *
 * The sidecar is a relay that understands no DAP, so every message below is one
 * the frontend composed - which is what makes them assertable here at all.
 *
 * Proved by un-applying, once, when each case was written: the guard taken out
 * of the shipped source, the suite run, the file put back. What was removed,
 * and what went red:
 *
 * - src/debug/start.js, NEEDS_PAUSE emptied - stepping is disabled between
 *   stops
 */

import { expect, test } from "@playwright/test";

import { open } from "./app.mjs";

const PROJECT = "/documents/bracket";
const FILES = { [`${PROJECT}/part.py`]: "from build123d import *\n\nb = Box(1, 2, 3)\n" };
const WORKSPACE = {
  folder: PROJECT,
  tabs: [{ path: `${PROJECT}/part.py`, caret: null }],
  active: `${PROJECT}/part.py`,
};

async function openApp(page) {
  const handles = await open(page, { files: FILES, settings: { workspace: WORKSPACE } });
  await expect(page.locator(".tab-active .tab-label")).toHaveText("part.py");
  return handles;
}

/** Every DAP command the frontend has composed, in order. */
function dapCommands(sidecar) {
  return sidecar.received
    .filter((frame) => frame.type === "debug.send")
    .map((frame) => frame.message?.command)
    .filter((command) => command !== undefined);
}

/** Answer a DAP request the way the adapter would, echoing its seq. */
function replyTo(sidecar, command, body = {}) {
  const sent = sidecar.received
    .filter((f) => f.type === "debug.send" && f.message?.command === command)
    .pop();
  sidecar.send("debug.message", {
    message: {
      type: "response",
      request_seq: sent.message.seq,
      seq: sent.message.seq + 1000,
      success: true,
      command,
      body,
    },
  });
}

/** Start a session and get as far as the adapter being live. */
async function startSession(page, sidecar) {
  sidecar.autoAnswerDap();
  await page.evaluate(() =>
    globalThis.__NEUTRALINO_STUB__.emit("mainMenuItemClicked", { id: "debug.start" }),
  );
  await sidecar.waitFor("debug.start");
  sidecar.send("debug.started");
  // The DAP client is created *after* debug.started resolves, so an event sent
  // before the handshake has run reaches nobody. Waiting for `attach` is
  // waiting for there to be a client to deliver to; without it the pause below
  // is silently dropped and the step buttons stay disabled, which surfaces as a
  // click timing out on a button that is on screen.
  await expect.poll(() => dapCommands(sidecar)).toContain("attach");
  return sidecar;
}

test.describe("starting a session", () => {
  test("the step controls appear only while one is running", async ({ page }) => {
    // Right-aligned in the tab strip rather than in a second toolbar, and absent
    // otherwise: the strip simply scrolls in less width. No layout is spent on
    // controls that are not usable.
    const { sidecar } = await openApp(page);

    await expect(page.locator("#debug-bar")).toBeHidden();

    await startSession(page, sidecar);

    await expect(page.locator("#debug-bar")).toBeVisible();
    for (const id of ["debug-continue", "debug-step-over", "debug-step-into", "debug-stop"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test("the buffer is saved first, as VS Code does", async ({ page }) => {
    // The file runs from disk, which is what makes a breakpoint land on the line
    // the user put it on with no mapping to be wrong about - so an unsaved
    // buffer would debug yesterday's code, which is worse than refusing.
    const { sidecar } = await openApp(page);

    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.type("EDITED");
    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(1);

    await startSession(page, sidecar);

    await expect(page.locator(".tab-close.tab-dirty")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (p) => String(globalThis.__NEUTRALINO_STUB__.wrote(p) ?? ""),
          `${PROJECT}/part.py`,
        ),
      )
      .toContain("EDITED");
  });
});

test.describe("the panes swap rather than sharing", () => {
  test("starting a session raises the Run/Debug tab", async ({ page }) => {
    const { sidecar } = await openApp(page);

    await expect(page.locator("#pane-console")).toBeVisible();

    await startSession(page, sidecar);

    await expect(
      page.locator("#pane-console"),
      "the Jupyter console is still on screen during a session",
    ).toBeHidden();
    await expect(page.locator("#pane-debug")).toBeVisible();
  });

  test("and its output survives the session that wrote it", async ({ page }) => {
    // The panes used to swap back when the session ended, which took the
    // transcript with it - so a traceback could only be read while the process
    // that raised it was still alive. The tab stays where it is now, and the
    // Console tab is one click away rather than being restored underneath you.
    const { sidecar } = await openApp(page);
    await startSession(page, sidecar);
    sidecar.send("debug.output", { text: "SENTINEL_TRACEBACK\n" });
    await expect(page.locator("#debug-output")).toContainText("SENTINEL_TRACEBACK");

    sidecar.send("debug.exited", { code: 0 });

    await expect(page.locator("#pane-debug")).toBeVisible();
    await expect(page.locator("#debug-output")).toContainText("SENTINEL_TRACEBACK");

    await page.locator("#console-tab-console").click();
    await expect(page.locator("#pane-console")).toBeVisible();
    await expect(page.locator("#pane-debug")).toBeHidden();
  });

  test("and the step controls go away with the session", async ({ page }) => {
    const { sidecar } = await openApp(page);

    await startSession(page, sidecar);
    await expect(page.locator("#debug-bar")).toBeVisible();

    sidecar.send("debug.exited", { code: 0 });

    await expect(page.locator("#debug-bar")).toBeHidden();
  });
});

test.describe("what the tabs mean for the panes beside them", () => {
  test("a finished session leaves the tab up and the explorer empty", async ({ page }) => {
    // Not back to the kernel. The pane still belongs to the session that has
    // just ended, and its transcript is still on screen above it.
    const { sidecar } = await openApp(page);
    await startSession(page, sidecar);

    sidecar.send("debug.exited", { code: 0 });

    await expect(page.locator("#pane-debug")).toBeVisible();
    // Gone rather than empty: with the session over there is nothing for it to
    // be about, and an empty explorer reads as a kernel with no variables yet.
    await expect(page.locator("#pane-vars")).toBeHidden();
    await expect(page.locator("#debug-prompt")).toBeHidden();
  });

  test("switching tabs switches what the explorer is about", async ({ page }) => {
    // With a session live: the Console tab is the kernel, the Run/Debug tab is
    // the frame. Clicking between them moves the explorer with them.
    const { sidecar } = await openApp(page);
    await startSession(page, sidecar);
    await expect(page.locator("#debug-prompt")).toBeVisible();

    // Paused, because an explorer over a session that is merely running has no
    // frame to describe and asks for nothing - which would make the assertion
    // below pass or fail on timing rather than on the rule.
    sidecar.send("debug.message", {
      message: { type: "event", event: "stopped", seq: 1,
                 body: { reason: "breakpoint", threadId: 1 } },
    });
    await expect(page.locator("#debug-continue")).toBeEnabled();

    await page.locator("#console-tab-console").click();
    await expect
      .poll(() => sidecar.received.filter((frame) => frame.type === "vars.refresh").length)
      .toBeGreaterThan(0);

    await page.locator("#console-tab-rundebug").click();

    // Still on screen, because there is a live session for it to describe. It
    // only goes when the tab has nothing behind it.
    await expect(page.locator("#pane-vars")).toBeVisible();
    await expect(page.locator("#debug-prompt")).toBeVisible();
    await expect
      .poll(() => dapCommands(sidecar).filter((command) => command === "scopes").length)
      .toBeGreaterThan(0);
  });
});

test.describe("the step controls compose DAP", () => {
  test("each button sends the command it is named for", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await startSession(page, sidecar);

    // Paused again before each one, because the first click resumes: continue,
    // next, stepIn and stepOut all need something stopped, and after any of
    // them the session is running and the rest are correctly disabled. Clicking
    // four in a row without re-pausing waits on a button that is on screen and
    // will never be enabled.
    for (const [id, command] of [
      ["debug-continue", "continue"],
      ["debug-step-over", "next"],
      ["debug-step-into", "stepIn"],
      ["debug-step-out", "stepOut"],
    ]) {
      sidecar.send("debug.message", {
        message: {
          type: "event",
          event: "stopped",
          seq: 1,
          body: { reason: "breakpoint", threadId: 1 },
        },
      });
      await expect(page.locator(`#${id}`), `${id} never became usable`).toBeEnabled();

      await page.locator(`#${id}`).click();
      await expect
        .poll(() => dapCommands(sidecar), { message: `${id} sent no ${command}` })
        .toContain(command);
    }
  });

  test("stepping is disabled between stops, and Stop is not", async ({ page }) => {
    // Disabled rather than hidden: a session that is running but not paused has
    // nothing to step, and a control that does nothing when pressed is worse
    // than one that says so. Stop is the exception, because it is exactly what
    // somebody reaches for while it runs away with them.
    const { sidecar } = await openApp(page);
    await startSession(page, sidecar);

    for (const id of ["debug-continue", "debug-step-over", "debug-step-into", "debug-step-out"]) {
      await expect(page.locator(`#${id}`), `${id} is usable with nothing paused`).toBeDisabled();
    }
    await expect(page.locator("#debug-stop")).toBeEnabled();
  });

  test("stopping ends the session", async ({ page }) => {
    const { sidecar } = await openApp(page);
    await startSession(page, sidecar);

    await page.locator("#debug-stop").click();

    await expect
      .poll(() => sidecar.typesSent(), { message: "no debug.stop reached the sidecar" })
      .toContain("debug.stop");
  });
});
