// Regenerate the application icons from logo.svg.
//
// package.mjs has always said these are "regenerated from logo.svg together",
// and until now nothing did it: the PNGs were exported by hand and the claim was
// documentation of an intention. That is the same shape as the pin tool that
// pins.json named before it existed, and it goes wrong the same way - the logo
// changes, the icons do not, and nobody notices until an icon looks stale in the
// Dock.
//
// ## This applies no grid of its own, and the logo has to carry one
//
// Both PNGs are a straight render of logo.svg at 1024. Nothing here insets the
// artwork or rounds its corners, so whatever shape the logo has is the shape
// that reaches the Dock - and macOS, unlike iOS, rounds nothing for you: an
// icon opaque to its corners is a square in the Dock, which is exactly what one
// revision of the logo produced.
//
// The logo carries the grid instead, and it is measured rather than assumed:
// the render is transparent at all four corners and along every edge, the
// artwork begins 87 px in, and the first paint along the diagonal is at 139 -
// a corner radius near 177 on a body near 850. Apple's own figures are a body
// of 824 with a radius of 185 in a 1024 canvas, so this sits a little larger
// and a little squarer, which is a drawing decision and not this script's.
//
// An earlier version of this script rendered at 824 and padded back to 1024,
// and was removed for applying the margin a second time on top of the logo's
// own. That remains the one combination that is certainly wrong: the grid
// belongs either here or in the logo, and it is currently in the logo.
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
//
// ## --ensure, which is what every build runs
//
// "Regenerate it by hand and remember to" is the arrangement that produced the
// stale icons this script was written to fix, and it produced them again: the
// logo changed and the committed PNGs were a day older than it. So every build
// now runs this with --ensure, and the icons cannot be older than the logo they
// are made from.
//
// The stamp beside the PNGs is what makes that cheap and what makes it work off
// macOS. It holds the SHA-256 of the logo the committed icons were built from,
// so an unchanged logo costs one hash and no rendering, and a Windows or Linux
// build - which cannot render anything - can still tell that the icons it is
// about to package do not match the logo in the repository, and say so instead
// of shipping the wrong one.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "logo.svg");
const ICONS = join(ROOT, "public", "icons");
const STAMP = join(ICONS, "logo.sha256");

const CANVAS = 1024;

/** What the logo hashes to now. */
function sourceHash() {
  return createHash("sha256").update(readFileSync(SOURCE)).digest("hex");
}

/** What it hashed to when the committed icons were built, or "" if unrecorded. */
function stampedHash() {
  return existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : "";
}

function main() {
  const ensure = process.argv.includes("--ensure");

  if (!existsSync(SOURCE)) {
    console.error(`No logo at ${SOURCE}`);
    process.exit(1);
  }

  if (ensure && sourceHash() === stampedHash()) {
    // The committed icons were built from exactly this logo. Nothing to do, on
    // any platform, which is the case every build takes.
    return;
  }

  if (process.platform !== "darwin") {
    if (!ensure) {
      console.error("build-icons needs macOS: it renders through sips.");
      console.error("The generated PNGs are committed, so only a logo change needs this.");
      process.exit(2);
    }
    console.error("logo.svg does not match the committed icons, and only macOS can");
    console.error("rebuild them. Run `yarn build-icons` there and commit the result;");
    console.error("packaging here would ship an icon that is not the current logo.");
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
  writeFileSync(STAMP, `${sourceHash()}\n`);

  console.log(`appIcon.png     ${CANVAS}x${CANVAS}`);
  console.log(`appIconMac.png  ${CANVAS}x${CANVAS}, built into the .icns`);
  console.log("Apple's margin comes from logo.svg itself, so neither is inset here.");
}

main();
