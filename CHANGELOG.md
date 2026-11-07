# Changelog

What changed in each release, for the people using it. Anything not visible from the outside is in the git log.

## unreleased

- **Features**
    - Kernel plugins: objects of CAD kernels other than OCCT are shown, and measured by the Distance and Properties tools from that kernel's own geometry. The first plugin is [ocp-viewer-smlibpy](https://github.com/bernhard-42/ocp-viewer-smlibpy) for SMLib. A plugin must also be installed where the viewer's measurement backend runs, which can be another environment than the script's. Nothing changes for OCCT objects
    - A rotate drag that starts on the model turns around the point under the cursor, and one that starts on the background around the centre of the visible objects; the wheel, trackpad pinch and middle-button drag zoom towards the cursor (three-cad-viewer 5.2). Both are on by default and switch separately: settings **Rotate around the point under the cursor** and **Zoom towards the cursor** under Camera and controls in the Viewer settings, and keywords `cursor_pivot` and `zoom_to_cursor` of `show`, `show_object`, `show_objects` and `set_defaults`
    - **Restart backend** in a new Backend section of the Application settings restarts the measurement backend, which loads its libraries and kernel plugins again; the model on screen and the active tool carry over
    - **Restart viewer** in the Application settings builds the viewer again and shows the start screen, as at startup, for when a JavaScript error has left it unusable; it used to take a restart of Studio

- **Changes**
    - **ocp-viewer-core** has no source picker in the Packages settings any more: to use a local checkout or the GitHub branch, add it to Additional packages like any other package, for example `git+https://github.com/bernhard-42/ocp-viewer-core@main`. A choice made in the picker moves there by itself at the next start
    - The Python environment depends on `ocp-viewer-core>=1.2.0,<1.3.0` (was `>=1.1.2,<1.2.0`) and `ocp-tessellate>=3.7.0` (was `>=3.6.3`): ocp-viewer-core 1.2.0 runs on ocp-tessellate 3.7, which brings the kernel plugins

- **Fixes**
    - Installing or upgrading packages also restarts the measurement backend. It used to keep the old libraries until Studio was restarted
    - The measurement backend no longer hangs when a library or a kernel plugin prints to stdout, from native code or while it is being imported
    - After the measurement backend restarts, the active Distance or Properties tool keeps answering; it used to answer nothing until the tool was switched off and on
    - `show(1)`, `show((1, 2, 3))` and other calls with nothing to draw no longer raise "nothing to show"; they do nothing, as in the other viewers
    - Debugging a script whose libraries fork or start Python child processes works: smlibpy's kernel steps, for example, failed with "the kernel step failed in a copy of this process". The child processes run without the debugger

## 0.10.0 (2026-10-21)

- **Features**
    - New setting **Show minimap** under View in the Editor settings (default on): turns the editor's minimap off or on, at once and for the next start
    - **Export…** in the variable explorer's right-click menu writes a build123d shape, an assembly or what a builder built to STEP, STL, BREP, OBJ or GLTF. The dialog shows the options of build123d's `export_*` function for the chosen format with their defaults, remembers the last format and options, and runs the export as a line in the console that can be copied into a script
    - **Import…** at the foot of the File menu reads a BREP, DXF, STEP, STL or SVG file into a variable: after the file, a dialog asks for the variable's name (the file's, by default) and shows the options of build123d's `import_*` function for that format with their defaults, and the import runs as `name = import_…(…)` in the console and shows the result. **Add import code at cursor position** (off by default) also puts the import statement into the open file at the caret - without the show, and with an import line only if the file does not import the importer yet. Cancel in either dialog ends it
    - **Show**, **Copy** and **Export…** in the variable explorer also work on rows inside a list, tuple, dict or build123d assembly: such a row can be selected like a variable and is reached by its Python expression, such as `asm.children[1]` or `parts['lid']`. Rows that have no index - a shape's topology, a set's elements - are reached by their position, as in `list(asm.children[0])[0]`. A part inside an assembly is shown and exported at its own location, which is relative to its parent assembly, and the viewer and the suggested file name use its label

- **Changes**
    - The Python environment depends on `build123d>=0.13.0` (was `>=0.11.1`), which runs on OCP 8 (`cadquery-ocp-novtk` 8.0); the OCP type stubs move to 8.0 with it
    - uv 0.13.5 (was 0.12.7), which no longer trusts a root certificate whose intermediate was compromised and rejects certificate chains containing the compromised intermediate keys ([GHSA-hq85-5cpj-mr62](https://github.com/astral-sh/uv/security/advisories/GHSA-hq85-5cpj-mr62)). An existing installation replaces its uv at the next start
    - CPython 3.14.9 (was 3.14.6), the security release whose bundled pip trusts the same root no longer. An existing environment is rebuilt on it at the next start: a few seconds from the download cache, then the libraries are checked once, as after any package change
    - `certifi>=2026.10.19`, so HTTPS made from Python - `requests`, which build123d brings - no longer trusts that root either

- **Fixes**
    - Showing an unchanged shape again, or a moved or rotated copy of it, takes its tessellation from the cache instead of computing it again (ocp-tessellate 3.6.3, now the minimum)
    - After Save As or another file dialog, and when the window comes back to the front, typing continues where the caret was; it used to land at the top of the file
    - Staying in a file dialog or a message box for half a minute or more no longer brings up "This window lost its link to the application": the check of that link pauses while such a dialog is open
    - On Linux, when none of zenity, kdialog, matedialog or qarma is installed - the programs that draw file dialogs there - a banner says so and names what to install. Open, Save As, Import and Export did nothing without one, with no message
    - Studio could miss the moment the kernel finished starting, and then not read the viewer defaults or the Import and Export options for the rest of the session ("could not be read from the kernel" on an idle kernel). It now notices either of the two signals the kernel sends

## 0.9.0 (2026-10-13)

- **Features**
    - New setting **Number repeated names from 0 (Python indices)** under Rendering in the Viewer settings (default on) and keyword `python_enumeration` of `show`, `show_object`, `show_objects` and `set_defaults` ([#242](https://github.com/bernhard-42/vscode-ocp-cad-viewer/issues/242)): repeated object names are numbered from 0 like Python indices - `Solid(0)`, `Solid(1)`, `Solid(2)` instead of `Solid`, `Solid(2)`, `Solid(3)`. Turning it off restores the former names
    - Measured angles show their supplement as well, `60.000 (120.000)`: the distance tool's angle, and the properties tool's angle to XY of a face and of an edge's ends ([#236](https://github.com/bernhard-42/vscode-ocp-cad-viewer/issues/236)). A cone's half angle stays one number
    - `ColorMap.golden_ratio(..., hue_offset=0.0)` shifts where the golden-ratio color sequence starts, as a fraction of the colormap from 0 to 1; 0 gives the colors as before ([#222](https://github.com/bernhard-42/vscode-ocp-cad-viewer/issues/222))
    - `save_screenshot(..., timeout_s=2)` sets how long to wait for the file, in seconds
    - nanocct support (ocp-tessellate 3.6): `show()` handles shapes of build123d or CadQuery running on nanocct, and OCP and nanocct objects can be shown together. Where nanocct is installed it is the binding for everything that does not bring its own OCCT object, as in the other libraries of the ecosystem
    - **three-cad-viewer 5.1.3** (was 5.0.7)
        - Hovering a row of the tree highlights that object, or everything below a group: the faces of solids and faces, the edges of objects that have only edges, the vertices of objects that have only vertices ([#218](https://github.com/bernhard-42/vscode-ocp-cad-viewer/issues/218))
        - Ctrl/Cmd-C over the model copies the point under the mouse to the clipboard as `x, y, z` (4 decimals), and the status line shows `copied: x, y, z`. It follows the topology filter (All / Vertex / Edge / Face / Solid) and works once the viewer has the keyboard - click into it first, since the editor keeps it otherwise; it is off in explode mode, with a z-scale other than 1, and while an animation has moved the parts (Play or the time slider; Stop turns it back on, Pause does not) ([#243](https://github.com/bernhard-42/vscode-ocp-cad-viewer/issues/243))
        - Clip caps are hatched: neighbouring solids alternate the direction and spacing of the lines, which stay fixed to the clip plane while the view moves
        - Clip caps are outlined in the edge color while the Clip tab is active, also where caps of touching solids meet and, seen from behind, along the cut contour on the faces. The outline is drawn once the camera has been still for 150 ms

- **Changes**
    - The Python environment depends on `ocp-viewer-core>=1.1.2,<1.2.0` (was `>=1.0.13,<1.1.0`): ocp-viewer-core 1.1 runs on ocp-tessellate 3.6, and 1.1.2 brings ocp-tessellate 3.6.2 (`render_mates` works where nanocct is installed) and `pbr_to_vis_material(..., like=)`. The floor is 1.1.2 because an existing environment keeps the core it has locked while that still satisfies the range
    - The native-tessellator toggles are gone: `enable_native_tessellator()`, `disable_native_tessellator()`, `is_native_tessellator_enabled()` and `init_native_tessellator()` are no longer exported, and `NATIVE_TESSELLATOR` in the environment no longer means anything. ocp-tessellate dropped its native tessellator and `ocp_addons`, and ocp-viewer-core the toggles with it
    - Breaking: repeated object names are numbered from 0 by default (`python_enumeration`, above), so a tree path such as `/Group/Solid(2)` now names the third `Solid`, not the second. Animation tracks, saved states and selections that address such paths need the new names, or `python_enumeration=False` - as the setting, through `set_defaults` or as a show keyword - which restores the former names
    - Breaking, for scripts that import from the libraries directly: `ocp_tessellate` no longer re-exports OCCT classes (`ocp_tessellate.ocp_utils.TopoDS_Shape`, `ocp_tessellate.tessellator.gp_Pnt`, ...), import them from OCP or nanocct; `ocp_viewer_core.measure.get_center` returns `(x, y, z)` instead of a vertex

- **Fixes**
    - The center distance between two build123d parts works; wires, shells, compsolids and compounds failed. The properties tool reports the length of a wire and the area of a shell
    - Reference points (centers of mass) of vertices, edges and compounds of faces, edges or vertices are right; they came out at the origin
    - An unknown matplotlib colormap name (`"mpl:nonexistent"`) is reported as unknown instead of as "not a linear segmented colormap"
    - An object whose `is_empty` is true is shown as the empty placeholder, like an empty list
    - A loaded animation no longer keeps the viewer redrawing the scene on every display frame until it is cleared - also while paused, stopped or never started - which cost constant CPU and GPU time in an idle viewer (three-cad-viewer 5.1.3, [three-cad-viewer #44](https://github.com/bernhard-42/three-cad-viewer/issues/44)). Resuming after a pause no longer jumps ahead by the time spent paused

## 0.8.0 (2026-09-21)

**New features**

- **A parameter panel for your model.** Put `@ui({...})` from `build123d_studio` on the function that builds your model, and Studio opens a small floating window with a control per parameter — a checkbox, a dropdown, a slider, or a number field with step buttons — grouped and labelled as the decorator says. Every change calls the function again and shows the result; **R** puts the values back to the script's, `Escape` or ✕ closes the window and **View ▸ Toggle Parameters** brings it back. The signature stays plain Python: types and defaults come from it, and the decorator adds only what a signature cannot say. See the Parameters chapter in the documentation and `examples/candle_stand.py`.

## 0.7.1 (2026-09-18)

**New features**

- **A scrollbar for the tab strip and the toolbar.** When the tabs or the buttons no longer fit, a thin bar along the row's bottom edge shows how much is out of view and can be dragged — on every platform, not only macOS.
- **Preview tabs, as in VS Code.** A single click on a file in the tree opens it in a preview tab — its title in italics — and the next single click replaces that tab instead of adding another. A double-click on the file or on the tab keeps it, and so does editing it. Which tab is the preview survives a restart.
- **Pictures open in a tab.** A click on a `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` in the file tree shows it in a tab of its own, fitted to the pane — viewing only. SVG still opens as text.
- **Run a Makefile target from the file tree.** Right-click a `Makefile` and its targets are listed below a line as _Make ▸ build_, _Make ▸ test_, …; picking one runs `make <target>` in the Makefile's folder, with the output in the Run/Debug pane and the same Stop as a test run. The list is read from the file at every right-click, and it appears only when `make` is on this machine.
- **A warning when another viewer's package is imported.** `import ocp_vscode`, `jupyter_cadquery` or `ocp_viewer` in a cell or the console prints a sentence saying that its `show()` talks to a viewer that is not this one — and would wait for it — and names the import to use instead. The import itself is untouched.

**Fixes**

- **Code completion is back.** Since 0.7.0 the suggestion list never opened — not for `Bo`, `import build1` or `b.bou` — while parameter hints and hover still worked. Fixed; and the _View Problem_ action, missing from the hover over an error since the same change, is back with it.
- **A console that exits comes back on its own.** Ctrl-D or `exit` at the console prompt used to leave `[console exited]` and Restart Kernel as the only way back — which threw the session's variables away for a client that had merely quit. The console is replaced by itself now; the kernel and its namespace stay.
- **Selecting text in the Run/Debug or Backend tab stays in that tab.** Dragging upward out of either used to go on selecting the editor's code.
- **Pressing Test or Make while a run is going no longer crashes the application.** The "Something is already running" notice is shown as a dialog, as intended; it used to take the whole window down, and Run File under a debug session had the same trap.
- **Runs see your PATH.** Everything Studio starts — the kernel, the console, Run File, tests, make — used to inherit the launcher's four system directories, so a Makefile's `python` or `pytest` was "command not found". The environment's own `bin/` now comes first, followed by what your login shell puts on PATH (Homebrew and the like), asked of your account's default shell once at startup.
- **GitHub package sources no longer vanish for a session.** The check for `git` — and now `make` — is more robust now and doesn't wrongly flag its absence.
- **No more "The kernel did not stop" over an idle kernel.** An interrupt with nothing running is ignored instead of being sent, waited on for five seconds and then blamed on the kernel. Every interrupt is now written to the log with what asked for it.

## 0.7.0 (2026-09-17)

**New features**

- **Show a CAD file from the file tree.** Right-click an STL, STEP (`.step`, `.stp`), BREP, DXF or SVG file and choose _Show_: it is imported with build123d's importer and shown. The command runs in the console, so it can be copied into a script, and the result is available as `_imported` — also in the variable explorer. Keep it under a name of your own with `part = _imported`. A click still opens the file in the editor, as for any file.
- **Filter the file tree.** A filter box under the tree's header narrows it to what you type — `robot` for a name you half remember, `.py` or `.stl` for an extension. It filters what the tree has already read; a folder you have not opened stays, and opens filtered.
- **Filter and sort the variable explorer.** A filter box above the table narrows the rows to names (or build123d labels) containing what you type; Escape clears it. Clicking _Name_ or _Type_ sorts by that column — again to reverse, a third time for the original order.
- **Select variables in the explorer.** A click on a row selects it; the chevron opens it. Cmd/Ctrl-click adds to the selection and Shift-click extends it. Right-click → _Show_ shows everything selected in one `show(a, b, c, names=["a", "b", "c"])`, so the viewer's tree carries the variable names, and _Copy_ copies the names as `a, b, c`. Rows below a variable have no name of their own, so neither applies to them.
- **Geometry opens to its values in the explorer.** A `BoundBox` shows min, max, size, center and diagonal; a `Vertex` or `Vector` its coordinates; `Location` (and `Pos`, `Rot`), `Axis` and `Plane` their position and directions — instead of "no further detail". Edges, wires and lines list their start and end point (what `line @ 0` and `line @ 1` give), and edges and faces say what geometry they are — line, circle, bspline, plane, cylinder, sphere…
- **A camera shortcut beside the console tabs.** The button at the right of the tab row shows whether the next `show()` resets the camera (the kernel's `reset_camera` default): a flip-camera icon means it resets, a photo-camera icon means it is kept. A click switches the default with `set_defaults(reset_camera=…)`, visible in the console. It is a session default; a kernel restart brings the Settings value back.
- **Snippets are now an editable file.** `snippets.json` in the settings directory is created from the shipped set on first start and read at every start and whenever Settings is applied. Edit, add or remove entries there; delete the file to restore the shipped set.
- **JSON, YAML and TOML in the editor.** `.json` files are highlighted, folded and checked for syntax errors by Monaco's JSON service — as JSONC, so the comments and trailing commas in `snippets.json` are fine; `.yaml`/`.yml` and `.toml` files (`pyproject.toml`) are highlighted. Neither is sent to ruff or the Python language server — and nor is anything else that is not Python any more.
- **Open a file from About.** The log files, the snippets file and the kernel's connection file in Help → About have an _Open_ button beside _Copy_ that opens them in the editor.
- **Startup diagnostics.** The log begins with the machine's details (OS, memory, disk space, relevant environment variables — credentials redacted) and records the exit code of every command. When the environment cannot be prepared, the splash shows the underlying error, including the shell's or curl's own message, and the path of the log file.

**Fixes**

- **three-cad-viewer 5.0.7.** Fixes a memory leak that made showing several large assemblies exhaust the window's memory, after which the viewer stopped rendering or the window reloaded.
- **A first start no longer fails on Windows machines whose command prompt is broken** by a stale AutoRun registry entry (what an uninstalled Anaconda leaves behind); the splash explains the entry instead.
- **Kernel indicator.** Stays on _busy_ while a queued run waits for a long-running import to finish.
- **Recovery after a window reload.** If the window is reloaded (for example after running out of memory), the previous kernel is stopped instead of being left running, and a viewer that can no longer draw is reported as _failed_ in the toolbar with a hint to restart.
- **Window position** is restored against the displays that are actually connected; the permission for this was missing.

## 0.6.5 (2026-09-16)

- **Viewer modifier keys work on Windows and Linux.** The key map from Settings now reaches the viewer, including the startup logo, and a change under Settings → Viewer → Modifier keys takes effect at the next `show()`.
- **Windows: viewer settings reach `show()`.** The kernel now reads `settings.json` from its actual location; since 0.5.0 it had silently used the shipped defaults.
- **ocp-viewer-core from GitHub** can be selected again as a package source.

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
