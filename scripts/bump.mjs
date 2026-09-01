// Write the version into the two files that have to agree.
//
// package.json is what versions.js reads for the About dialog, and
// neutralino.config.json is what the Neutralino CLI stamps into the packaged
// binary's metadata - on Windows that is what the Properties dialog shows. They
// have always been bumped together by hand, and by hand is how they would
// eventually disagree.
//
// Both are rewritten with a targeted replacement rather than by parsing and
// re-serialising: JSON.stringify would reformat the whole file, and a version
// bump whose diff is the entire manifest hides what actually changed.
//
// .dev-build is deliberately untouched. It is monotonic and gitignored - the
// point is to name one build unambiguously, and a counter that restarted would
// produce two 0.4.2.dev1s.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The version lives in three files that must agree. package.json is what the
// About dialog reads, neutralino.config.json is what the CLI stamps into the
// packaged binary's metadata, and runtime/pyproject.toml carries it so the
// application can tell that an environment was built by an earlier release -
// see spliceRelease. The third is TOML, so the needle differs; see write().
const FILES = ["package.json", "neutralino.config.json", "runtime/pyproject.toml"];
const SEMVER = /^\d+\.\d+\.\d+$/;

/** The next version, given the current one and which part to move. */
export function nextVersion(current, part) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (part === "major") {
    return `${major + 1}.0.0`;
  }
  if (part === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (part === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  return null;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

function currentVersion() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return manifest.version;
}

/**
 * Replace the one version line, and refuse if it is not there.
 *
 * JSON writes `"version": "x"`, TOML writes `version = "x"`. Refusing unless
 * there is exactly one match is what makes the difference safe to encode as a
 * suffix check: a needle that matched nothing would leave that file behind at
 * the old version, silently, which is the whole failure this guards against.
 */
function write(file, from, to) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  const toml = file.endsWith(".toml");
  const needle = toml ? `version = "${from}"` : `"version": "${from}"`;
  const found = text.split(needle).length - 1;
  if (found !== 1) {
    throw new Error(`${file}: expected one ${needle}, found ${found}`);
  }
  writeFileSync(path, text.replace(needle, toml ? `version = "${to}"` : `"version": "${to}"`));
}

/** Run only when invoked, so importing this for its arithmetic costs nothing. */
function main() {
  const current = currentVersion();
  const part = argument("part");
  const explicit = argument("version");

  const next = explicit === null ? nextVersion(current, part) : explicit;
  if (next === null || !SEMVER.test(next)) {
    console.error(
      explicit === null
        ? `Unknown part "${part}". Use major, minor or patch.`
        : `Not a version: "${explicit}". Use x.y.z.`,
    );
    process.exit(2);
  }
  if (next === current) {
    console.error(`Already at ${current}.`);
    process.exit(2);
  }

  for (const file of FILES) {
    write(file, current, next);
  }
  console.log(`${current} -> ${next}   (${FILES.join(", ")})`);
}

// Compared as URLs, because argv[1] is a path and import.meta.url is not - and
// a string compare between the two is false on every platform.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
