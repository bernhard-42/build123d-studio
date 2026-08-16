// The viewer settings this application persists, and what they are called.
//
// One schema, taken key for key from OCP CAD Viewer for VS Code's own
// `OcpCadViewer.view.*` and `OcpCadViewer.render.*` sections, because a viewer
// setting means the same thing in every host and a user moving between them
// should not have to learn a second vocabulary. The names are the wire names -
// the same ones `show(...)` takes as keywords - so what is written here can be
// read against the viewer's own documentation.
//
// **Only what the user changed is stored**, exactly as VS Code's settings.json
// keeps only what differs from a package.json default. What is *answered* is a
// different matter: `workspace_config()` reports the whole set, defaults
// included, because it is the top layer of the merge and a key left out of it
// is not "use the default" - it is a key three-cad-viewer never hears about, so
// whatever the viewer already holds survives. After startup that is the splash
// logo's own configuration, which is precisely how it went wrong.
//
// `theme` is deliberately not here: it is the application's own setting, since
// it paints the editor and the panes as well as the viewer, so it stays at the
// top level and this tab merely shows its control.

// The defaults are read from the file `kernel/build123d_studio/` ships, and are
// not written down here as well. Both halves of this application need them and
// neither may own them: this file draws the dialog, and the transport answers
// `workspace_config()` with the *whole* set - every host does, because a key
// left out is not a default but a key the renderer never hears about. Two
// copies of 36 numbers would drift, and they would drift silently.
// The import attribute is required by node, which runs the tests; vite and
// esbuild take it too.
import DEFAULTS from "../kernel/build123d_studio/viewer_defaults.json" with { type: "json" };

/** Where a value is stored in settings.json. */
export const STORAGE_KEY = "viewer";

// Rendered in this order, in these groups. The grouping is this application's;
// the keys, types and defaults are not.
export const GROUPS = [
  {
    id: "layout",
    label: "Layout and tree",
    settings: [
      { key: "glass", type: "boolean",
        label: "Glass mode (the tree floats over the canvas)" },
      { key: "tools", type: "boolean", label: "Show the toolbar" },
      { key: "tree_width", type: "integer", min: 100, max: 800,
        label: "Tree width" },
      { key: "collapse", type: "enum",
        options: ["none", "leaves", "all", "root"],
        label: "Tree collapsed to" },
      { key: "new_tree_behavior", type: "boolean",
        label: "New tree behaviour" },
    ],
  },
  {
    id: "camera",
    label: "Camera and controls",
    settings: [
      { key: "reset_camera", type: "enum",
        options: ["RESET", "KEEP", "CENTER", "ISO", "TOP", "BOTTOM",
                  "LEFT", "RIGHT", "FRONT", "BACK"],
        label: "On a new model" },
      { key: "ortho", type: "boolean", label: "Orthographic camera" },
      { key: "up", type: "enum", options: ["Z", "Y"], label: "Up axis" },
      { key: "orbit_control", type: "boolean",
        label: "Orbit control (off is trackball)" },
      { key: "rotate_speed", type: "number", min: 0.1, max: 10, step: 0.1,
        label: "Rotate speed" },
      { key: "zoom_speed", type: "number", min: 0.1, max: 10, step: 0.1,
        label: "Zoom speed" },
      { key: "pan_speed", type: "number", min: 0.1, max: 10, step: 0.1,
        label: "Pan speed" },
      { key: "modifier_keys", type: "keymap", label: "Modifier keys" },
    ],
  },
  {
    id: "grid",
    label: "Grid and axes",
    settings: [
      { key: "axes", type: "boolean", label: "Axes" },
      { key: "axes0", type: "boolean", label: "Axes at the origin" },
      { key: "grid_XY", type: "boolean", label: "Grid XY" },
      { key: "grid_XZ", type: "boolean", label: "Grid XZ" },
      { key: "grid_YZ", type: "boolean", label: "Grid YZ" },
      { key: "center_grid", type: "boolean", label: "Centre the grid" },
      { key: "grid_font_size", type: "number", min: 4, max: 48,
        label: "Grid font size" },
      { key: "ticks", type: "number", min: 2, max: 50, label: "Ticks" },
    ],
  },
  {
    id: "objects",
    label: "Objects",
    settings: [
      { key: "black_edges", type: "boolean", label: "Black edges" },
      { key: "transparent", type: "boolean", label: "Transparent" },
      { key: "default_opacity", type: "number", min: 0, max: 1, step: 0.05,
        label: "Opacity when transparent" },
      { key: "explode", type: "boolean", label: "Explode" },
    ],
  },
  {
    id: "render",
    label: "Rendering",
    settings: [
      { key: "deviation", type: "number", min: 0.01, max: 10, step: 0.01,
        label: "Deviation" },
      { key: "angular_tolerance", type: "number", min: 0.01, max: 10, step: 0.01,
        label: "Angular tolerance" },
      { key: "ambient_intensity", type: "number", min: 0, max: 5, step: 0.05,
        label: "Ambient intensity" },
      { key: "direct_intensity", type: "number", min: 0, max: 5, step: 0.05,
        label: "Direct intensity" },
      { key: "metalness", type: "number", min: 0, max: 1, step: 0.05,
        label: "Metalness" },
      { key: "roughness", type: "number", min: 0, max: 1, step: 0.05,
        label: "Roughness" },
      // Colours are text, not a colour picker: two of the defaults are CSS
      // names rather than hex, and the viewer takes either - `Color(...)`
      // resolves both. A picker would silently rewrite "MediumOrchid" as
      // "#ba55d3" the first time the dialog opened.
      { key: "default_color", type: "color", label: "Default colour" },
      { key: "default_edgecolor", type: "color", label: "Edge colour" },
      { key: "default_thickedgecolor", type: "color",
        label: "Thick edge colour" },
      { key: "default_facecolor", type: "color", label: "Face colour" },
      { key: "default_vertexcolor", type: "color",
        label: "Vertex colour" },
    ],
  },
];

// Each entry takes its default from the shared file, rather than carrying one.
// A key the file does not know would otherwise be a control with no default,
// silently storing whatever was typed into it; the schema test refuses that.
for (const group of GROUPS) {
  for (const setting of group.settings) {
    setting.default = DEFAULTS[setting.key];
  }
}

/** Every setting, flat, in the order the dialog shows them. */
export const SETTINGS = GROUPS.flatMap((group) => group.settings);

/** The modifier a key can be bound to. */
export const MODIFIERS = ["shiftKey", "ctrlKey", "metaKey", "altKey"];

const BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]));

/** The schema entry for a key, or null when nothing declares it. */
export function settingFor(key) {
  return BY_KEY.get(key) ?? null;
}

/** What a viewer does when nothing has been set. For display only. */
export function defaults() {
  return Object.fromEntries(SETTINGS.map((s) => [s.key, clone(s.default)]));
}

function clone(value) {
  return value !== null && typeof value === "object" ? { ...value } : value;
}

function same(a, b) {
  if (a !== null && typeof a === "object" && b !== null && typeof b === "object") {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
    );
  }
  return a === b;
}

/**
 * The stored values, with anything unrecognised or equal to the default dropped.
 *
 * Dropping the defaults is what makes "unset" mean "the viewer decides": a key
 * that is stored is a key this application asserts, and asserting a value that
 * happens to match today's default would pin it if that default ever moved.
 */
export function toStore(values) {
  const stored = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const setting = BY_KEY.get(key);
    if (setting === undefined || value === undefined || value === null) {
      continue;
    }
    if (!same(value, setting.default)) {
      stored[key] = value;
    }
  }
  return stored;
}

/** What the dialog shows: the defaults, with whatever was stored laid over. */
export function withDefaults(stored) {
  const values = defaults();
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (BY_KEY.has(key)) {
      values[key] = value;
    }
  }
  return values;
}

/**
 * A typed value from what a control produced, or null when it is not usable.
 *
 * Null rather than a default, so a caller can tell "the user cleared it" from
 * "the user typed something that is not a number" - the first leaves the key
 * unset and the second must not be written at all.
 */
export function parseValue(key, raw) {
  const setting = BY_KEY.get(key);
  if (setting === undefined) {
    return null;
  }
  if (setting.type === "boolean") {
    return raw === true || raw === "true";
  }
  if (setting.type === "number" || setting.type === "integer") {
    const parsed = setting.type === "integer" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    if (setting.min !== undefined && parsed < setting.min) {
      return setting.min;
    }
    if (setting.max !== undefined && parsed > setting.max) {
      return setting.max;
    }
    return parsed;
  }
  if (setting.type === "enum") {
    return setting.options.includes(raw) ? raw : null;
  }
  if (setting.type === "color") {
    const text = typeof raw === "string" ? raw.trim() : "";
    return text === "" ? null : text;
  }
  if (setting.type === "keymap") {
    if (raw === null || typeof raw !== "object") {
      return null;
    }
    const map = {};
    for (const [name, modifier] of Object.entries(raw)) {
      if (MODIFIERS.includes(modifier)) {
        map[name] = modifier;
      }
    }
    return Object.keys(map).length === 0 ? null : map;
  }
  return null;
}
