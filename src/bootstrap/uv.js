import { filesystem, os } from "@neutralinojs/lib";

import pins from "./pins.json";
import { run, quote } from "../proc.js";
import { appendLog, setStatus } from "./splash.js";
import * as log from "../log.js";

// uv is downloaded on first start rather than bundled, and pinned to one exact
// release per build123d Studio release.
//
// Not bundled: it is 50 MB in every package, for a tool that has to be fetched
// on some platforms anyway.
//
// Pinned rather than "latest": a release of this application is a support
// target. When uv floated, two people running the same build123d Studio could
// have different uv versions and different CPython builds depending only on
// what was current the day each of them first started it - and "0.11.33 was
// published this morning" is not something a bug report ever mentions. A new
// uv now needs a new build123d Studio release, which is also when it gets
// tested.
//
// The checksums live in pins.json and are checked on every install. That is a
// stronger anchor than the .sha256 files uv publishes: those sit on the same
// release page as the archives, so whoever could replace one could replace the
// other - they prove the download is intact, not that it is the artifact this
// application was tested against. A digest committed to this repository is a
// statement we control.
//
// Provenance is verified once, when the pin is recorded, by a maintainer
// running gh attestation verify - not here. Doing it at runtime meant an
// unauthenticated GitHub API call on the first-start path that had to fail open
// when the API was unreachable or rate-limited, which made the strength of the
// check depend on the network. Verifying at pin time puts a human and a real
// Sigstore signature chain in the loop instead, and leaves this path with no
// network dependency beyond the download itself.
//
// Downloaded with curl rather than fetch(): the webview would need CORS
// permission from GitHub's asset host, which it does not grant. curl is present
// on macOS, on Linux, and on Windows 10 and later.
//
// Astral's own installer (`curl -LsSf https://astral.sh/uv/install.sh | sh`, or
// install.ps1 on Windows) would work too, and UV_UNMANAGED_INSTALL makes it
// install to a chosen directory without touching PATH. It is deliberately not
// used here. That script is built for a terminal - it writes a receipt, offers
// a self-updater, and edits shell profiles unless told not to, which is one
// wrong environment variable away from a GUI application silently rewriting
// someone's .zshrc. Fetching a named artifact and checking it against a digest
// we committed keeps the file inert until we choose to run it.

const REPOSITORY = "https://github.com/astral-sh/uv";

// Our platform naming -> uv's release triple. The same keys index
// pins.uv.artifacts, so a platform without a recorded checksum fails loudly
// rather than installing something unverified.
const TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

function platformKey() {
  const arch = NL_ARCH === "arm64" || NL_ARCH === "arm" ? "arm64" : "x64";
  switch (NL_OS) {
    case "Darwin":
      return `darwin-${arch}`;
    case "Linux":
      return `linux-${arch}`;
    case "Windows":
      return "win32-x64";
    default:
      throw new Error(`Unsupported platform: ${NL_OS}`);
  }
}

function uvPath(envRoot) {
  return NL_OS === "Windows" ? `${envRoot}/uv/uv.exe` : `${envRoot}/uv/uv`;
}

async function exists(path) {
  try {
    await filesystem.getStats(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const bytes = await filesystem.readBinaryFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Resolved once per session.
let tools = null;

/**
 * Absolute paths for curl and tar, rather than whatever PATH offers.
 *
 * This is a GUI process: its PATH comes from the desktop session, which on a
 * developer's machine routinely includes directories the user can write to. A
 * curl planted in one of those would run inside the application - and it is the
 * program that fetches the binary that then installs everything else, so it is
 * the last place to accept whatever happens to be first on PATH.
 *
 * macOS and Windows both ship these at a known location. Linux distributions
 * vary enough that a bare name is the honest fallback there; it is still an
 * improvement, because the absolute path wins when it exists.
 */
async function systemTools() {
  if (tools !== null) {
    return tools;
  }

  if (NL_OS === "Windows") {
    // Both have shipped in System32 since Windows 10 1803.
    let root = "C:\\Windows";
    try {
      const value = await os.getEnv("SystemRoot");
      if (typeof value === "string" && value !== "") {
        root = value;
      }
    } catch {
      // Not readable; the default is right on any normal installation.
    }
    tools = { curl: `${root}\\System32\\curl.exe`, tar: `${root}\\System32\\tar.exe` };
    return tools;
  }

  const resolved = {};
  for (const name of ["curl", "tar"]) {
    const absolute = `/usr/bin/${name}`;
    resolved[name] = (await exists(absolute)) ? absolute : name;
    if (resolved[name] === name) {
      log.warn(`${absolute} is missing; falling back to ${name} from PATH`);
    }
  }
  tools = resolved;
  return tools;
}

async function download(url, destination) {
  const { curl } = await systemTools();
  const code = await run(
    `${quote(curl)} -fsSL --retry 3 -o ${quote(destination)} ${quote(url)}`,
    { onLine: (line) => log.info("curl:", line) },
  );
  if (code !== 0) {
    throw new Error(`Download failed (curl exit ${code}): ${url}`);
  }
}

/**
 * The version of an installed uv, or null if it cannot be asked.
 *
 * This is a staleness check, not an integrity check: the environment root
 * survives replacing the application, so a user who updates build123d Studio
 * keeps the uv their previous version installed until it is noticed here. What
 * proves a uv is the right one is the checksum, and that is verified when it is
 * downloaded. Anything able to substitute the binary afterwards could equally
 * substitute the interpreter or the venv beside it, so re-hashing 38 MB on
 * every start would buy an assurance the rest of the tree does not have.
 */
async function installedVersion(binary) {
  let output = "";
  const code = await run(`${quote(binary)} --version`, {
    onLine: (line) => (output += `${line} `),
  });
  if (code !== 0) {
    return null;
  }
  const match = output.match(/\d+\.\d+\.\d+/);
  return match === null ? null : match[0];
}

/**
 * Make sure the pinned uv is installed, fetching it if it is not.
 *
 * There is no upgrade mode. uv moves when pins.json moves, which is a rebuild
 * of the application - see the note in pins.json. "Upgrade packages" therefore
 * upgrades packages, and nothing else.
 *
 * @param {string} envRoot
 * @returns {Promise<string>} path to the uv binary
 */
export async function ensureUv(envRoot) {
  const binary = uvPath(envRoot);
  const wanted = pins.uv.version;

  if (await exists(binary)) {
    const have = await installedVersion(binary);
    if (have === wanted) {
      return binary;
    }
    log.info(`Installed uv is ${have ?? "unreadable"}; this release pins ${wanted}`);
    appendLog(`Replacing uv ${have ?? "(unreadable)"} with the pinned ${wanted}`);
  }

  const triple = TRIPLES[platformKey()];
  const expected = pins.uv.artifacts[triple];
  if (expected === undefined) {
    // A platform we build for but never recorded a checksum for. Refusing is
    // the only safe answer: the alternative is running an unverified binary
    // that then installs everything else.
    throw new Error(`No uv checksum is pinned for ${triple}; cannot verify the download`);
  }

  const isWindows = NL_OS === "Windows";
  const archive = `uv-${triple}.${isWindows ? "zip" : "tar.gz"}`;

  setStatus("Fetching uv, the Python environment manager…");
  appendLog(`Downloading ${archive} (uv ${wanted})`);

  const work = `${envRoot}/uv-download`;
  await filesystem.remove(work).catch(() => {});
  await filesystem.createDirectory(work);

  const archivePath = `${work}/${archive}`;
  await download(`${REPOSITORY}/releases/download/${wanted}/${archive}`, archivePath);

  // Verified before anything is done with it: this binary is about to be
  // executed, and it is what installs everything else.
  const actual = await sha256(archivePath);
  if (actual !== expected) {
    await filesystem.remove(work).catch(() => {});
    throw new Error(
      `Checksum mismatch for ${archive}: expected ${expected}, got ${actual}. ` +
        "The download does not match the uv this version of build123d Studio was built against.",
    );
  }
  appendLog(`Checksum verified against the pinned uv ${wanted}`);
  log.info(`uv ${wanted} verified against the pinned checksum for ${triple}`);

  // bsdtar handles both .tar.gz and .zip, and ships with Windows 10 and later.
  // The unix archives nest everything under uv-<triple>/; the zip does not.
  const { tar } = await systemTools();
  const extract = isWindows
    ? `${quote(tar)} -xf ${quote(archivePath)} -C ${quote(work)}`
    : `${quote(tar)} -xzf ${quote(archivePath)} -C ${quote(work)} --strip-components=1`;
  const code = await run(extract, { onLine: appendLog });
  if (code !== 0) {
    throw new Error(`Could not extract ${archive} (tar exit ${code})`);
  }

  await filesystem.createDirectory(`${envRoot}/uv`).catch(() => {});
  await filesystem.remove(binary).catch(() => {});
  await filesystem.move(`${work}/${isWindows ? "uv.exe" : "uv"}`, binary);
  if (!isWindows) {
    // ADD rather than REPLACE: we only need the execute bits, and REPLACE would
    // mean spelling out every permission correctly.
    await filesystem.setPermissions(
      binary,
      { ownerExec: true, groupExec: true, othersExec: true },
      "ADD",
    );
  }
  await filesystem.remove(work).catch(() => {});

  log.info(`uv ${wanted} ready at`, binary);
  return binary;
}
