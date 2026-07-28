import { filesystem } from "@neutralinojs/lib";

import { run, quote } from "../proc.js";
import { appendLog, setStatus } from "./splash.js";
import * as log from "../log.js";

// uv is downloaded on first start rather than bundled.
//
// Bundling cost 50 MB in every package - by far the largest thing in them - to
// ship a tool that goes stale. uv embeds the manifest of available CPython
// builds, so the uv we shipped bounds the newest Python a user can ever get:
// 0.11.29 tops out at CPython 3.14.6, and would keep installing that long after
// newer patch releases exist. Fetching the current uv means the interpreter
// tracks upstream without re-releasing the application.
//
// The application already cannot start without network - it downloads ~500 MB
// of wheels - so this adds no new class of failure, only one more step.
//
// Downloaded with curl rather than fetch(): the webview would need CORS
// permission from GitHub's asset host, which it does not grant. curl is present
// on macOS, on Linux, and on Windows 10 and later.
//
// Astral's own installer (`curl -LsSf https://astral.sh/uv/install.sh | sh`,
// or install.ps1 on Windows) would work too, and UV_UNMANAGED_INSTALL makes it
// install to a chosen directory without touching PATH. It is deliberately not
// used here. That script is built for a terminal - it writes a receipt,
// offers a self-updater, and edits shell profiles unless told not to, which is
// one wrong environment variable away from a GUI application silently
// rewriting someone's .zshrc. Fetching a named artifact and checking it
// against the SHA-256 published beside it keeps the file inert until we choose
// to run it, and needs one code path instead of two. The cost is that we would
// have to follow any change to Astral's release naming; that is a
// cargo-dist convention, and a break would fail loudly here on first start.

const REPOSITORY = "https://github.com/astral-sh/uv";
const RELEASE = `${REPOSITORY}/releases/latest/download`;
const ATTESTATIONS = "https://api.github.com/repos/astral-sh/uv/attestations";

// Our platform naming -> uv's release triple.
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

/**
 * Check the artifact's provenance against GitHub's attestation API.
 *
 * Stronger than the checksum alone. The .sha256 sits on the same release page
 * as the archive, so anyone able to replace one can replace the other; it
 * proves the download is intact, not where it came from. GitHub's attestation
 * records are not part of the release, and cannot be minted for a digest that
 * its build workflow never produced - so this is what catches a tampered
 * *release*, as opposed to a tampered download.
 *
 * `gh attestation verify` does this properly, checking the Sigstore signature
 * chain and the transparency log. It is not used because it would make the
 * GitHub CLI a hard dependency of first start, which almost nobody has. This
 * is weaker: it trusts api.github.com's answer rather than verifying the
 * bundle's signatures. That is the same trust already placed in github.com for
 * the archive itself, so it adds a real property without a new dependency -
 * but it is not full cryptographic verification, and is not claimed to be.
 *
 * @returns {Promise<"verified"|"unavailable"|"failed">}
 */
async function verifyProvenance(digest, archiveName, work) {
  const response = `${work}/attestation.json`;
  let status = "";
  const code = await run(
    `curl -sS -o ${quote(response)} -w '%{http_code}' ` +
      quote(`${ATTESTATIONS}/sha256:${digest}`),
    { onLine: (line) => (status += line.trim()) },
  );

  // Could not ask: offline, rate-limited (60/hour unauthenticated), or GitHub
  // having a bad day. Not evidence of anything, so not treated as failure.
  if (code !== 0 || status === "") {
    return "unavailable";
  }
  if (status === "404") {
    // GitHub has no provenance for this digest, yet it came from a release
    // page claiming to be uv. That is exactly the case worth stopping for.
    return "failed";
  }
  if (status !== "200") {
    log.warn(`Attestation lookup returned HTTP ${status}`);
    return "unavailable";
  }

  try {
    const body = JSON.parse(await filesystem.readFile(response));
    for (const attestation of body.attestations ?? []) {
      const payload = JSON.parse(atob(attestation.bundle.dsseEnvelope.payload));
      if (payload.predicateType !== "https://slsa.dev/provenance/v1") {
        continue;
      }
      const covers = (payload.subject ?? []).some(
        (s) => s.name === archiveName && s.digest?.sha256 === digest,
      );
      const workflow =
        payload.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
      if (covers && workflow.repository === REPOSITORY) {
        log.info(`Provenance: ${workflow.repository} ${workflow.path}`);
        return "verified";
      }
    }
  } catch (error) {
    log.warn("Could not read the attestation response:", error);
    return "unavailable";
  }
  // A response arrived and named neither our artifact nor uv's workflow.
  return "failed";
}

async function download(url, destination) {
  const code = await run(
    `curl -fsSL --retry 3 -o ${quote(destination)} ${quote(url)}`,
    { onLine: (line) => log.info("curl:", line) },
  );
  if (code !== 0) {
    throw new Error(`Download failed (curl exit ${code}): ${url}`);
  }
}

/** The version of an installed uv, or null if it cannot be asked. */
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

/** The newest published uv version, or null if GitHub cannot be asked. */
async function latestVersion(work) {
  const response = `${work}/release.json`;
  let status = "";
  const code = await run(
    `curl -sS -o ${quote(response)} -w '%{http_code}' ` +
      quote(`https://api.github.com/repos/astral-sh/uv/releases/latest`),
    { onLine: (line) => (status += line.trim()) },
  );
  if (code !== 0 || status !== "200") {
    return null;
  }
  try {
    const tag = JSON.parse(await filesystem.readFile(response)).tag_name ?? "";
    const match = tag.match(/\d+\.\d+\.\d+/);
    return match === null ? null : match[0];
  } catch {
    return null;
  }
}

/**
 * Make sure uv is available, fetching the current release if it is not.
 *
 * @param {string} envRoot
 * @param {{upgrade?: boolean}} options upgrade checks for a newer release and
 *   downloads only if there is one. "Upgrade packages" uses it, because a stale
 *   uv caps how new an interpreter the environment can ever get.
 * @returns {Promise<string>} path to the uv binary
 */
export async function ensureUv(envRoot, { upgrade = false } = {}) {
  const binary = uvPath(envRoot);
  const present = await exists(binary);

  if (present && !upgrade) {
    return binary;
  }

  if (present && upgrade) {
    // Around 50 MB, so it is worth one small request to find out whether the
    // download would change anything at all.
    //
    // When either version cannot be determined - offline, rate-limited, a uv
    // that will not report itself - the existing binary is kept rather than
    // re-fetched. Not knowing whether there is something newer is not a reason
    // to spend the bandwidth, and uv already works.
    const work = `${envRoot}/uv-download`;
    await filesystem.remove(work).catch(() => {});
    await filesystem.createDirectory(work);

    const [have, latest] = await Promise.all([
      installedVersion(binary),
      latestVersion(work),
    ]);
    await filesystem.remove(work).catch(() => {});

    if (have === null || latest === null) {
      log.info(`Keeping uv ${have ?? "(unknown version)"}: could not check for a newer release`);
      appendLog("uv: could not check for updates, keeping the current version");
      return binary;
    }
    if (have === latest) {
      log.info(`uv ${have} is already current`);
      appendLog(`uv ${have} is already the latest release`);
      return binary;
    }
    appendLog(`Updating uv ${have} to ${latest}`);
  }

  const key = platformKey();
  const triple = TRIPLES[key];
  const isWindows = NL_OS === "Windows";
  const archive = `uv-${triple}.${isWindows ? "zip" : "tar.gz"}`;

  setStatus("Fetching uv, the Python environment manager…");
  appendLog(`Downloading ${archive}`);

  const work = `${envRoot}/uv-download`;
  await filesystem.remove(work).catch(() => {});
  await filesystem.createDirectory(work);

  const archivePath = `${work}/${archive}`;
  await download(`${RELEASE}/${archive}`, archivePath);

  // Verify before doing anything with it: this binary is about to be executed,
  // and it is what installs everything else.
  await download(`${RELEASE}/${archive}.sha256`, `${archivePath}.sha256`);
  const expected = (await filesystem.readFile(`${archivePath}.sha256`)).trim().split(/\s+/)[0];
  const actual = await sha256(archivePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${archive}: expected ${expected}, got ${actual}`);
  }
  appendLog("Checksum verified");

  const provenance = await verifyProvenance(actual, archive, work);
  if (provenance === "failed") {
    // Deliberately fatal, and deliberately not falling back to the checksum:
    // the checksum already passed, so a failure here means the artifact is
    // intact but did not come from astral-sh/uv's release workflow.
    throw new Error(
      `Provenance verification failed for ${archive}. The download is intact but ` +
        "could not be attributed to astral-sh/uv's release workflow.",
    );
  }
  const note =
    provenance === "verified"
      ? "Provenance verified: built by astral-sh/uv's release workflow"
      : "Provenance not checked (GitHub's attestation API was unreachable)";
  appendLog(note);
  // Also to the log: which verification actually ran is worth being able to
  // answer after the fact, not only while the splash is on screen.
  log.info(note);

  // bsdtar handles both .tar.gz and .zip, and ships with Windows 10 and later.
  // The unix archives nest everything under uv-<triple>/; the zip does not.
  const extract = isWindows
    ? `tar -xf ${quote(archivePath)} -C ${quote(work)}`
    : `tar -xzf ${quote(archivePath)} -C ${quote(work)} --strip-components=1`;
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

  log.info("uv ready at", binary);
  return binary;
}
