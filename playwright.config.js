import { defineConfig, devices } from "@playwright/test";

// The frontend suite runs on WebKit, and that is the whole reason it exists.
//
// Two of Phase 4's defects were engine-specific and neither is reachable in
// Chromium or in jsdom: `▸` and `▾` have no glyph in WKWebView and render as a
// dot, and esbuild deleted the `-webkit-user-select` that WKWebView is the one
// engine to honour. A suite that could not see those would be a suite for a
// browser this application never runs in.
//
// Playwright's webkit is the same engine family as the macOS and Linux
// webviews - WKWebView and WebKitGTK. Windows uses WebView2, which is Chromium,
// and adding that project here later is one entry rather than a second harness.
export default defineConfig({
  testDir: "tests/frontend",
  testMatch: /.*\.spec\.mjs/,
  // The suite drives one application through a real engine; parallel pages
  // compete for CPU and turn a layout assertion into a timing one.
  workers: 1,
  fullyParallel: false,
  // A retry hides exactly the flake this suite exists to catch. Anything that
  // needs one is a defect in the test or in the application, and both want
  // finding rather than smoothing over.
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4177",
    // Kept only for a failure: a passing run should say nothing and cost
    // nothing, and a failing one should be openable without being reproduced.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  webServer: {
    // The built test bundle, served over http rather than opened as a file://.
    // The application's own CSP names `ws://127.0.0.1:*` and `'self'`, and a
    // file:// origin satisfies neither - the sidecar socket would be refused by
    // the policy the application actually ships.
    // --host 127.0.0.1 is not cosmetic: vite preview otherwise binds IPv6
    // localhost only, and both Playwright's readiness probe and the
    // application's own CSP - which names ws://127.0.0.1:* - speak in the v4
    // literal. Without it the server starts and nothing can reach it.
    command:
      "npx vite preview --config vite.config.test.js --host 127.0.0.1 --port 4177 --strictPort",
    url: "http://127.0.0.1:4177",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
