// Frontend component versions, taken from package.json at build time.
//
// Read from the manifest rather than hard-coded, so the About dialog cannot
// drift from what is actually bundled. The dependencies are exact pins, so
// these are exact versions rather than ranges.

import manifest from "../package.json";

export const appVersion = manifest.version;
export const monacoVersion = manifest.dependencies["monaco-editor"];
export const xtermVersion = manifest.dependencies["@xterm/xterm"];
