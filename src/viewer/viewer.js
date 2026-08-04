import { Display, Viewer } from "three-cad-viewer";
// The package exposes its stylesheet as the "./css" export, not by dist path.
import "three-cad-viewer/css";

import { logo } from "./logo.js";
import { rehydrate, resolveInstances } from "./rehydrate.js";
import { onPaneResize } from "../layout/splitter.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";
import { onThemeChange, resolvedTheme } from "../theme.js";

// The viewer pane.
//
// The option plumbing is ported from ocp_vscode's templates/viewer.html, which
// is where the mapping from a show() config to three-cad-viewer's render and
// viewer options is defined. What is *not* ported is its comms layer: the model
// arrives here as one binary frame, and the notification callback goes back
// over the same socket instead of vscode.postMessage.

const SNAKE_TO_CAMEL = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// Keys whose camelCase form is not what three-cad-viewer calls them.
const KEY_OVERRIDES = {
  default_edgecolor: "edgeColor",
  clip_planes: "clipPlaneHelpers",
  studio_4k_env_maps: "studio4kEnvMaps",
};

// prettier-ignore
const RENDER_KEYS = [
  "ambient_intensity", "direct_intensity", "metalness", "roughness",
  "default_edgecolor", "default_opacity", "normal_len",
];

// prettier-ignore
const VIEWER_KEYS = [
  "axes", "axes0", "black_edges", "grid", "collapse", "ortho", "ticks",
  "center_grid", "grid_font_size", "timeit", "tools", "glass", "up",
  "transparent", "control", "pan_speed", "zoom_speed", "rotate_speed",
  "clip_slider_0", "clip_slider_1", "clip_slider_2",
  "clip_normal_0", "clip_normal_1", "clip_normal_2",
  "clip_intersection", "clip_planes", "clip_object_colors",
  "zebra_count", "zebra_opacity", "zebra_direction",
  "zebra_color_scheme", "zebra_mapping_mode",
  "studio_environment", "studio_env_intensity", "studio_env_rotation",
  "studio_background", "studio_tone_mapping", "studio_exposure",
  "studio_shadow_intensity", "studio_shadow_softness", "studio_ao_intensity",
  "studio_texture_mapping", "studio_4k_env_maps",
];

let display = null;
let viewer = null;
let lastConfig = {};

function container() {
  return document.getElementById("pane-viewer");
}

function paneSize() {
  const rect = container().getBoundingClientRect();
  return { width: Math.max(rect.width, 100), height: Math.max(rect.height, 100) };
}

function pick(config, key, fallback) {
  const value = config[key];
  return value === undefined || value === null ? fallback : value;
}

// Canvas sizing, following ocp_vscode's viewer.html: the tree only takes width
// when it is docked (in glass mode it floats over the canvas), and the viewer
// draws its own toolbar row above the canvas, which the height must leave room
// for. The difference here is that the measurements come from the pane rather
// than from window.innerWidth/innerHeight.
const MIN_CAD_WIDTH = 250;
const MIN_CAD_HEIGHT = 150;
// Fallback only, for the first layout before the toolbar exists in the DOM.
const ASSUMED_TOOLBAR_HEIGHT = 65;
const WIDTH_MARGIN = 20;

function normalizeWidth(width, glass, tools, treeWidth) {
  const reserved = glass || !tools ? 0 : treeWidth;
  return Math.max(MIN_CAD_WIDTH - reserved, width - reserved - WIDTH_MARGIN);
}

/**
 * Height above the canvas that must come out of the pane.
 *
 * This is the canvas's own top offset, not the toolbar's height. Measuring the
 * toolbar alone (38 px) left the canvas overflowing the pane by 10 px - the
 * toolbar's 6 px offset plus a 4 px gap - which pushed the status line, pinned
 * to `bottom: 4px` inside the canvas, below the pane's clip. ocp_vscode's
 * hard-coded 65 px avoided the clipping but over-reserved, showing up as a
 * bottom margin visibly larger than the left and top ones.
 *
 * Taking the offset directly makes the canvas end exactly at the pane's edge
 * whatever the toolbar does.
 */
function reservedHeight() {
  const canvas = container().querySelector(".tcv_cad_view_glass, .tcv_cad_view");
  if (canvas !== null) {
    const offset = canvas.getBoundingClientRect().top - container().getBoundingClientRect().top;
    if (offset > 0) {
      return Math.round(offset);
    }
  }
  // Before the canvas exists, approximate from the toolbar if it is there.
  const toolbar = container().querySelector(".tcv_cad_toolbar");
  if (toolbar !== null && toolbar.offsetHeight > 0) {
    return toolbar.offsetHeight + 10;
  }
  return ASSUMED_TOOLBAR_HEIGHT;
}

function normalizeHeight(height) {
  return Math.max(MIN_CAD_HEIGHT, height - reservedHeight());
}

function displayOptions(config) {
  const size = paneSize();
  const glass = pick(config, "glass", true);
  const tools = pick(config, "tools", true);
  const treeWidth = pick(config, "tree_width", 240);

  return {
    glass,
    tools,
    treeWidth,
    cadWidth: normalizeWidth(size.width, glass, tools, treeWidth),
    height: normalizeHeight(size.height),
    theme: pick(config, "theme", resolvedTheme()),
    keymap: pick(config, "modifier_keys", undefined),
    measureTools: true,
    selectTool: true,
    explodeTool: true,
    // Off by default - the z-scale slider overlays the bottom-right of the
    // canvas permanently, which costs more room in a pane than it does in a
    // full window. Overridable per show() with zscale_tool=True.
    zscaleTool: pick(config, "zscale_tool", false),
    zebraTool: true,
    // Distances and properties are computed by the real kernel geometry in the
    // sidecar, not estimated from the mesh.
    externalMeasurementBackend: true,
  };
}

function mapOptions(config, keys) {
  const options = {};
  for (const key of keys) {
    const value = config[key];
    if (value === undefined || value === null) {
      continue;
    }
    options[KEY_OVERRIDES[key] ?? SNAKE_TO_CAMEL(key)] = value;
  }
  return options;
}

/**
 * Notification callback: the viewer reports UI changes here.
 *
 * Selections drive measurement - the sidecar answers with exact values computed
 * from the BRep, so this is the path that makes the measure tools truthful
 * rather than mesh approximations.
 */
function notify(change) {
  if (!ipc.isConnected()) {
    return;
  }

  // The viewer reports changes as {key: {new, old}}; the backend wants plain
  // values, so flatten exactly as ocp_vscode's nc() does.
  //
  // Only this notification's keys are sent, not an accumulated snapshot.
  // ocp_vscode's viewer.html keeps a running message object, which means a
  // stale selectedShapeIDs rides along with every unrelated change and the
  // backend re-measures a selection the user made minutes ago. Sending the
  // delta is enough: activated_tool is sticky on the backend side.
  const changes = {};
  let changed = false;
  for (const [key, value] of Object.entries(change)) {
    if (value !== null && value !== undefined && value.new !== undefined) {
      changes[key] = value.new;
      changed = true;
    }
  }
  if (!changed) {
    return;
  }

  try {
    ipc.send("viewer.changes", { changes });
  } catch (error) {
    log.warn("Could not forward viewer changes:", error);
  }
}

function showModel(shapes, config) {
  const options = displayOptions(config);

  if (display === null) {
    container().innerHTML = "";
    display = new Display(container(), options);
  }

  if (viewer === null) {
    viewer = new Viewer(display, options, notify, null);
  } else {
    // clear() tears the scene down but keeps the WebGL context, viewer state
    // and environment cache alive, so repeated show() calls stay cheap.
    viewer.clear();
  }

  const renderOptions = mapOptions(config, RENDER_KEYS);
  const viewerOptions = mapOptions(config, VIEWER_KEYS);

  const resetCamera = pick(config, "reset_camera", "keep");
  if (resetCamera === "reset") {
    viewerOptions.zoom = pick(config, "zoom", 1.0);
    if (config.position !== undefined) viewerOptions.position = config.position;
    if (config.quaternion !== undefined) viewerOptions.quaternion = config.quaternion;
    if (config.target !== undefined) viewerOptions.target = config.target;
  }

  viewer.render(shapes, renderOptions, viewerOptions);
  viewer.glassMode(options.glass);
  viewer.showTools(options.tools);

  // The first layout is computed before the toolbar exists, so it uses the
  // assumed height. Now that it is in the DOM, re-fit against the real one.
  fitToPane();
}

/** Resize the canvas to the current pane, measuring the toolbar as it is now. */
function fitToPane() {
  if (viewer === null) {
    return;
  }
  const options = displayOptions(lastConfig);
  viewer.resizeCadView(options.cadWidth, options.treeWidth, options.height, options.glass);
  probeGeometry();
}

/**
 * Report where the viewer's parts actually landed inside the pane.
 *
 * Sizing here is a chain of assumptions - which chrome is inside the canvas
 * container, which is a sibling, what the library reserves - and guessing at it
 * has already produced both a too-large bottom margin and a clipped status
 * line. Measuring is cheap and makes the next adjustment factual.
 */
function probeGeometry() {
  const pane = container().getBoundingClientRect();
  const report = { pane: Math.round(pane.height) };
  for (const [name, selector] of [
    ["toolbar", ".tcv_cad_toolbar"],
    ["canvas", ".tcv_cad_view_glass, .tcv_cad_view"],
    ["status", ".tcv_status_line"],
  ]) {
    const element = container().querySelector(selector);
    if (element === null) {
      report[name] = null;
      continue;
    }
    const rect = element.getBoundingClientRect();
    report[name] = {
      top: Math.round(rect.top - pane.top),
      bottom: Math.round(rect.bottom - pane.top),
      height: Math.round(rect.height),
    };
  }
  if (report.canvas === null) {
    return;
  }
  report.overflowBelowPane = report.canvas.bottom - report.pane;

  // Silent when it fits. A canvas taller than its pane is what clips the status
  // line, and a shorter one is the dead margin at the bottom - both were real,
  // and neither is obvious without numbers. One pixel of rounding is fine.
  if (Math.abs(report.overflowBelowPane) > 1) {
    log.warn("viewer canvas does not fit its pane", report);
  }
}

/**
 * Draw the OCP logo into the empty viewer at startup.
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
 * The logo data is in the instanced base64 format, which three-cad-viewer
 * decodes itself, so it goes to render() untouched rather than through the
 * zero-copy path used for real models.
 */
export function showLogo() {
  try {
    const { data, config } = logo();
    const started = performance.now();
    // Recorded like any other model's, so a pane resize before the first real
    // show() re-fits against what is actually on screen rather than against {}.
    lastConfig = config ?? {};
    showModel(data, lastConfig);
    log.info(`Logo rendered in ${(performance.now() - started).toFixed(0)} ms`);
  } catch (error) {
    log.warn("Could not render the startup logo:", error);
  }
}

export function initViewer() {
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
      const data = rehydrate(header.data, buffer, payloadOffset);
      const shapes = resolveInstances(data);
      lastConfig = header.config ?? {};
      showModel(shapes, lastConfig);
      log.info(
        `Model rendered: ${header.count ?? "?"} shapes, ` +
          `${(payload.byteLength / 1024).toFixed(0)} kB, ` +
          `${(performance.now() - started).toFixed(0)} ms`,
      );
    } catch (error) {
      log.error("Could not render the model:", error);
    }
  });

  // Measurement answers from the sidecar's ViewerBackend.
  ipc.on("viewer.response", (frame) => {
    if (viewer !== null) {
      viewer.handleBackendResponse(frame.response);
    }
  });

  onPaneResize(fitToPane);

  // setTheme restyles the existing scene, so the model does not have to be
  // re-sent when the appearance changes.
  onThemeChange((theme) => {
    lastConfig = { ...lastConfig, theme };
    if (viewer !== null) {
      viewer.setTheme(theme);
    }
  });
}
