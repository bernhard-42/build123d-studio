# First run

## Download and Verification

**Verify what you downloaded**

Download the latest release from [the Release page](https://github.com/bernhard-42/build123d-studio/releases), compute the checksum of the downloaded file

- _macOS_: `shasum -a 256 build123d-studio-*.dmg`
- _Windows_: `certutil -hashfile build123d-studio-*.zip SHA256`
- _Linux_: `sha256sum build123d-studio-*.AppImage`

and compare it against the values in `SHA256SUMS.txt` on the same Release page.

If the github CLI [gh](https://cli.github.com/) is installed, you can also verify the downloaded files by

```sh
gh attestation verify build123d-studio-*.dmg --repo bernhard-42/build123d-studio
```

## Installation

Install it the ordinary way for your platform: drag the `.app` to Applications under MacOS, unzip the Windows package or store the Linux AppImage where you like it.

## Running the application

**Preparation:**

- **macOS**: MacOS builds are signed ad hoc, with no Developer ID and no notarisation. So, the first run is blocked with

  > "build123d Studio" Not Opened
  > Apple could not verify “build123d Studio” is free of malware that may harm your Mac or compromise your privacy.

  Open "System Settings / Privacy & Security" and under _Security_ you find

  > "build123d Studio" was blocked to protect your Mac'.

  Click on "Open Anyway".

  Alternatively, run `xattr -dr com.apple.quarantine "/Applications/build123d Studio.app"` before double clicking the _build123d Studio_ icon.

- **Windows**: Windows builds are unsigned, hence SmartScreen warns on first run. Use _More info_ → _Run anyway_.

- **Linux**: Neutralino uses the system webview rather than bundling a browser engine. It tries to load `libwebkit2gtk` (version 4.0 or 4.1).
  - Install WebKitGTK (`libwebkit2gtk-4.1-0` or `libwebkit2gtk-4.0-37` on older releases) if it is not already there, see [neutralinojs dependencies](https://neutralino.js.org/docs/contributing/framework-developer-guide#installing-compilation-tools-and-dependencies).
  - Mark the AppImage executable, or the desktop treats it as a data file and offers to open it with an archive manager: `chmod +x build123d-studio-*.AppImage`.

The first start takes a few minutes and shows you what it is doing. A splash overlay reports each step while it downloads [uv](https://docs.astral.sh/uv/), downloads the Python interpreter, and installs the Python packages (several hundred megabytes in total, including the language server and the OpenCascade bindings). Everything is downloaded into your **user data directory**:

- **macOS**: `~/Library/Application Support/build123d-studio/`
- **Windows**: `%APPDATA%\build123d-studio\`
- **Linux**: `~/.local/share/build123d-studio`

Every start after that goes straight to the window. The environment already exists, so all that happens is a reconciliation against the locked package list, and the window is up while the kernel warms in the background. The kernel indicator in the toolbar says `starting`, then `idle`, and you can type before it gets there.

## Troubleshooting

If something goes wrong, consult the log in the user data directory (see above).
