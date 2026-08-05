import { os } from "@neutralinojs/lib";

import * as log from "./log.js";

// A three-way confirmation, built in the page rather than with a native dialog.
//
// os.showMessageBox would be less code, but its YES_NO_CANCEL only offers
// buttons labelled Yes, No and Cancel - and "Yes / No / Cancel" is exactly the
// wording that makes people hesitate over a destructive choice, because "No"
// and "Cancel" sound like the same answer. Buttons that say "Save", "Discard"
// and "Cancel" cannot be misread.
//
// It is a promise, so callers read top to bottom: the answer arrives where the
// question was asked.

let overlay = null;
// Whether a question is on screen. See askThreeWay.
let asking = false;

function build() {
  overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="confirm-panel" role="alertdialog" aria-modal="true"
         aria-labelledby="confirm-title" aria-describedby="confirm-detail">
      <p class="confirm-title" id="confirm-title"></p>
      <p class="confirm-detail" id="confirm-detail"></p>
      <div class="confirm-buttons">
        <button type="button" class="confirm-button" data-answer="cancel"></button>
        <button type="button" class="confirm-button" data-answer="discard"></button>
        <button type="button" class="confirm-button primary" data-answer="save"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

/**
 * Ask a three-way question.
 *
 * @returns {Promise<"save"|"discard"|"cancel">}
 */
export function askThreeWay({ title, detail, save, discard, cancel }) {
  return ask({ title, detail, save, discard, cancel });
}

/**
 * Ask a two-way question, the middle button left out.
 *
 * The same overlay rather than a second one, because the reason for building
 * this one by hand applies unchanged: a question whose buttons say what they do
 * cannot be misread, and "OK / Cancel" over a file that may take a while is
 * exactly the pair that gets clicked without being read.
 *
 * @returns {Promise<"confirm"|"cancel">}
 */
export async function askTwoWay({ title, detail, confirm, cancel }) {
  const answer = await ask({ title, detail, save: confirm, discard: null, cancel });
  return answer === "save" ? "confirm" : "cancel";
}

function ask({ title, detail, save, discard, cancel }) {
  // One question at a time, and a second asker is told no rather than shown a
  // dialog.
  //
  // There is a single overlay and a single set of listeners, so a second call
  // used to overwrite the first's text and add its own handlers to the same
  // buttons. One click then resolved both promises: quitting during the New
  // File prompt answered both with "save", and two saves started on one
  // temporary file, racing to move it into place. Cmd-Q is the realistic way
  // in, because it can arrive while any other prompt is open.
  //
  // "cancel" is the safe answer for the loser: whatever it was about to do, not
  // doing it cannot lose work, and the question that is already on screen is
  // the one the user is actually looking at.
  if (asking) {
    return Promise.resolve("cancel");
  }
  asking = true;

  if (overlay === null) {
    build();
  }
  overlay.querySelector("#confirm-title").textContent = title;
  overlay.querySelector("#confirm-detail").textContent = detail;
  for (const [answer, label] of [["save", save], ["discard", discard], ["cancel", cancel]]) {
    const button = overlay.querySelector(`[data-answer="${answer}"]`);
    // A label of null is a button this question does not have. Hidden rather
    // than removed, because the overlay is built once and reused, and a button
    // taken out of it would not come back for the next three-way question.
    button.hidden = label === null || label === undefined;
    button.textContent = button.hidden ? "" : label;
  }
  overlay.hidden = false;

  return new Promise((resolve) => {
    const finish = (answer) => {
      overlay.hidden = true;
      overlay.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
      asking = false;
      resolve(answer);
    };

    const onClick = (event) => {
      const button = event.target.closest("[data-answer]");
      if (button !== null) {
        finish(button.dataset.answer);
      }
    };

    // Capture, so Monaco and xterm cannot swallow Escape or Enter first. Escape
    // means cancel because that is what Escape means everywhere; Enter takes
    // the safe option rather than the destructive one.
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish("cancel");
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        finish("save");
      }
    };

    overlay.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey, true);
    overlay.querySelector('[data-answer="save"]').focus();
  });
}

/**
 * Tell the user something failed, and wait until they have seen it.
 *
 * Native here, unlike askThreeWay above, for two reasons. The objection to
 * os.showMessageBox was its fixed button labels, and a single OK is the one set
 * of labels that cannot be misread. And this is used on the way out of the
 * application - a save that fails while quitting - where the page is about to
 * stop existing and an overlay drawn in it is not a thing to depend on.
 *
 * Awaited, deliberately. Reporting a lost save with a toast that fades while
 * the window closes is the same as not reporting it.
 */
export async function notifyFailure(title, detail) {
  await showBox(title, detail, "ERROR");
}

/**
 * Say that something will not be done, and wait until they have seen it.
 *
 * Separate from notifyFailure only in what it claims. Refusing to put a PNG in
 * the editor is the application working, and an error icon over it would say
 * that something went wrong with a file the user is perfectly entitled to have
 * in their project.
 */
export async function notifyRefusal(title, detail) {
  await showBox(title, detail, "WARNING");
}

async function showBox(title, detail, kind) {
  try {
    await os.showMessageBox(title, detail, "OK", kind);
  } catch (error) {
    // The dialog itself failing must not replace what it was reporting.
    log.error("Could not show a message box:", error, "- the message was:", title, detail);
  }
}
