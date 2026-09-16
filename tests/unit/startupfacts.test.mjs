// node --test tests/unit/startupfacts.test.mjs
//
// What the startup report selects and redacts. All of it only matters on a
// machine nobody here can reach, so the decisions are pure and pinned here.
//
// Proof, at writing: with the SECRET_NAME test removed from selectEnvironment,
// "a secret-looking name is reported by name only" fails with the token in the
// value; with the `_curlrc` name dropped from the Windows list, "Windows checks
// both spellings" fails on the missing entry.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  curlConfigCandidates,
  formatBytes,
  redactCredentials,
  selectEnvironment,
} from "../../src/bootstrap/startupfacts.js";

// --- environment selection ---

test("only the variables the bootstrap reads are selected, sorted by name", () => {
  const selected = selectEnvironment({
    SHELL: "/bin/zsh",
    HTTPS_PROXY: "http://proxy:8080",
    MY_APP_KEY: "x",
    UV_CACHE_DIR: "/tmp/uv",
    HOME: "/Users/me",
  });
  assert.deepEqual(selected, [
    ["HOME", "/Users/me"],
    ["HTTPS_PROXY", "http://proxy:8080"],
    ["UV_CACHE_DIR", "/tmp/uv"],
  ]);
});

test("names match case-insensitively, and both spellings of a proxy are kept", () => {
  const selected = selectEnvironment({ https_proxy: "a", HTTPS_PROXY: "b", SystemRoot: "C:\\WINDOWS" });
  assert.deepEqual(selected, [
    ["HTTPS_PROXY", "b"],
    ["https_proxy", "a"],
    ["SystemRoot", "C:\\WINDOWS"],
  ]);
});

test("a secret-looking name is reported by name only", () => {
  const selected = selectEnvironment({
    UV_PUBLISH_TOKEN: "pypi-AgEIcHlwaS5vcmc",
    UV_INDEX_CORP_PASSWORD: "hunter2",
    UV_INDEX_CORP_USERNAME: "me",
  });
  assert.deepEqual(selected, [
    ["UV_INDEX_CORP_PASSWORD", "<redacted>"],
    ["UV_INDEX_CORP_USERNAME", "me"],
    ["UV_PUBLISH_TOKEN", "<redacted>"],
  ]);
});

test("credentials inside a proxy URL are redacted, the host is kept", () => {
  assert.equal(
    redactCredentials("http://alice:s3cret@proxy.corp:8080"),
    "http://***@proxy.corp:8080",
  );
  assert.equal(redactCredentials("http://proxy.corp:8080"), "http://proxy.corp:8080");
  assert.equal(
    selectEnvironment({ ALL_PROXY: "socks5h://u:p@127.0.0.1:1080" })[0][1],
    "socks5h://***@127.0.0.1:1080",
  );
});

// --- bytes ---

test("bytes are shown in the unit a person would pick", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(7.8 * 1024 ** 3), "7.8 GB");
  assert.equal(formatBytes(250 * 1024 ** 3), "250 GB");
  assert.equal(formatBytes(-1), "?");
  assert.equal(formatBytes(undefined), "?");
});

// --- curl's config file ---

test("POSIX: CURL_HOME, then XDG, then HOME, in curl's documented order", () => {
  assert.deepEqual(
    curlConfigCandidates(
      "Darwin",
      { CURL_HOME: "/opt/curl", XDG_CONFIG_HOME: "/Users/me/.config", HOME: "/Users/me" },
      "/usr/bin",
    ),
    ["/opt/curl/.curlrc", "/Users/me/.config/curlrc", "/Users/me/.curlrc"],
  );
});

test("POSIX without the optional variables is just $HOME/.curlrc", () => {
  assert.deepEqual(curlConfigCandidates("Linux", { HOME: "/home/me" }, "/usr/bin"), [
    "/home/me/.curlrc",
  ]);
});

test("Windows checks both spellings at the profile, AppData, the legacy folder and beside curl.exe", () => {
  const envs = {
    USERPROFILE: "C:\\Users\\me",
    APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    SystemRoot: "C:\\WINDOWS",
  };
  assert.deepEqual(curlConfigCandidates("Windows", envs, "C:\\WINDOWS\\System32"), [
    "C:\\Users\\me\\.curlrc",
    "C:\\Users\\me\\_curlrc",
    "C:\\Users\\me\\AppData\\Roaming\\.curlrc",
    "C:\\Users\\me\\AppData\\Roaming\\_curlrc",
    "C:\\Users\\me\\Application Data\\.curlrc",
    "C:\\Users\\me\\Application Data\\_curlrc",
    "C:\\WINDOWS\\System32\\.curlrc",
    "C:\\WINDOWS\\System32\\_curlrc",
  ]);
});

test("Windows: a HOME set by a shell is honoured before the profile, and duplicates collapse", () => {
  const envs = { HOME: "C:\\Users\\me", USERPROFILE: "C:\\Users\\me" };
  const candidates = curlConfigCandidates("Windows", envs, "C:\\WINDOWS\\System32");
  assert.equal(candidates[0], "C:\\Users\\me\\.curlrc");
  assert.equal(candidates.filter((p) => p === "C:\\Users\\me\\.curlrc").length, 1);
});
