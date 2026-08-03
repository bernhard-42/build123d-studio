import { defineConfig } from "vite";

import { current as devBuild } from "./scripts/dev-build.mjs";

// Vite builds into resources/, which is Neutralino's documentRoot.
//
// emptyOutDir is deliberate: a build should start from a clean slate rather
// than layering over whatever the last one left. Static assets that must
// survive live in public/.
//
// It used to say resources/.tmp held model payload files for the viewer to
// fetch. That design is gone - a model is one binary WebSocket frame now, and
// nothing is written to disk for it.
export default defineConfig(({ mode }) => ({
  root: ".",
  base: "./",
  publicDir: "public",
  // The local development build number, baked in so the About dialog can name
  // the exact build that is installed. Zero on a clean checkout - which is what
  // CI has - and versions.js turns that into no suffix at all, so a release
  // carries the plain version and only a locally packaged build gets .devN. See
  // scripts/dev-build.mjs.
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild()),
  },
  build: {
    outDir: "resources",
    emptyOutDir: true,
    target: "esnext",
    // CSS is minified for a much older engine than the JavaScript is compiled
    // for, and the difference is deliberate.
    //
    // "esnext" tells esbuild the engine supports everything, so it removes
    // vendor prefixes it considers redundant. That silently deleted the
    // `-webkit-user-select: none` beside a plain `user-select: none` - and the
    // prefixed one is the one WKWebView actually honours, so the rule stopped
    // working in the packaged application while remaining correct in the source.
    // Nothing about the symptom pointed at the bundler.
    //
    // The JavaScript target can stay at esnext because this only ever runs in a
    // system webview modern enough to load the app at all. CSS prefixes are a
    // different question: an engine can support a property and still want the
    // prefix, and the three platforms' webviews do not agree about which.
    cssTarget: ["safari14", "chrome90", "firefox90"],
    // Monaco's sourcemap alone is ~10 MB, which would dwarf the app in a
    // shipped bundle. Keep them for development, drop them for release.
    sourcemap: mode !== "production",
    chunkSizeWarningLimit: 4096,
  },
  server: {
    // Neutralino serves the built output itself; the Vite dev server is unused.
    // `yarn dev` runs `vite build --watch` instead.
    hmr: false,
  },
}));
