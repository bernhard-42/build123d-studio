#!/usr/bin/env node
//
// Move the uv pin, or re-check the one that is recorded.
//
//   node scripts/pin-uv.mjs                 # verify the recorded pin
//   node scripts/pin-uv.mjs --update 0.11.34   # move it
//   node scripts/pin-uv.mjs --update 0.11.34 --python 3.14.7
//
// src/bootstrap/pins.json has said "run scripts/pin-uv.mjs - it re-derives
// every checksum and verifies provenance before rewriting this file. Do not
// edit the digests by hand" since the pin was first recorded, and this script
// did not exist. So the rule had no enforcement and the provenance check was a
// maintainer remembering to run gh by hand - which is exactly the kind of
// promise that is true on the day it is written and unfalsifiable afterwards.
//
// The checksums here are the trust anchor for a binary that is downloaded on
// first start, executed, and used to install everything else. That is why they
// are committed rather than fetched: uv publishes .sha256 files beside its
// archives, but they sit on the same release page as the archives, so whoever
// could replace one could replace the other. They prove a download is intact,
// not that it is the artifact this application was built against.
//
// What raises this above "we wrote down a hash" is `gh attestation verify`: a
// Sigstore signature chain and a transparency log entry, checked against
// astral-sh/uv's own release workflow. Deliberately here rather than at
// runtime - as an install-time check it was an unauthenticated GitHub API call
// on the first-start path that had to fail open when the API was unreachable
// or rate-limited, so its strength depended on the user's network. Done once,
// by a person, on a machine that can fail closed, it is worth something.
//
// Fails closed everywhere. Nothing is written unless every artifact downloads,
// matches what the releases API publishes, and verifies.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIN_PATH = join(ROOT, "src", "bootstrap", "pins.json");
const REPOSITORY = "astral-sh/uv";

// The platforms this application builds for. Every one needs a checksum,
// because uv.js refuses to run a download it cannot verify - so a missing entry
// is not a smaller pin, it is a platform that cannot start. This list and
// TRIPLES in src/bootstrap/uv.js have to agree.
const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
];

const archiveFor = (triple) =>
  `uv-${triple}.${triple.includes("windows") ? "zip" : "tar.gz"}`;

const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));

const updateIndex = process.argv.indexOf("--update");
const updating = updateIndex !== -1;
const version = updating ? process.argv[updateIndex + 1] : pin.uv.version;
if (updating && (version === undefined || !/^\d+\.\d+\.\d+$/.test(version))) {
  throw new Error("--update needs a version, for example: --update 0.11.34");
}

const pythonIndex = process.argv.indexOf("--python");
const python = pythonIndex === -1 ? pin.python : process.argv[pythonIndex + 1];
if (!/^\d+\.\d+\.\d+$/.test(python ?? "")) {
  throw new Error("--python needs an exact version, for example: --python 3.14.7");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The digest the releases API publishes for an asset.
 *
 * A second source for the same bytes: the API response comes from GitHub's
 * metadata rather than from the release CDN, so a tampered or intercepted
 * download is caught by comparing them. Without it there is nothing to check a
 * download against except itself.
 *
 * Fatal when it cannot be reached, unlike the equivalent in
 * ensure-neutralino.mjs. That one runs on every build, including in CI where an
 * unauthenticated rate limit is shared across jobs, so it degrades to a warning;
 * this runs when a maintainer moves a pin, and a check that quietly does not
 * happen is worse than one that stops.
 */
async function publishedDigest(tag, name) {
  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`Could not read release ${tag}: ${response.status} ${response.statusText}`);
  }
  const asset = (await response.json()).assets.find((a) => a.name === name);
  if (asset === undefined) {
    throw new Error(`Release ${tag} has no asset named ${name}`);
  }
  if (typeof asset.digest !== "string") {
    throw new Error(`The API publishes no digest for ${name}; refusing to use it`);
  }
  return asset.digest.replace(/^sha256:/, "");
}

/**
 * Verify one artifact's build provenance with the GitHub CLI.
 *
 * `gh attestation verify` checks a Sigstore bundle: the signature chain back to
 * Fulcio, the transparency log entry, and that the signing identity is a GitHub
 * Actions workflow in astral-sh/uv. That is the claim this whole file rests on
 * - not "the bytes are unchanged since I downloaded them", but "these bytes
 * came out of uv's release pipeline".
 *
 * gh is required rather than optional. This runs on a maintainer's machine, by
 * hand, and the alternative to failing here is recording a pin whose provenance
 * nobody checked - which is the state this script was written to end.
 */
function verifyProvenance(path, name) {
  try {
    const output = execFileSync(
      "gh",
      ["attestation", "verify", path, "--repo", REPOSITORY, "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const results = JSON.parse(output);
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error("gh reported no attestations");
    }
    // Reported so the recorded evidence names something specific rather than
    // "verified": the signing workflow is the part a reader would want to check.
    const signer = results[0]?.verificationResult?.signature?.certificate ?? {};
    return {
      count: results.length,
      workflow: signer.buildSignerURI ?? signer.sourceRepositoryURI ?? "(not reported)",
      issuer: signer.issuer ?? "(not reported)",
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "gh is not installed. Provenance is the point of this script, so there is " +
          "no --skip: install the GitHub CLI (https://cli.github.com) and run it again.",
      );
    }
    const detail = error.stderr?.toString().trim() ?? error.message;
    throw new Error(`Provenance verification failed for ${name}:\n${detail}`);
  }
}

const work = mkdtempSync(join(tmpdir(), "pin-uv-"));
const digests = {};
const evidence = [];

try {
  console.log(
    updating
      ? `Moving the uv pin to ${version}${python === pin.python ? "" : `, Python to ${python}`}`
      : `Re-checking the recorded uv pin ${version}`,
  );

  for (const triple of TARGETS) {
    const archive = archiveFor(triple);
    const path = join(work, archive);
    process.stdout.write(`  ${archive} … `);

    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", path,
      `https://github.com/${REPOSITORY}/releases/download/${version}/${archive}`]);

    const actual = sha256(path);
    const published = await publishedDigest(version, archive);
    if (actual !== published) {
      throw new Error(
        `\n${archive} does not match the digest the API publishes:\n` +
          `  downloaded ${actual}\n  API        ${published}`,
      );
    }

    // On a re-check the committed value is the thing being tested, so a
    // mismatch is the finding rather than a reason to rewrite the file.
    if (!updating) {
      const recorded = pin.uv.artifacts[triple];
      if (recorded !== actual) {
        throw new Error(
          `\n${archive} does not match the pin in pins.json:\n` +
            `  pinned     ${recorded ?? "(absent)"}\n  downloaded ${actual}`,
        );
      }
    }

    const provenance = verifyProvenance(path, archive);
    digests[triple] = actual;
    evidence.push(`${archive}: ${provenance.count} attestation(s), ${provenance.workflow}`);
    console.log(`ok  ${actual.slice(0, 12)}…`);
  }

  if (!updating) {
    console.log(`\nuv ${version}: all ${TARGETS.length} artifacts match the pin and verify.`);
    process.exit(0);
  }

  const recorded = new Date().toISOString().slice(0, 10);
  const updated = {
    ...pin,
    python,
    uv: { version, recorded, artifacts: digests },
  };
  // The comment block is data in this file, and it carries the provenance
  // record. Rewriting it here is what keeps that record true rather than a
  // description of a check somebody once ran against different bytes.
  updated._comment = pin._comment
    .slice(0, pin._comment.findIndex((line) => line.startsWith("Provenance of the values")))
    .concat([
      `Provenance of the values below, verified ${recorded} by scripts/pin-uv.mjs:`,
      `  gh attestation verify <artifact> --repo ${REPOSITORY}`,
      ...evidence.map((line) => `    ${line}`),
      "  Every artifact additionally matched the digest published by the releases",
      "  API, which is a different origin from the release CDN it was fetched from.",
    ]);

  // Blank lines between the top-level keys, which JSON.stringify does not keep
  // and which are most of what makes this file readable: the comment block is
  // twenty lines long, and without them the two values it is about are buried
  // in it. Re-inserted rather than left out, because a security anchor that
  // nobody can skim is one nobody reviews.
  const text = `${JSON.stringify(updated, null, 2)}\n`.replace(
    /^(\s*)"(python|uv)":/gm,
    "\n$1\"$2\":",
  );
  writeFileSync(PIN_PATH, text);
  console.log(`\nRewrote ${PIN_PATH}`);
  console.log("Review the diff, then commit it as a deliberate change of support target.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
