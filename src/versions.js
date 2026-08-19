// Frontend component versions, taken from package.json at build time.
//
// Read from the manifest rather than hard-coded, so the About dialog cannot
// drift from what is actually bundled. The dependencies are exact pins, so
// these are exact versions rather than ranges.

// Named imports rather than the whole manifest: a default import pulls the
// entire package.json into the bundle, and it was shipping "scripts" and
// "devDependencies" - the build commands and the toolchain - to every user, for
// the sake of three strings.
import { version, dependencies } from "../package.json";

/**
 * The version, with a development build number when there is one.
 *
 * Every locally packaged build increments it, so an installed application can
 * be named exactly - "0.2.0.dev17 is the one" - instead of two builds of one
 * version being indistinguishable once they are in /Applications. A release has
 * no counter file to read, so it carries the plain version; see
 * scripts/dev-build.mjs.
 *
 * `.devN` rather than `+N` or `-devN` deliberately: it is what a Python
 * developer reads without being told, and this application's users are Python
 * developers.
 */
export const devBuild = __DEV_BUILD__;
export const appVersion = devBuild === 0 ? version : `${version}.dev${devBuild}`;
export const monacoVersion = dependencies["monaco-editor"];
export const xtermVersion = dependencies["@xterm/xterm"];
// From the manifest rather than from the package: unlike three-cad-viewer, the
// core exports no version of its own. This is the JavaScript half of it - the
// page and the renderer - and the Python half is reported separately in Key
// packages, because they are two distributions and can be at two versions.
export const coreVersion = dependencies["ocp-viewer-core"];
