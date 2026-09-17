// Show, for a CAD file in the tree: its row menu's action.
//
// build123d has an importer for an STL, a STEP, a BREP, a DXF and an SVG, so
// Show runs that importer on the kernel and shows the result, echoed into the
// console - which is also the line a user copies into a script when the file
// is worth keeping. A click on the file still opens it, as a click does for
// everything in the tree: an SVG or a STEP is text, and sometimes the point
// is to edit it.
//
// The result is bound to `_imported` on purpose, and to nothing else. A name
// derived from the file would put every clicked file into the namespace for
// the rest of the session; one fixed underscore name is overwritten by the
// next click and is the user's to keep with `plate = _imported`.

const IMPORTERS = {
  stl: "import_stl",
  step: "import_step",
  stp: "import_step",
  brep: "import_brep",
  dxf: "import_dxf",
  svg: "import_svg",
};

/**
 * The importer for a path, by its extension, or null when the file is not one
 * of build123d's.
 *
 * @param {string} path
 * @returns {string|null} the build123d function name
 */
export function importerFor(path) {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  return IMPORTERS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * A Python string literal for the path.
 *
 * Double-quoted, with backslash and the quote escaped - the two characters
 * that mean something inside such a literal. Everything else, including
 * non-ASCII, is itself in a Python 3 source string. A raw string would read
 * better for a Windows path and cannot end in a backslash, so it is not used.
 *
 * @param {string} text
 */
export function pythonLiteral(text) {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The lines the kernel runs for a clicked CAD file, or null for any other file.
 *
 * Two, sent as two executes. The console shows a request once it is done, so
 * an announcement at the front of the import's own line stayed hidden for the
 * whole of a large STEP - measured. As a request of its own it completes at
 * once, and its echo - `In [n]: # Importing frame.step ...` - is on screen
 * while OCCT works on the second. A comment rather than a print, because the
 * echo already shows the text and a print showed it twice.
 *
 * @param {string} path
 * @returns {string[]|null}
 */
export function importCode(path) {
  const importer = importerFor(path);
  if (importer === null) {
    return null;
  }
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  // reset_camera: a file just clicked is a new model at an unknown size and
  // position, and the camera left over from the previous one would show a
  // corner of it, or nothing.
  return [
    `# Importing ${name} ...`,
    `from build123d import ${importer}; from build123d_studio import show, Camera; ` +
      `_imported = ${importer}(${pythonLiteral(path)}); show(_imported, reset_camera=Camera.RESET)`,
  ];
}
