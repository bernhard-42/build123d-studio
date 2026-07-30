// Correctness linting, deliberately not style.
//
// This exists because of one defect, twice. `log.info(...)` was called in
// proc.js without importing the module, and it shipped: Vite treats an unknown
// bare identifier as a global and says nothing, so the failure was a runtime
// "log is not defined" in a build that had already been packaged and run. The
// sidecar produced the same class of bug in Python a day later - a name
// referenced before it was assigned, inside the iopub pump, where the handler's
// own except swallowed it and the variable explorer just quietly stopped
// updating.
//
// So the rule that matters here is no-undef, and the globals below are what
// makes it useful: an environment declared too broadly turns it back off. There
// is no stylistic configuration on purpose - formatting is not what has cost
// this project anything, and a rule nobody agreed to is a rule that gets
// disabled.

const browser = {
  // Neutralino injects these into the page before any of our code runs. They
  // are the reason a bare identifier cannot simply be assumed to be a mistake,
  // and the reason they have to be listed rather than inferred.
  NL_OS: "readonly",
  NL_ARCH: "readonly",
  NL_PORT: "readonly",
  NL_PATH: "readonly",
  NL_TOKEN: "readonly",
  NL_ARGS: "readonly",
  NL_VERSION: "readonly",
  NL_CVERSION: "readonly",

  window: "readonly",
  // Monaco's worker entry point is configured through it, which is the only
  // place this appears.
  self: "readonly",
  document: "readonly",
  console: "readonly",
  navigator: "readonly",
  location: "readonly",
  fetch: "readonly",
  WebSocket: "readonly",
  Worker: "readonly",
  Blob: "readonly",
  URL: "readonly",
  FileReader: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  ResizeObserver: "readonly",
  MutationObserver: "readonly",
  IntersectionObserver: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  queueMicrotask: "readonly",
  performance: "readonly",
  getComputedStyle: "readonly",
  matchMedia: "readonly",
  CustomEvent: "readonly",
  Event: "readonly",
  Image: "readonly",
  HTMLElement: "readonly",
  DOMParser: "readonly",
  XMLSerializer: "readonly",
  crypto: "readonly",
  btoa: "readonly",
  atob: "readonly",
  structuredClone: "readonly",
};

const node = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  fetch: "readonly",
};

// Shared by every block: unused names are the other half of the same mistake -
// an import that survived the code that used it, or an argument that quietly
// changed meaning. Errors are allowed to be caught and ignored, which this
// codebase does deliberately and comments each time, so a bare `catch {}` and an
// unused caught binding are both fine.
const rules = {
  "no-undef": "error",
  "no-unused-vars": [
    "error",
    { args: "after-used", caughtErrors: "none", ignoreRestSiblings: true },
  ],
  // Two that are always a bug rather than a preference.
  "no-const-assign": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-self-compare": "error",
  // The project rule about explicit comparisons, as far as a linter can carry
  // it: == and != coerce, and every comparison here is meant to be exact.
  eqeqeq: ["error", "always"],
};

export default [
  {
    ignores: ["resources/**", "dist/**", "release/**", "node_modules/**", "bin/**", "runtime/**"],
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: browser,
    },
    rules,
  },
  {
    // Build and packaging tooling, plus the tests, all of which run under Node.
    files: ["scripts/**/*.mjs", "*.config.js", "src/**/*.test.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: node,
    },
    rules,
  },
];
