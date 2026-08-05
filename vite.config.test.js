import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config.js";

// The application, built for a browser instead of for a webview.
//
// Two aliases and nothing else. Everything the suite is about - main.js, the
// panes, Monaco, the real stylesheet through the real cssTarget - is the
// shipped code, compiled by the shipped bundler with the shipped options. That
// is the whole point: a harness that rebuilt the application differently would
// answer questions about the harness.
//
// It must not write into resources/. That directory is Neutralino's
// documentRoot and `emptyOutDir` is true, so building the test bundle over it
// would leave the packaged application replaced by one wired to a stub - and
// the next `neu run` would look like a very confusing bug.
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** Swap one module for another, matched after resolution rather than before.
 *
 * `resolve.alias` matches the specifier a file wrote, not the file it means, so
 * an entry keyed on an absolute path silently matches nothing - the real
 * bootstrap ran and the harness sat watching the splash try to download uv. A
 * relative specifier cannot be aliased reliably either, because "./bootstrap/
 * setup.js" means a different file depending on who wrote it.
 *
 * Resolving first and comparing the answer is the only version that says what
 * it means. It throws when the target does not exist, so a rename turns into a
 * failed build rather than a harness quietly running the real thing.
 */
function replaceModule(targetPath, replacementPath) {
  const target = here(targetPath);
  const replacement = here(replacementPath);
  return {
    name: `harness-replace:${targetPath}`,
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved !== null && resolved.id === target ? replacement : null;
    },
  };
}

export default defineConfig((env) =>
  mergeConfig(typeof base === "function" ? base(env) : base, {
    plugins: [replaceModule("./src/bootstrap/setup.js", "./tests/frontend/stubs/setup.js")],
    resolve: {
      alias: {
        // A bare specifier, so an alias is exactly the right tool for this one.
        "@neutralinojs/lib": here("./tests/frontend/stubs/neutralino.js"),
      },
    },
    build: {
      outDir: "tests/frontend/build",
      emptyOutDir: true,
      // The suite reads stack traces when something throws inside a pane, and a
      // minified one names nothing. Costs disk in a directory that is ignored.
      sourcemap: true,
      minify: false,
    },
  }),
);
