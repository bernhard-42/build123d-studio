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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "logo.svg");
const ICONS = join(ROOT, "public", "icons");
const STAMP = join(ICONS, "logo.sha256");

const CANVAS = 1024;

/**
 * What the logo hashes to now.
 *
 * The image, not the bytes it happened to arrive in. Git on Windows checks text
 * files out with CRLF by default, and an SVG is text as far as Git is
 * concerned - so the same logo hashed to be08d677 on macOS and Linux and
 * 8d7c3e27 on Windows, and --ensure refused a build it should have waved
 * through. It cost a Windows release: every other job in the run passed.
 *
 * .gitattributes now keeps SVGs at LF, which fixes it at the source. This
 * normalises anyway, because the question the stamp answers is "were the
 * committed icons built from this picture" and a line ending is not part of the
 * picture. A checkout with different settings, or a file touched by an editor
 * that rewrites endings, must not be able to make this lie.
 */
function sourceHash() {
  const text = readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** What it hashed to when the committed icons were built, or "" if unrecorded. */
function stampedHash() {
  return existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : "";
}

// The sizes a Windows shortcut is asked for: the list view, the desktop, and
// the large tile. 256 is the one that matters on a modern display and the
// others stop Explorer scaling it down badly.
const ICO_SIZES = [16, 32, 48, 256];

/**
 * Write a .ico, which a Windows shortcut needs and a .png cannot be.
 *
 * The container is a header and one entry per image, and since Vista each image
 * may be a PNG rather than a bitmap - so this is sips for the rendering and
 * eighteen bytes of arithmetic for the wrapper, rather than a dependency that
 * would have to be pinned, audited and shipped for one file.
 *
 * It exists so the Windows package can point a shortcut at an unmodified
 * Neutralino binary. Rewriting the icon *into* the executable is what Defender
 * scores as re-skinning somebody else's binary; a shortcut carries its own.
 */
function writeIco(destination) {
  const images = ICO_SIZES.map((size) => {
    const scaled = join(ICONS, `.ico-${size}.png`);
    execFileSync(
      "sips",
      ["-s", "format", "png", "-z", String(size), String(size), SOURCE, "--out", scaled],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const data = readFileSync(scaled);
    rmSync(scaled);
    return { size, data };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    // 0 means 256 in this field, which is why the largest size is expressible
    // in one byte at all.
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);             // palette colours: none, it is truecolour
    entry.writeUInt8(0, 3);             // reserved
    entry.writeUInt16LE(1, 4);          // colour planes
    entry.writeUInt16LE(32, 6);         // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  writeFileSync(destination, Buffer.concat([
    header, ...entries, ...images.map((image) => image.data),
  ]));
  console.log(`appIcon.ico     ${ICO_SIZES.join(", ")} px, for the Windows shortcut`);
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
  writeIco(join(ICONS, "appIcon.ico"));
  writeFileSync(STAMP, `${sourceHash()}\n`);

  console.log(`appIcon.png     ${CANVAS}x${CANVAS}`);
  console.log(`appIconMac.png  ${CANVAS}x${CANVAS}, built into the .icns`);
  console.log("Apple's margin comes from logo.svg itself, so neither is inset here.");
}

main();
