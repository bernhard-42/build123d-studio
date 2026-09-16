# Changelog

What changed in each release, for the people using it. Anything not visible from the outside is in the git log.

## 0.6.6 (2026-09-16)

- **A startup that fails says why, and where the rest is.** The splash now ends every failure with the path of the log file, and the log begins every session with what the machine is: operating system and version, the webview, memory, free disk per drive, and the environment variables that steer the bootstrap — proxies, `AppData`, `SystemRoot`, anything `UV_*` or `PYTHON*` — with credentials redacted. When uv has to be fetched, the splash names the curl and tar about to be used, whether a curl config file is in the way, and curl's own error line rather than only its exit code; a Windows without `curl.exe` is told so instead of "exit 1". And a first start on Windows no longer fails on a computer whose command prompt is broken by a leftover AutoRun entry — what an uninstalled or moved Anaconda leaves in the registry. cmd.exe then prints "The system cannot find the path specified" before every command and reports a command that succeeded as failed, so Studio downloaded uv, believed the download had failed, and threw it away. Every command now returns its own result through that shell, and the splash explains the line in plain words, with the registry value to delete for whoever wants the error gone everywhere. Every command the application runs now logs its exit code and how long it took. And the window position is restored against the displays that are actually attached: `computer.getDisplays` was never granted in the native allow list, so that check had silently never run; a unit test now holds the list against every native call in the source. A failure before the window was up — a settings directory that cannot be created — used to leave no window at all; it now shows the splash with the reason.

## 0.6.5 (2026-09-16)

- **The viewer's modifier chords work on Windows and Linux for real this time.** 0.6.3 gave those platforms the right map in Settings and in what a show sends, and the viewer never received it: it is built once, at the startup logo, and Studio sent the logo only its theme — so the viewer kept the logo's own map, `meta` on the Win key, through every show after. The logo now gets the platform's keys as well, and the help overlay says `<alt>` where it said `<meta>`. And a map changed in Settings → Viewer → Modifier keys now takes effect at the next show, as every other viewer setting does, on every platform — it used to wait for the next start, for the same reason: every show computed the map and dropped it.
- **On Windows, a changed viewer setting reaches the next `show()` — it never did.** The kernel answers `workspace_config()` from `settings.json`, and looked for it in the directory above the Python environment: true on macOS and Linux, and false on Windows since 0.5.0 moved the environment to `%LOCALAPPDATA%` and left the settings roaming in `%APPDATA%`. It read a file that did not exist and answered the shipped defaults for every viewer setting, silently, whatever Settings held and however often you restarted. The frontend now tells the sidecar where the file is.
- **Choosing GitHub for ocp-viewer-core no longer fails.** The source was written in git's `git@github.com:…` spelling, which is not a URL, and uv refused the whole `pyproject.toml` over it. It is `https://github.com/…` now, as build123d's has always been.

## 0.6.4 (2026-09-15)

- **ocp-tessellate 3.5.3 and ocp-viewer-core 1.0.13.** From the tessellator: an STL import no longer shows as an empty placeholder vertex; build123d's `BuildSheet` and the result of `ShapeList.group_by` convert instead of being skipped; a builder shown from inside its own context before it has any geometry no longer raises; a cadquery sketch that is all construction geometry shows. From the core: `show(orbit_control=True)` and `show(up="Y")` apply to that call alone, `reset_defaults(port=…)` resets the viewer it names, `push_object(…, update=True)` adds a name it has not seen, and the imports work under cadquery-ocp 8.

## 0.6.3 (2026-09-14)

- **The viewer's modifier chords work on Windows and Linux.** Locking vertical rotation, hiding and isolating are the `meta` role in three-cad-viewer, and `meta` was the Win/Super key everywhere except macOS — a key the desktop keeps for itself, so those chords never reached the viewer at all. They are the **Alt** key there now. macOS is unchanged: `meta` is Cmd, as it was. The default shown in Settings → Viewer → Modifier keys follows the platform too, so what the dialog calls "unset" is what the viewer is actually given.

## 0.6.2 (2026-09-10)

- **The viewer lays itself out properly when its pane changes size.** A resize sized only the canvas, leaving the toolbar and the tree at the width they had; and turning glass mode off at runtime re-derived the geometry from the width it had just replaced, so the viewer grew by the tree's width and overflowed the pane until something else happened to resize it. Both matter here more than elsewhere, because every Run moves the panes. three-cad-viewer 5.0.6 and ocp-viewer-core 1.0.4 on the JavaScript side.
- **The environment stops carrying a package it can never run.** ocp-viewer-core 1.0.8 moves `questionary` into a `cli` extra: its one use is a prompt reached only outside a Jupyter kernel, and Studio never imports the module it lives in.

## 0.6.1 (2026-09-09)

- **A stored viewer setting takes effect again when it shares a name with a built-in default.** Fixed in ocp-viewer-core 1.0.6, which this release moves to (1.0.7).
- **The native tessellator can be turned on and off from the kernel**, as it can in the other three viewers: `enable_native_tessellator()`, `disable_native_tessellator()` and `is_native_tessellator_enabled()` are importable from `build123d_studio`. They need the `ocp_addons` accelerator to be installed; without it, enabling says so rather than failing quietly. `NATIVE_TESSELLATOR=1` in the environment is honoured here now too. Nothing is printed when it is on — ask `is_native_tessellator_enabled()`.

## 0.6.0 (2026-09-08)

- **The toolbar no longer hides its own buttons when the window is narrow.** Too narrow to fit them all, the row scrolls — and the scrollbar was drawn across the bottom of it, covering half of every button. There is no scrollbar now, and the row can be dragged sideways with the mouse, which is what most people try first. Shift-wheel still works.
- **three-cad-viewer 5.0.5**, with the fixes made in it since 5.0.4.

## 0.5.8 (2026-09-07)

- **"This environment cannot import OCP or build123d" was sometimes a false alarm, and the advice under it made things worse.** With cadquery in the environment, the startup check imported everything successfully and then faulted on the way out — Windows corrupts the heap while unloading the OpenCascade libraries — and only the exit code was read, so a run that had done its whole job was reported as an environment that could import nothing. The prompt then offered **Restore**, which would have replaced a perfectly good configuration, local checkouts and all. The check now leaves without a teardown, and says which half of it succeeded: trouble with cadquery — which you add yourself, and which the application never imports — is written to the log and stops nothing.

## 0.5.7 (2026-09-07)

- **A window whose link to the application has died says so again, and keeps saying it.** On Windows, waking from a long sleep breaks two connections at once: the one to the Python backend, which is redialled and comes back, and the one to the application itself, which cannot be. The second is the serious one — nothing can be saved, nothing logged, and the window cannot be closed — and the offer to reload, which is the only way out, was being wiped off the screen a second later by the backend's own recovery. What was left was a window that ran code perfectly, wrote nothing to its log, and could not be quit, with nothing on screen to explain it. Found on a machine that had been asleep for four days.

## 0.5.6 (2026-09-07)

- **Run → Test File and Test Folder.** Pick a file or a folder and `pytest` runs over it, in a process of its own — the report arrives in the Run/Debug tab and the Stop beside it ends the run, exactly as Run File works. pytest is part of the environment from this release on. Settings → **Test** carries one switch, **Ignore warnings**, which adds `-W ignore` for a suite where the same deprecation is raised a hundred times and buries the summary.
- **Restart Kernel now sits above Run File in the Run menu.** Everything above that line runs on the kernel and shares its namespace; everything below it runs in a process of its own and leaves nothing behind.
- **About says how to reach the kernel from outside.** The connection file has a section of its own at the foot of the dialog, with the `jupyter-console --existing "…"` command to attach to the running kernel — and the warning that matters: leave that console with `Ctrl-D`, because a typed `exit` shuts the kernel down.
- **Every path in About has a copy button**, and the values have the room the labels were wasting — the first column was sized as a share of the panel and spent 120 pixels on nothing. A path that wrapped over four lines and had to be selected by hand is now one click. The full package list moved to the very bottom, below everything anybody is meant to find by reading.
- **About shows the OCP you actually have.** It only ever listed `cadquery-ocp-novtk`, so an environment with the VTK build — which is most of them — read "not installed" and never showed a version at all. Both are listed now, and `ocpsvg` has left the short list.
- **Opening a file gives it the keyboard.** From the tree or from the menu, the file opened without a cursor in it: nothing is drawn while the editor does not have focus, so it looked ready to type into and was not.
- **Dark mode moved to Settings → Application**, with the other settings that are about the application rather than about one pane.
- **The shipped dependency lock matches what the release declares again.** The lock in 0.5.2 through 0.5.5 was the one resolved for 0.5.1: it predated both the OCP type stubs and the ocp-viewer-core floor those releases declared, so a fresh environment re-resolved over the network at its first start instead of beginning from the versions the release was tested with. The lock is now part of what a release commits, so it cannot fall behind again.
- **A test run and a file run cannot collide.** Only one child process at a time, as before — asking for a test run while something is running now says so, rather than starting nothing and explaining nothing.

## 0.5.5 (2026-09-03)

- **The kernel indicator says how much is waiting.** Pressing Run while a cell is running queues it, as in Jupyter — the indicator now reads `busy [+1]`, `busy [+2]` and counts back down. Until now nothing said so: the indicator already read `busy` and the console shows `In [n]` only when a run actually starts.
- **Interrupting no longer offers to restart a kernel that obeyed.** Interrupt a cell, let it stop, run something else within five seconds, and "The kernel did not stop" appeared over a kernel that had stopped when asked. A second interrupt during that window also got no grace of its own.
- **The keyboard goes back to the editor after a Run.** Run Cell moves the caret to the next cell, and the cursor is not drawn while the editor does not have focus — so a run from the toolbar or the menu left it invisible.
- **`Alt-Enter` selects every match while the find widget is open**, as it does in VS Code. It is still Run All everywhere else.
- **Settings → Packages reads as three jobs**: Update, Upgrade, Restore, one button each, with what this release declares listed at the top. The per-package **Re-install** buttons are gone — a local checkout is installed editable, so code edits are already live, and Update covers a changed dependency or entry point.
- **Changing a viewer setting survives a resize.** `set_viewer_config(glass=False)` reverted the next time anything resized the pane — including every Run, which moves the panes. The same held for `tools`, `treeWidth` and `theme`. Fixed in ocp-viewer-core 1.0.3.

## 0.5.4 (2026-09-03)

- **The CAD libraries are loaded after a package change**, not at your next Run. macOS re-verifies OpenCascade's signed libraries whenever they are replaced, which is about two minutes on an Apple M1 — paid on the splash, one named step at a time, rather than looking like a hung kernel later. An update that changed nothing skips it.
- **The splash says which version it is**, which is what a report about a first run needs.
- The find widget was given `Alt-Enter` — see 0.5.5, where the collision with Run All was settled.

## 0.5.3 (2026-09-02)

- **Requires ocp-viewer-core 1.0.5**, which keeps the OpenCascade kernel out of Studio's sidecar. 1.0.4 pulled it in through its package root, into the one process whose design depends on not having it.

## 0.5.2 (2026-09-02)

- **A save keeps the file it saved.** Saving used to write a new file and rename it over the old one, which replaced it: a hard link kept the old contents, and extended attributes — Finder tags among them — were lost. Saves now write into the file. The recovery journal covers what atomicity did, and a buffer too large to be journalled continuously is copied there once before each write.
- **A file changed by something else is noticed when you look at it**, not only when you save. Focus the window or choose the tab and you are asked, with Reload, Overwrite and Cancel — Cancel marks the tab modified so the choice survives being closed.
- **Format on save keeps its result.** Saving a large file and immediately switching tabs wrote it unformatted; the first save of a new file did the same. Typing while ruff is working is no longer overwritten, and above 50 000 lines a buffer is written without being formatted.
- **The file tree shows what is on disk.** A directory was read the first time it was opened and never again, so a file added, deleted or renamed while it was collapsed never appeared.
- **A file is treated as what it is.** Only `.py` and `.pyi` are Python: a STEP export opened to be looked at is no longer analysed as Python, which produced thousands of errors, nor offered to the formatter.
- **The editor knows the OpenCascade types.** `from OCP... import ...` was underlined as an error in your own files, and everything build123d's shapes wrap was unknown to completion.
- **The language server no longer outlives the application.** A wedged one could survive a quit and hold a core indefinitely.
- **The `studio` command ships on Linux** and the install instructions name a directory that is actually on your `PATH`.
- **The environment is a uv project you own** — see 0.5.1 — and installing a new release no longer resets the packages you added.
- Interrupt says `interrupting` while the kernel is being asked to stop, and the window no longer claims to have lost its link during a long install.

## 0.5.1 (2026-09-01)

- **The environment's `pyproject.toml` is yours to edit.** Studio writes it once and then keeps only its own two dependency groups up to date, leaving your packages, sources and comments alone.
- The splash can be selected and copied, which matters when it is the only thing on screen and something has gone wrong.

Releases before 0.5.1 predate this file.
