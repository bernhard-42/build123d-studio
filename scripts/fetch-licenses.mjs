#!/usr/bin/env node
//
// Regenerate THIRD_PARTY_LICENSES.md.
//
// Every package build123d Studio ships redistributes third-party code, and both
// MIT and Apache-2.0 require the copyright notice and licence text to travel
// with the binary. Most of it is npm dependencies, which yarn can enumerate;
// the rest are binaries and assets yarn knows nothing about - uv, the
// Neutralino runtime, and the Material Symbols subset - so they are fetched
// here by hand.
//
// Note what is *absent*: the Python packages. build123d, OCP and the rest are
// downloaded into the user's own environment at first start, so they are never
// redistributed by us. That matters beyond tidiness - OCCT, underneath
// cadquery-ocp, is LGPL, and bundling it would bring relinking and
// source-offer obligations that installing it at runtime does not.
//
//   node scripts/fetch-licenses.mjs

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Bundled, but not npm packages.
const EXTRAS = [
  {
    name: "uv",
    holder: "Astral Software Inc.",
    what: "Shipped as a binary in bin/. Creates and manages the Python environment.",
    licence: "Dual-licensed Apache-2.0 OR MIT; used here under the MIT licence.",
    url: "https://raw.githubusercontent.com/astral-sh/uv/main/LICENSE-MIT",
  },
  {
    name: "Neutralino.js",
    holder: "Neutralinojs",
    what: "The application binary and its runtime.",
    licence: "MIT",
    url: "https://raw.githubusercontent.com/neutralinojs/neutralinojs/main/LICENSE",
  },
  {
    name: "Material Symbols",
    holder: "Google LLC",
    what:
      "A subset of the Material Symbols Outlined variable font, containing only " +
      "the toolbar's glyphs (see scripts/fetch-icons.mjs).",
    licence: "Apache-2.0",
    url: "https://raw.githubusercontent.com/google/material-design-icons/master/LICENSE",
  },
];

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.text()).trimEnd();
}

console.log("Collecting third-party licences");

const sections = [];
for (const item of EXTRAS) {
  process.stdout.write(`  ${item.name}… `);
  const text = await fetchText(item.url);
  console.log("ok");
  sections.push(
    `## ${item.name}\n\n` +
      `${item.what}\n\n` +
      `Copyright © ${item.holder}. ${item.licence}\n\n` +
      "```\n" + text + "\n```\n",
  );
}

process.stdout.write("  npm dependencies… ");
const npm = execSync("yarn licenses generate-disclaimer --production", {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
}).trim();
console.log("ok");

const document = `# Third-party licences

build123d Studio is Apache-2.0; see LICENSE. The components below are
redistributed inside each package and carry their own terms.

The Python packages the application installs - build123d, OCP, ocp_vscode and
the rest - are **not** included here. They are downloaded into your own
environment on first start and are never redistributed by this project.

${sections.join("\n")}
## Bundled npm packages

${npm}
`;

writeFileSync(join(ROOT, "THIRD_PARTY_LICENSES.md"), document);
console.log(`\n  wrote THIRD_PARTY_LICENSES.md (${(document.length / 1024).toFixed(0)} kB)`);
