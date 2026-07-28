import { defineConfig } from "vite";

// Vite builds into resources/, which is Neutralino's documentRoot.
//
// emptyOutDir is deliberate: resources/.tmp holds the model payload files that
// the sidecar writes for the viewer to fetch, and a build should start from a
// clean slate. Static assets that must survive live in public/.
export default defineConfig(({ mode }) => ({
  root: ".",
  base: "./",
  publicDir: "public",
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
