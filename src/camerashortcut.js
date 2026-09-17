import { execute } from "./editor/monaco.js";
import * as ipc from "./ipc.js";
import * as log from "./log.js";

// The reset_camera shortcut beside the console tabs.
//
// Two states, one button. With the kernel's default at Camera.RESET the next
// show() puts the camera back to where the model fits, and the button offers
// to keep it instead; with anything else - KEEP, or CENTER from Settings - the
// camera stays where it was, and the button offers the reset.
//
// The state is the kernel's, never this button's. It is read on every refresh
// the sidecar makes - after each idle, after the warm-up, after a restart -
// because it moves without the button: a script's own set_defaults(), a line
// in the console, reset_defaults(), a restarted kernel back at Settings. A
// press runs set_defaults() through the same execute a Run uses, visible in
// the console, and the icon changes when the kernel's next answer says so
// rather than when the button was pressed. Until the first answer the button
// is hidden: there is no state to show.
//
// Session, not setting: what a press changes is the kernel's default, and a
// restart brings Settings -> Viewer -> reset_camera back.

const RESET = "RESET";

/** The Python for the press: to KEEP from RESET, to RESET from anything else. */
export function lineFor(state) {
  const next = state === RESET ? "KEEP" : "RESET";
  return `from build123d_studio import set_defaults, Camera; set_defaults(reset_camera=Camera.${next})`;
}

let state = null;

function button() {
  return document.getElementById("camera-shortcut");
}

function render() {
  const el = button();
  if (state === null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const icon = el.querySelector(".icon");
  icon.className = state === RESET ? "icon icon-camera-reset" : "icon icon-camera-keep";
  el.title =
    state === RESET
      ? "The camera resets on the next show. Click to keep it where it is."
      : `The camera is kept on show (${state}). Click to reset it on the next show.`;
}

export function initCameraShortcut() {
  ipc.on("viewer.defaults", (frame) => {
    const value = frame.reset_camera;
    state = typeof value === "string" && value !== "" ? value : null;
    render();
  });
  // A replacement kernel answers afresh; until then the button has nothing.
  ipc.on("kernel.restarting", () => {
    state = null;
    render();
  });
  button().addEventListener("click", () => {
    if (state === null) {
      return;
    }
    log.info(`Camera shortcut: ${state} -> ${state === RESET ? "KEEP" : "RESET"}`);
    execute(lineFor(state));
  });
  render();
}
