# Changelog

What changed in each release, for the people using it. Anything not visible from the outside is in the git log.

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
