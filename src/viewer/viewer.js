import { Display, Timer, Viewer, resolveInstances } from "three-cad-viewer";
// The package exposes its stylesheet as the "./css" export, not by dist path.
import "three-cad-viewer/css";
import { createPage } from "ocp-viewer-core";

import { rehydrate } from "./rehydrate.js";
import { onPaneResize } from "../layout/splitter.js";
import { copyText } from "../editing.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";
import { onThemeChange, resolvedTheme } from "../theme.js";

// The viewer pane.
//
// Everything the viewer *does* - the option assembly, the camera policy, the
// state restore, the notifier, the setter dispatch, the splash - is
// ocp-viewer-core's `createPage`, the same page OCP CAD Viewer for VS Code, the
// standalone viewer and Jupyter CadQuery draw. What is this host's, and all
// that is left here, is the surface it draws on: a pane rather than a window,
// measured against the splitters; the models arriving as binary frames on our
// own IPC rather than as `window` messages; and the theme, which follows the
// desktop unless the user has pinned it.
//
// That split is deliberate rather than economical. `createPage`'s message
// dispatch *is* the feature set - a screenshot, an animation, a config applied
// to a live viewer, a measurement answer - so a shell of our own would have
// exactly the features it re-implemented, and would drift from the other three
// viewers on every one of them.

// The pane, and what the viewer's own chrome takes out of it.
const MIN_CAD_WIDTH = 250;
const MIN_CAD_HEIGHT = 150;

let page = null;

function container() {
  return document.getElementById("pane-viewer");
}

/** The size of the surface, which for this host is a pane and not the window. */
function paneSize() {
  const rect = container().getBoundingClientRect();
  return {
    width: Math.max(rect.width, MIN_CAD_WIDTH),
    height: Math.max(rect.height, MIN_CAD_HEIGHT),
  };
}

// Whether the sidecar has ever taken a report from us, and whether the current
// run of dropped ones has been mentioned. Both exist to tell two situations
// apart that look identical here.
let everDelivered = false;
let dropReported = false;

/**
 * The channel the page reports on: `send(command, message)`.
 *
 * `status` carries the viewer's accumulated state with the latest change laid
 * over it, which is what a `show()` reads through the sidecar - and what drives
 * measurement, since a selection or an active tool rides on the change and is
 * never accumulated.
 */
function send(command, message) {
  if (!ipc.isConnected()) {
    // Two very different cases, and only one is worth a warning.
    //
    // Before the sidecar has ever connected there is simply nothing to send to:
    // the splash logo is drawn as soon as the window exists, and the viewer
    // reports its state as it draws - seventeen reports in a quarter of a
    // second, all of them expected, none of them a fault. Those are debug
    // lines, visible when the console is turned up and invisible otherwise.
    //
    // After it has connected, a dropped report *is* a fault - the viewer looks
    // fine and measurements silently stop - so it is a warning, and once per
    // episode rather than once per report, because a disconnected socket does
    // not produce one of these, it produces a hundred.
    if (everDelivered && !dropReported) {
      dropReported = true;
      log.warn(`Viewer reports are being dropped: the sidecar is not connected (${command})`);
    } else if (!everDelivered) {
      console.debug("viewer report before the sidecar connected, dropped:", command);
    }
    return;
  }
  everDelivered = true;
  dropReported = false;
  try {
    // Every notification the viewer makes, when the console is turned up.
    // `console.debug` rather than a log call, so it obeys the level in
    // Settings: at Errors this costs a function call and nothing else, and at
    // Everything it is the whole conversation - which is what somebody
    // reproducing a measurement or a camera problem actually needs to see.
    console.debug("viewer notification", command, message);

    if (command === "status") {
      console.debug("viewer report: forwarding status to the sidecar");
      // Both page hosts copy a selection to the clipboard, so this one does
      // too - the same feature everywhere is the rule, and the selection is
      // already in the message.
      if (Array.isArray(message.selected) && message.selected.length > 0) {
        copyText(message.selected.join(","));
      }
      ipc.send("viewer.changes", { changes: message });
    } else if (command === "screenshot") {
      ipc.send("viewer.screenshot", message);
    } else if (command === "log") {
      log.info("viewer:", message);
    } else {
      log.warn(`Unhandled report from the viewer: ${command}`);
    }
  } catch (error) {
    log.warn("Could not forward a viewer report:", error);
  }
}

/**
 * The settings this host differs on, and only those.
 *
 * Every number the renderer itself defines comes from the core, so two viewers
 * cannot drift apart on values neither of them chose. What is genuinely ours is
 * glass mode - the tree floats over the canvas instead of taking 240 px out of
 * a pane - and measurement, which is answered by the sidecar from the real BREP
 * rather than estimated from the mesh.
 */
function overrides() {
  return {
    display: {
      glass: true,
      theme: resolvedTheme(),
      externalMeasurementBackend: true,
    },
    viewer: {},
  };
}

/** Draw the OCP logo into the empty viewer at startup.
 *
 * Two reasons, and the first is the important one:
 *
 * 1. The app is usable long before it is *warm*. The sidecar spends ~2.2 s
 *    importing OCP and the kernel another ~2 s on build123d, during which an
 *    empty grey pane reads as "broken". Something in the viewer from the first
 *    moment makes startup feel immediate whatever is still loading behind it.
 * 2. It pays the one-off WebGL cost - context creation, shader compilation,
 *    environment maps - here rather than on the user's first show(), which
 *    measured 713 ms cold against 28-70 ms warm.
 *
 * The splash itself is the core's: one logo for every viewer, described once.
 */
export function showLogo() {
  try {
    const started = performance.now();
    page.showSplash({ theme: resolvedTheme() });
    log.info(`Logo rendered in ${(performance.now() - started).toFixed(0)} ms`);
  } catch (error) {
    log.warn("Could not render the startup logo:", error);
  }
}

export function initViewer() {
  page = createPage({
    Viewer,
    Display,
    Timer,
    send,
    overrides: overrides(),
    theme: resolvedTheme(),
    // A pane, not a window: our own container, our own size, and no `window`
    // message or resize event to listen for - models arrive as binary frames
    // and the surface changes when a splitter moves.
    container: container(),
    getSize: paneSize,
    listen: false,
  });

  ipc.onBinary(ipc.KIND_MODEL, (payload, header, buffer, payloadOffset) => {
    const started = performance.now();
    // A model with no geometry is refused rather than drawn.
    //
    // three-cad-viewer does not come back from one: given a header describing
    // shapes and no buffers behind them, the window stopped responding and had
    // to be force-quit. The kernel no longer sends such a thing - `show()` of a
    // list of floats produced one - but a hang is not an acceptable response to
    // a bad frame from anywhere, and this is the only place that can refuse it.
    if (payload.byteLength === 0) {
      log.warn("Ignored a model with no geometry in it");
      return;
    }
    try {
      // The buffers are views straight onto the frame: the sidecar sends the
      // tessellation's arrays raw and this rebuilds the tree around them,
      // which is why nothing here copies or parses a number.
      const data = rehydrate(header.data, buffer, payloadOffset);
      // Instances are resolved here rather than by the renderer: its own
      // `decodeInstancedFormat` base64-decodes every instance first and would
      // throw on the typed arrays we already hold. 5.0.3 exports the two halves
      // separately for exactly this, and the second one takes the shapes tree
      // and the already-decoded instances - `resolveInstances(data)` with the
      // whole envelope silently produces a tree with no parts, which the page
      // then drops without a word.
      const shapes = resolveInstances(data.shapes, data.instances);
      if (!Array.isArray(shapes?.parts)) {
        // The page's own guard for this is silent, and a model that vanishes
        // between the socket and the canvas is the worst thing to debug.
        log.error("The tessellation has no parts in it; nothing was drawn");
        return;
      }
      page.handleMessage({
        type: "data",
        data: { shapes },
        config: header.config ?? {},
      });
      log.info(
        `Model rendered: ${header.count ?? "?"} shapes, ` +
          `${(payload.byteLength / 1024).toFixed(0)} kB, ` +
          `${(performance.now() - started).toFixed(0)} ms`,
      );
    } catch (error) {
      log.error("Could not render the model:", error);
    }
  });

  // Everything else the sidecar has for the viewer - a config block, a
  // measurement answer, a screenshot request, the animation clock - arrives as
  // one of the page's own messages, exactly as the other two page hosts deliver
  // theirs. One dispatch, so no host can quietly have a branch another lacks.
  ipc.on("viewer.message", (frame) => {
    try {
      page.handleMessage(frame.message);
    } catch (error) {
      log.error("Could not handle a viewer message:", error);
    }
  });

  onPaneResize(() => page.resize());

  // setTheme restyles the existing scene, so the model does not have to be
  // re-sent when the appearance changes.
  onThemeChange((theme) => page.setTheme(theme));
}
