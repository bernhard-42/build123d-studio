import { defineConfig } from "vite";

import { current as devBuild } from "./scripts/dev-build.mjs";

// Vite builds into resources/, which is Neutralino's documentRoot.
//
// emptyOutDir is deliberate: resources/.tmp holds the model payload files that
// the sidecar writes for the viewer to fetch, and a build should start from a
// clean slate. Static assets that must survive live in public/.
export default defineConfig(({ mode }) => ({
  root: ".",
  base: "./",
  publicDir: "public",
  // The local development build number, baked in so the About dialog can name
  // the exact build that is installed. Zero on a clean checkout - which is what
  // CI has - and versions.js turns that into no suffix at all, so a release
  // says 0.1.3 and only a locally packaged build says 0.1.3.dev17. See
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
