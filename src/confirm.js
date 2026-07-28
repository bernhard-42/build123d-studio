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
  if (overlay === null) {
    build();
  }
  overlay.querySelector("#confirm-title").textContent = title;
  overlay.querySelector("#confirm-detail").textContent = detail;
  for (const [answer, label] of [["save", save], ["discard", discard], ["cancel", cancel]]) {
    overlay.querySelector(`[data-answer="${answer}"]`).textContent = label;
  }
  overlay.hidden = false;

  return new Promise((resolve) => {
    const finish = (answer) => {
      overlay.hidden = true;
      overlay.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
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
