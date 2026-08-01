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
