// What a startup report needs to say about the machine, chosen so that a
// failure on somebody else's computer can be read from the log alone.
//
// Pure: the selection of environment variables, the redaction, the byte
// formatting and curl's config-file search are all decisions that only ever
// matter on a machine nobody here can reach, which is exactly why they are
// testable functions rather than code inside the calls that gather them.

/**
 * Environment variables that steer the bootstrap, matched case-insensitively.
 *
 * Windows environment names are case-insensitive and curl reads the proxy
 * family in both spellings on every platform, so `https_proxy` and
 * `HTTPS_PROXY` are the same question. The list is what curl, uv, Python and
 * this application read - nothing else, because an environment is full of
 * things that are none of a bug report's business.
 */
export const ENVIRONMENT_NAMES = [
  // curl: proxies, certificates and where its config file may be
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "curl_home",
  "curl_ca_bundle",
  "ssl_cert_file",
  "ssl_cert_dir",
  "xdg_config_home",
  // where the environment and the settings go
  "home",
  "userprofile",
  "appdata",
  "localappdata",
  "systemroot",
  "comspec",
  "temp",
  "tmp",
  "tmpdir",
  "path",
  // a Python already active in the session, which uv notices
  "virtual_env",
  "conda_prefix",
  // an x64 build running under emulation shows up here, not in NL_ARCH
  "processor_architecture",
  "processor_architew6432",
  "lang",
  "lc_all",
];

/** Name prefixes taken whole, for the families with too many members to list. */
export const ENVIRONMENT_PREFIXES = ["uv_", "python", "build123d_studio_"];

// A name that says it holds a secret is reported by name only. UV_PUBLISH_TOKEN
// and UV_INDEX_<name>_PASSWORD are real members of a family the prefixes take.
const SECRET_NAME = /token|secret|password|passwd|credential|api[_-]?key|auth/i;

// Credentials inside a URL - `https://user:pass@proxy:8080` is how a proxy is
// commonly configured - are replaced before the value reaches the log.
const URL_CREDENTIALS = /(\w+:\/\/)[^/@\s]+@/g;

/**
 * Replace `user:password@` in any URL within the value.
 *
 * @param {string} value
 * @returns {string}
 */
export function redactCredentials(value) {
  return value.replace(URL_CREDENTIALS, "$1***@");
}

/**
 * The variables worth logging, as `[name, value]` pairs sorted by name, with
 * secrets redacted.
 *
 * @param {Record<string, string>} envs everything os.getEnvs() returned
 * @returns {Array<[string, string]>}
 */
export function selectEnvironment(envs) {
  const wanted = new Set(ENVIRONMENT_NAMES);
  const selected = [];
  for (const [name, value] of Object.entries(envs)) {
    const lower = name.toLowerCase();
    const listed = wanted.has(lower) || ENVIRONMENT_PREFIXES.some((p) => lower.startsWith(p));
    if (!listed) {
      continue;
    }
    const shown = SECRET_NAME.test(name) ? "<redacted>" : redactCredentials(String(value));
    selected.push([name, shown]);
  }
  // Case-insensitive so the two spellings of a proxy sit together, then by
  // code point so the order does not depend on the locale.
  selected.sort((a, b) => {
    const [x, y] = [a[0].toLowerCase(), b[0].toLowerCase()];
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    return a[0] < b[0] ? -1 : 1;
  });
  return selected;
}

/**
 * Bytes as a number a person reads at a glance: "7.8 GB", "512 MB".
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "?";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Where curl looks for a default config file, in its documented order.
 *
 * From `man curl`, -K/--config: `$CURL_HOME/.curlrc`, `$XDG_CONFIG_HOME/curlrc`,
 * `$HOME/.curlrc`, then on Windows `%USERPROFILE%\.curlrc`, `%APPDATA%\.curlrc`,
 * `%USERPROFILE%\Application Data\.curlrc` and finally the directory holding
 * curl.exe - with `_curlrc` checked beside `.curlrc` at every Windows location.
 *
 * That file applies to every curl the machine runs, this application's
 * download included: a `proto` line in one is a download that fails with
 * "Protocol https is disabled" and nothing on this side to explain it.
 *
 * @param {string} platform NL_OS: "Windows", "Darwin" or "Linux"
 * @param {Record<string, string>} envs
 * @param {string} curlDir directory holding the curl binary
 * @returns {string[]} candidate paths, in curl's order
 */
export function curlConfigCandidates(platform, envs, curlDir) {
  const env = (name) => {
    for (const [key, value] of Object.entries(envs)) {
      if (key.toLowerCase() === name && typeof value === "string" && value !== "") {
        return value;
      }
    }
    return null;
  };
  const windows = platform === "Windows";
  const sep = windows ? "\\" : "/";
  const names = windows ? [".curlrc", "_curlrc"] : [".curlrc"];

  const candidates = [];
  const seen = new Set();
  const add = (path) => {
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  };
  const addDir = (dir) => {
    if (dir !== null) {
      for (const name of names) {
        add(`${dir}${sep}${name}`);
      }
    }
  };

  addDir(env("curl_home"));
  const xdg = env("xdg_config_home");
  if (xdg !== null) {
    add(`${xdg}${sep}curlrc`);
  }
  addDir(env("home"));
  if (windows) {
    const profile = env("userprofile");
    addDir(profile);
    addDir(env("appdata"));
    addDir(profile === null ? null : `${profile}${sep}Application Data`);
    addDir(curlDir);
  }
  return candidates;
}
