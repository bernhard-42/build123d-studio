#!/usr/bin/env node
//
// Assemble a distributable package for one platform.
//
// `neu build` produces only the Neutralino binaries and resources.neu. A
// working build123d Studio also needs the bundled uv, the Python sidecar, the
// kernel-side package and the uv project files - none of which Neutralino knows
// about. This script puts them together and wraps the result in whatever each
// platform expects:
//
//   macOS    .app bundle inside a .dmg, laid out for drag-to-Applications
//   Windows  .zip - the application writes nothing to its own directory, so a
//            portable extract-and-run genuinely works
//   Linux    .AppImage - one file, no root, runs across distributions
//
// Nothing is code-signed. See the README for what users see as a result.
//
//   node scripts/package.mjs                 # this machine's platform
//   node scripts/package.mjs --target linux-x64

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "release");

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const neutralino = JSON.parse(readFileSync(join(ROOT, "neutralino.config.json"), "utf8"));

const APP_NAME = "build123d Studio";
const APP_SLUG = "build123d-studio";
const VERSION = manifest.version;

// The AppImage build tool, pinned. See packageLinux for why, and for where
// these digests came from.
const APPIMAGETOOL = {
  version: "1.9.1",
  digests: {
    x86_64: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
    aarch64: "f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158",
  },
};

// target -> the binary neu build emits. uv is not shipped: the application
// downloads the current release on first start, which keeps packages small and
// stops a bundled uv from capping the newest installable Python.
const TARGETS = {
  "darwin-arm64": { binary: `${APP_SLUG}-mac_arm64`, kind: "mac" },
  "darwin-x64": { binary: `${APP_SLUG}-mac_x64`, kind: "mac" },
  "linux-x64": { binary: `${APP_SLUG}-linux_x64`, kind: "linux" },
  "linux-arm64": { binary: `${APP_SLUG}-linux_arm64`, kind: "linux" },
  "win32-x64": { binary: `${APP_SLUG}-win_x64.exe`, kind: "windows" },
};

function currentTarget() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  if (process.platform === "win32") return "win32-x64";
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

const targetName = (() => {
  const index = process.argv.indexOf("--target");
  return index === -1 ? currentTarget() : process.argv[index + 1];
})();

const target = TARGETS[targetName];
if (target === undefined) {
  throw new Error(`Unknown target ${targetName}. Known: ${Object.keys(TARGETS).join(", ")}`);
}

/**
 * Everything the application needs beside its binary.
 *
 * The Python sources are shipped as plain directories rather than bundled: the
 * sidecar and kernel package are run from disk via PYTHONPATH, which is also
 * what lets the environment live outside the application.
 */
function assemblePayload(destination) {
  mkdirSync(destination, { recursive: true });

  // Windows takes Neutralino's own binary, unpatched and under its own name.
  //
  // `neu build` produces a copy with our icons and version strings rewritten
  // into its .rsrc - +41,984 bytes, entry point and every code section
  // byte-identical - and Microsoft Defender deletes that copy as
  // Trojan:Win32/Wacatac. Measured on 0.2.0 and again on 0.3.0, and on a build
  // with no metadata at all, so it is not what the resources *say*. The stock
  // binary passes on the same machine, because millions of copies of that exact
  // hash exist and Defender has an opinion about it.
  //
  // So Windows gets the file everyone else has, under our own name - a filename
  // is not part of the hash, and the hash is what Defender scores. It was
  // briefly called neutralinojs.exe, which was honest and unusable: anybody who
  // skips the shortcut unpacks a folder with no obvious thing to click. The
  // other platforms keep the patched binary: neither has this problem, and a
  // .app without an icon would be a worse answer there.
  const binaryName = target.kind === "windows" ? `${APP_SLUG}.exe` : APP_SLUG;
  const binarySource = target.kind === "windows"
    ? join(ROOT, "bin", "neutralino-win_x64.exe")
    : join(DIST, APP_SLUG, target.binary);
  cpSync(binarySource, join(destination, binaryName));
  if (target.kind !== "windows") {
    chmodSync(join(destination, binaryName), 0o755);
  }

  cpSync(join(DIST, APP_SLUG, "resources.neu"), join(destination, "resources.neu"));

  // The command line launcher, for the user to copy onto their PATH. It ships
  // beside the binary rather than being installed by the application, which
  // would mean writing outside our own directory and, on the paths people
  // actually have on PATH, asking for a password.
  //
  // It resolves the application through the location file the app writes on
  // every start, not through its own path - see recordAppLocation. That is what
  // lets it be copied anywhere.
  if (target.kind === "windows") {
    cpSync(join(ROOT, "cli", "studio.cmd"), join(destination, "studio.cmd"));
    // Named for what it does, because that is the whole of its job: it makes a
    // shortcut and exits. It started life as a launcher called
    // build123d-studio.cmd, which was wrong twice over - the application can
    // simply be double-clicked, and with extensions hidden a launcher sat
    // beside a PowerShell file of the same name, one of which does nothing when
    // clicked because Windows opens .ps1 in an editor.
    cpSync(join(ROOT, "cli", "create-build123d-studio-link.cmd"),
           join(destination, "create-build123d-studio-link.cmd"));
    // The icon a shortcut points at. It cannot be a .png, and it is no longer
    // inside the executable.
    cpSync(join(ROOT, "public", "icons", "appIcon.ico"),
           join(destination, "appIcon.ico"));
  } else {
    const studio = join(destination, "studio");
    cpSync(join(ROOT, "cli", "studio"), studio);
    chmodSync(studio, 0o755);
  }

  for (const directory of ["sidecar", "kernel"]) {
    cpSync(join(ROOT, directory), join(destination, directory), {
      recursive: true,
      filter: (path) => !path.includes("__pycache__"),
    });
  }

  // The environment itself is built at first start; only the declaration ships.
  mkdirSync(join(destination, "runtime"), { recursive: true });
  for (const file of ["pyproject.toml", "uv.lock"]) {
    cpSync(join(ROOT, "runtime", file), join(destination, "runtime", file));
  }

  // Both MIT and Apache-2.0 require the notice and licence text to accompany a
  // binary distribution, so these travel with every package.
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_LICENSES.md"]) {
    cpSync(join(ROOT, file), join(destination, file));
  }

  // The one thing the application cannot keep out of its own directory.
  //
  // Everything we control writes to the per-user app-data directory instead -
  // the environment, the settings file and the log - but Neutralino saves
  // .tmp/window_state.config.json beside its binary on every window close. The
  // path is hardcoded, modes.window.useSavedState governs only *restoring*, and
  // the save is an uncaught std::filesystem::create_directories: on a read-only
  // directory the exception propagates out and the process aborts, so closing
  // the window crashes rather than degrading.
  //
  // Shipping the directory already there is what stops that, because
  // create_directories on an existing path returns without error. The
  // installation can then be read-only everywhere except this one directory.
  mkdirSync(join(destination, ".tmp"), { recursive: true });

  return binaryName;
}

// --- macOS ------------------------------------------------------------------

function buildIcns(destination) {
  const iconset = join(OUT, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });

  // macOS expects the artwork inset on Apple's icon grid, otherwise the icon
  // sits visibly larger than every neighbour in the Dock and Finder. That inset
  // is drawn into logo.svg itself - a 1024 canvas with a 102 px margin - so
  // appIconMac.png is a straight render of it and nothing here insets anything.
  // Regenerate both with `yarn build-icons` after changing the logo; that script
  // is what makes this comment true, having previously described a step nobody
  // performed.
  const source = join(ROOT, "public", "icons", "appIconMac.png");
  for (const size of [16, 32, 64, 128, 256, 512]) {
    run("sips", ["-z", String(size), String(size), source, "--out", join(iconset, `icon_${size}x${size}.png`)],
      { stdio: "ignore" });
    run("sips", ["-z", String(size * 2), String(size * 2), source,
      "--out", join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" });
  }
  run("iconutil", ["-c", "icns", iconset, "-o", destination]);
  rmSync(iconset, { recursive: true, force: true });
}

function packageMac() {
  const stage = join(OUT, "dmg");
  const app = join(stage, `${APP_NAME}.app`);
  rmSync(stage, { recursive: true, force: true });

  // Payload sits next to the binary in Contents/MacOS rather than in
  // Contents/Resources. Less idiomatic, but NL_PATH is the binary's directory,
  // so this needs no path handling in the application at all.
  const macos = join(app, "Contents", "MacOS");
  const binaryName = assemblePayload(macos);

  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  buildIcns(join(app, "Contents", "Resources", "appIcon.icns"));

  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${neutralino.applicationId}</string>
  <key>CFBundleExecutable</key><string>${binaryName}</string>
  <key>CFBundleIconFile</key><string>appIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

  // The conventional drag-to-Applications gesture.
  run("ln", ["-s", "/Applications", join(stage, "Applications")]);
  for (const file of ["LICENSE", "THIRD_PARTY_LICENSES.md"]) {
    cpSync(join(ROOT, file), join(stage, file));
  }

  const dmg = join(OUT, `${APP_SLUG}-${VERSION}-${targetName}.dmg`);
  rmSync(dmg, { force: true });
  run("hdiutil", ["create", "-volname", APP_NAME, "-srcfolder", stage,
    "-ov", "-format", "UDZO", dmg]);
  return dmg;
}

// --- Windows ----------------------------------------------------------------

function packageWindows() {
  const stage = join(OUT, APP_SLUG);
  rmSync(stage, { recursive: true, force: true });
  assemblePayload(stage);

  const zip = join(OUT, `${APP_SLUG}-${VERSION}-${targetName}.zip`);
  rmSync(zip, { force: true });
  if (process.platform === "win32") {
    // The one command string in the project outside the quote() invariant that
    // src/proc.js states. It is safe for a different reason rather than by that
    // rule: both values are derived from constants in this file, and
    // execFileSync passes argv directly with no shell in between. Keep them
    // constant - anything user-derived here needs real quoting first.
    run("powershell", ["-NoProfile", "-Command",
      `Compress-Archive -Path '${stage}' -DestinationPath '${zip}'`]);
  } else {
    run("zip", ["-r", "-q", zip, APP_SLUG], { cwd: OUT });
  }
  return zip;
}

// --- Linux ------------------------------------------------------------------

function packageLinux() {
  const appdir = join(OUT, `${APP_SLUG}.AppDir`);
  rmSync(appdir, { recursive: true, force: true });

  const binaries = join(appdir, "usr", "bin");
  const binaryName = assemblePayload(binaries);

  // An AppImage mounts as read-only squashfs, so the pre-created .tmp that
  // makes a read-only .app work is not enough here - nothing under the mount
  // can be written at all, and Neutralino's unconditional window-state save on
  // close would abort the process.
  //
  // So the application is pointed at a writable directory instead. --path is
  // what `neu run` uses in development, and it sets NL_PATH, which is both where
  // Neutralino looks for resources.neu and how the application resolves its own
  // payload. Populating that directory with symlinks rather than copies keeps it
  // free: nothing is duplicated, and the links are refreshed every launch
  // because the mount point differs from run to run.
  const appRun = join(appdir, "AppRun");
  writeFileSync(appRun, `#!/bin/sh
set -e
HERE=$(dirname "$(readlink -f "$0")")
DATA="\${XDG_DATA_HOME:-$HOME/.local/share}/${APP_SLUG}"
STAGE="$DATA/app"
mkdir -p "$STAGE"
for entry in "$HERE"/usr/bin/*; do
  ln -sfn "$entry" "$STAGE/$(basename "$entry")"
done
# Where the \`studio\` script should launch us from. It cannot use the staged
# directory above: those are symlinks into a mount that disappears when this
# process exits, and \$APPIMAGE is the only durable name this application has on
# Linux. Written here because AppRun is the only part that knows it.
if [ -n "\${APPIMAGE:-}" ]; then
  printf '%s' "$APPIMAGE" > "$DATA/app-image" || true
fi
exec "$HERE/usr/bin/${binaryName}" --path="$STAGE" "$@"
`);
  chmodSync(appRun, 0o755);

  writeFileSync(join(appdir, `${APP_SLUG}.desktop`), `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Exec=${binaryName}
Icon=${APP_SLUG}
Categories=Graphics;Development;
Comment=An IDE for build123d
Terminal=false
`);
  cpSync(join(ROOT, "public", "icons", "appIcon.png"), join(appdir, `${APP_SLUG}.png`));

  // Pinned and verified before it is ever executed.
  //
  // This used to fetch the "continuous" release, which upstream repoints at
  // every commit, and run it unchecked on the machine that had just built the
  // artifact users download - so whoever controlled that tag controlled the
  // contents of the AppImage. A tagged release plus a committed digest makes it
  // an input we decide on rather than one we accept.
  //
  // The digests come from the GitHub releases API, which serves them from a
  // different origin than the asset itself, and were cross-checked against the
  // downloaded bytes on 2026-07-29. Attestation is not an option here:
  // AppImage/appimagetool publishes none, exactly as Neutralino does not.
  //
  // Cached in a subdirectory, not in release/ itself, and that is not
  // cosmetic: CI uploads release/*.AppImage as the build artifacts, so a tool
  // sitting there under that name would be published as though this project
  // had built it - listed in SHA256SUMS.txt, attached to the release, and
  // *attested*, which would be a false provenance claim about somebody else's
  // binary. The glob does not descend into directories.
  const arch = targetName === "linux-arm64" ? "aarch64" : "x86_64";
  const toolCache = join(OUT, ".tools");
  mkdirSync(toolCache, { recursive: true });
  const tool = join(toolCache, `appimagetool-${APPIMAGETOOL.version}-${arch}.AppImage`);
  if (!existsSync(tool)) {
    run("curl", ["-sSfL", "-o", tool,
      `https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL.version}` +
      `/appimagetool-${arch}.AppImage`]);
  }
  const digest = createHash("sha256").update(readFileSync(tool)).digest("hex");
  if (digest !== APPIMAGETOOL.digests[arch]) {
    rmSync(tool, { force: true });
    throw new Error(
      `appimagetool ${arch} does not match the pinned digest:\n` +
      `  expected ${APPIMAGETOOL.digests[arch]}\n  got      ${digest}`,
    );
  }
  chmodSync(tool, 0o755);

  const output = join(OUT, `${APP_SLUG}-${VERSION}-${targetName}.AppImage`);
  rmSync(output, { force: true });
  // --appimage-extract-and-run avoids needing FUSE, which CI runners lack.
  run(tool, ["--appimage-extract-and-run", appdir, output], {
    env: { ...process.env, ARCH: targetName === "linux-arm64" ? "aarch64" : "x86_64" },
  });
  return output;
}

// --- go ---------------------------------------------------------------------

if (!existsSync(join(DIST, APP_SLUG, target.binary))) {
  throw new Error(`Missing ${target.binary}. Run: yarn package:build`);
}
mkdirSync(OUT, { recursive: true });

console.log(`Packaging ${APP_NAME} ${VERSION} for ${targetName}`);
const artifact =
  target.kind === "mac" ? packageMac() : target.kind === "windows" ? packageWindows() : packageLinux();

const size = (readFileSync(artifact).length / 1024 / 1024).toFixed(0);
console.log(`\n  ${artifact}  (${size} MB)`);
