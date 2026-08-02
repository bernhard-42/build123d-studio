// Regenerate the application icons from logo.svg.
//
// package.mjs has always said these are "regenerated from logo.svg together",
// and until now nothing did it: the PNGs were exported by hand and the claim was
// documentation of an intention. That is the same shape as the pin tool that
// pins.json named before it existed, and it goes wrong the same way - the logo
// changes, the icons do not, and nobody notices until an icon looks stale in the
// Dock.
//
// ## No inset is applied here, because the source already carries one
//
// logo.svg is a 1024 canvas with a 102 px transparent margin, which is Apple's
// icon grid: the artwork occupies the middle and every icon in the Dock leaves
// the same border. An earlier version of this script rendered the body at 824
// and padded it back to 1024, which was right when the logo was drawn
// full-bleed and is wrong now - it would apply the margin twice and the icon
// would sit visibly smaller than its neighbours instead of larger.
//
// So both PNGs are the same straight render, and they stay two files because
// they are consumed for different things and may yet want to differ: the .icns
// is built from appIconMac.png, while appIcon.png is the window icon and the
// Linux .desktop icon, neither of which applies a grid of its own.
//
// sips does the rendering and is part of macOS, so this adds no dependency. It
// was picked over rsvg-convert, which is also on this machine but rendered the
// logo without an alpha channel - an icon with a white box behind it.
//
// macOS only, deliberately: it shells out to sips, the output is committed, and
// the one machine that has to run it is whichever one changes the logo. CI
// consumes the PNGs and never builds them.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "logo.svg");
const ICONS = join(ROOT, "public", "icons");

const CANVAS = 1024;

function main() {
  if (process.platform !== "darwin") {
    console.error("build-icons needs macOS: it renders through sips.");
    console.error("The generated PNGs are committed, so only a logo change needs this.");
    process.exit(2);
  }
  if (!existsSync(SOURCE)) {
    console.error(`No logo at ${SOURCE}`);
    process.exit(1);
  }

  mkdirSync(ICONS, { recursive: true });

  const mac = join(ICONS, "appIconMac.png");
  execFileSync(
    "sips",
    ["-s", "format", "png", "-Z", String(CANVAS), SOURCE, "--out", mac],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  copyFileSync(mac, join(ICONS, "appIcon.png"));

  console.log(`appIcon.png     ${CANVAS}x${CANVAS}`);
  console.log(`appIconMac.png  ${CANVAS}x${CANVAS}, built into the .icns`);
  console.log("Apple's margin comes from logo.svg itself, so neither is inset here.");
}

main();
