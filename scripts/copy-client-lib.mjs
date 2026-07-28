#!/usr/bin/env node
//
// Vite empties resources/ on every build, so the Neutralino client library has
// to be put back afterwards. The app itself imports @neutralinojs/lib as an ES
// module; this copy exists because the neu CLI expects the file named in
// neutralino.config.json's cli.clientLibrary to be present when it builds.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "node_modules", "@neutralinojs", "lib", "dist", "neutralino.js");
const TARGET_DIR = join(ROOT, "resources", "js");

if (!existsSync(SOURCE)) {
  console.error(`Neutralino client library not found at ${SOURCE} - run yarn install first.`);
  process.exit(1);
}

mkdirSync(TARGET_DIR, { recursive: true });
copyFileSync(SOURCE, join(TARGET_DIR, "neutralino.js"));
console.log("Copied neutralino.js into resources/js/");
