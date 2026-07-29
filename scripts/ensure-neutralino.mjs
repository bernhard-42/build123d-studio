#!/usr/bin/env node
//
// Guarantee that bin/ holds exactly the Neutralino binaries this release is
// pinned to, fetching them if it does not.
//
//   node scripts/ensure-neutralino.mjs              # verify, download if needed
//   node scripts/ensure-neutralino.mjs --update 6.9.1   # move the pin
//
// These binaries become the application executable in every package. They used
// to arrive through a `postinstall: neu update` hook that downloaded them on
// every `yarn install` with no checksum and no signature, which made them the
// least verified input to the shipped product - while the uv binary beside them
// was checked against a digest committed to this repository.
//
// They are not committed: 14 MB now and another 14 MB on every version bump
// would sit in history for ever. The digests are committed instead, in
// scripts/neutralino-pin.json, and checked here before anything is built. That
// is the same guarantee as vendoring the bytes as long as this runs before the
// binaries are used and cannot be skipped, which is why package:build and start
// both begin with it rather than leaving it to a hook.
//
// Fails closed. A binary that is present but does not match is treated as
// suspect and replaced from the pinned release, and if the replacement does not
// match either, this exits non-zero rather than building with it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin");
const PIN_PATH = join(ROOT, "scripts", "neutralino-pin.json");
const REPOSITORY = "neutralinojs/neutralinojs";

const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
const updateIndex = process.argv.indexOf("--update");
const updating = updateIndex !== -1;
const version = updating ? process.argv[updateIndex + 1] : pin.version;

if (updating && (version === undefined || !/^\d+\.\d+\.\d+$/.test(version))) {
  throw new Error("--update needs a version, e.g. --update 6.9.1");
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Which pinned binaries are absent or do not match. */
function outOfDate() {
  return Object.entries(pin.binaries)
    .filter(([name, digest]) => {
      const path = join(BIN, name);
      if (!existsSync(path)) {
        return true;
      }
      if (sha256(path) === digest) {
        return false;
      }
      console.log(`  ${name}: present but does not match the pin - replacing`);
      return true;
    })
    .map(([name]) => name);
}

/**
 * The digest the releases API publishes for an asset.
 *
 * A different origin from the bytes themselves - api.github.com rather than the
 * release CDN - which is what makes it worth checking at all. Without it there
 * is nothing to compare a download against except itself.
 */
async function assetDigest(tag, name) {
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

/** Download the release zip, check it, and return the directory it unpacked to. */
async function fetchRelease(work) {
  const archive = `neutralinojs-v${version}.zip`;
  const zip = join(work, archive);

  // On an update there is no recorded digest yet, so the API is the only second
  // source and a failure to reach it is fatal.
  //
  // On a normal run the committed digest is authoritative and the downloaded
  // bytes are checked against it below, so the API call is a cross-check rather
  // than the check. It must not be able to fail the build: bin/ is gitignored,
  // so every CI job re-fetches, unauthenticated api.github.com is 60 requests
  // an hour per source IP, and Actions egress addresses are shared - one 403
  // would take out all four packaging jobs for a reason that has nothing to do
  // with the artifact. A disagreement is still worth saying out loud.
  let expected = pin.archiveSha256;
  if (updating) {
    expected = await assetDigest(`v${version}`, archive);
  } else {
    try {
      const published = await assetDigest(`v${version}`, archive);
      if (published !== expected) {
        throw new Error(
          `The release asset no longer matches the pin:\n  pinned ${expected}\n  API    ${published}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The release asset")) {
        throw error;
      }
      console.log(`  (could not cross-check against the releases API: ${error.message})`);
    }
  }

  console.log(`  downloading ${archive}`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", zip,
    `https://github.com/${REPOSITORY}/releases/download/v${version}/${archive}`]);

  const actual = sha256(zip);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${archive}:\n  expected ${expected}\n  got      ${actual}`);
  }
  console.log(`  archive verified: ${actual}`);

  execFileSync("tar", ["-xf", zip, "-C", work]);
  return work;
}

const missing = updating ? Object.keys(pin.binaries) : outOfDate();

if (missing.length === 0) {
  console.log(`Neutralino ${pin.version}: all ${Object.keys(pin.binaries).length} binaries verified`);
  process.exit(0);
}

console.log(
  updating
    ? `Moving the Neutralino pin to v${version}`
    : `Fetching ${missing.length} Neutralino binar${missing.length === 1 ? "y" : "ies"} for v${version}`,
);

const work = mkdtempSync(join(tmpdir(), "neutralino-"));
try {
  await fetchRelease(work);
  mkdirSync(BIN, { recursive: true });

  const digests = { ...pin.binaries };
  for (const name of missing) {
    const found = [join(work, "bin", name), join(work, name)].find(existsSync);
    if (found === undefined) {
      throw new Error(`neutralinojs-v${version}.zip does not contain ${name}`);
    }
    copyFileSync(found, join(BIN, name));
    const digest = sha256(join(BIN, name));

    if (updating) {
      const previous = pin.binaries[name];
      console.log(`  ${previous === digest ? "unchanged" : "updated  "} ${name}`);
      if (previous !== digest) {
        console.log(`      ${previous ?? "(new)"}\n   -> ${digest}`);
      }
      digests[name] = digest;
    } else if (digest !== pin.binaries[name]) {
      // The archive matched its published digest and still produced a binary
      // that is not the pinned one: the pin and the release disagree, which is
      // not something to build through.
      throw new Error(
        `${name} from the verified archive does not match the pin:\n` +
        `  pinned ${pin.binaries[name]}\n  got    ${digest}`,
      );
    } else {
      console.log(`  verified ${name}`);
    }
  }

  if (updating) {
    writeFileSync(
      PIN_PATH,
      `${JSON.stringify(
        { ...pin, version, recorded: new Date().toISOString().slice(0, 10),
          archiveSha256: sha256(join(work, `neutralinojs-v${version}.zip`)), binaries: digests },
        null, 2,
      )}\n`,
    );
    console.log(`\nWrote ${PIN_PATH}. Set cli.binaryVersion and cli.clientVersion in`);
    console.log("neutralino.config.json, bump @neutralinojs/lib to match, run the");
    console.log("application, then commit the pin with those changes.");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
