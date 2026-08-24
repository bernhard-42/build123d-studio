# build123d Studio

An IDE for [build123d](https://github.com/gumyr/build123d): a Monaco editor, a [three-cad-viewer](https://github.com/bernhard-42/three-cad-viewer) viewport, a real [Jupyter console](https://github.com/jupyter/jupyter_console) and a variable explorer, in one window, with an encapsulated Python environment it builds for itself on first start.

![build123d Studio on macOS: the file tree and tabs, an editor holding a hexapod assembly script, the viewer showing the assembled model with its object tree, the Jupyter console below, and the variable explorer expanded on the assembly's topology](build123d-studio-mac.png)

_The four panes, all describing the same object: the script that built the hexapod, the model it produced, the console it printed to, and the assembly unrolled by its children in the explorer._

## What it is

A desktop application running on macOS, Windows and Linux, for writing build123d code and seeing the result. It is one window with four panes — editor, 3D viewer, console, variable explorer — and it brings its own Python.

- **You do not need a Python environment, and you do not need to know how to make one.** There is nothing to `pip install`, no virtualenv to activate, no interpreter to choose. On first start the application downloads a pinned CPython and a pinned [uv](https://github.com/astral-sh/uv), builds a virtual environment of its own and installs build123d and everything else it needs into it. It never touches a system or user Python, and nothing it does is visible to any other Python on the machine.

- **One release is one environment.** A given build pins one uv and one CPython — 3.14.6 today — so two people running the same release get the same interpreter and the same packages, rather than whatever happened to be current on the day each of them first started it. Both move when the application is rebuilt and retested.

- **Everything it writes lives in one per-user directory** which holds the environment, the settings and the log:
  - `~/Library/Application Support/build123d-studio` on macOS
  - `%APPDATA%` on Windows
  - `~/.local/share` on Linux

  The application's own directory is never written to, so it can be installed read-only. Uninstalling does not remove the environment; the path is in the About dialog and in the log.

## Installation and first run

See [FirstRun.md](./FirstRun.md)

## Two ways to run your code

This is the thing worth understanding before anything else, because they behave differently on purpose.

### On the kernel

`Run Cell`, `Run Selection` and `Run All` send code to a Jupyter kernel that stays alive between runs, and the console at the bottom is a real `jupyter console` attached to that same kernel. So everything you run leaves its names behind, and you can poke at them in the console afterwards — build a shape with Shift-Enter, then type `part.volume` below and get an answer. The variable explorer shows that same namespace and expands on demand.

`# %%` on its own line marks a cell boundary, as in Jupyter and VS Code. `Run Cell` runs the cell the cursor is in and moves to the next; Ctrl-Enter runs it and stays put.

This is the mode for building something up incrementally, and it is where the application's Jupyter heritage shows.

### As a file, in a process of its own

`Run File` and `Debug File` save the buffer and run the _file from disk_ in a separate process, with the same interpreter and the same environment. Nothing it defines reaches the kernel, and when it ends the process is gone with everything in it.

That is the mode for "does this script actually work from a clean start", and it is what you want when the kernel's accumulated namespace is hiding a missing import.

Both still draw: a `show()` in the file reaches the same viewer, because the process is given the viewer's address. Output appears in the **Run/Debug** tab beside the console, and while a session is running the panes describe _that_ process rather than the kernel — one rule, so there is never a question of which one you are looking at.

**Debugging** adds breakpoints — click the gutter — with step controls that appear in the tab strip, a call stack, and the variable explorer showing the paused frame. There is a hook that runs an expression every time execution stops, defaulting to drawing whatever the current frame holds, so stepping through a model is watching it being built.

### Drawing anything

```python
from build123d import *
from build123d_studio import show

b = Box(1, 2, 3)
show(b)
```

`show_all()` draws everything drawable in scope, which is usually what you want while exploring. New files start from a template with this in it, and the template is editable in Settings.

## The toolbar

Left to right, in four groups.

| button                   | what it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| **Toggle the file tree** | Shows or hides the folder sidebar.                                                                 |
| **New File**             | A new buffer from the template in Settings.                                                        |
| **Open File**            | Opens a file in a new tab.                                                                         |
| **Save File**            | Saves the active tab; formats it first if Format on Save is on.                                    |
| **Run File**             | Saves, then runs the file from disk in its own process. `Ctrl-F5`                                  |
| **Debug File**           | The same, with a debugger attached. `F5`, which also resumes a paused session.                     |
| **Run Cell**             | Runs the `# %%` cell at the cursor on the kernel, and moves to the next. `Shift-Enter`             |
| **Run Selection**        | Runs the selection on the kernel, or the current line if there is no selection. `Ctrl-Shift-Enter` |
| **Run All**              | Sends the whole buffer to the kernel. `Alt-Enter`                                                  |
| **Restart kernel**       | Throws the kernel away and starts a new one. The namespace goes with it.                           |
| **Interrupt**            | Interrupts what the kernel is running.                                                             |
| **kernel indicator**     | `starting`, `idle` or `busy` — and it only says busy for code _you_ ran.                           |
| **Settings**             | Packages, editor, new-file template, debugging, and the keyboard shortcuts.                        |
| **About**                | Version, the environment path, the log paths, and this instance's Jupyter connection file.         |
| **Command Palette**      | Every editor command by name. `F1`                                                                 |

While a run or a debug session is active, the step controls — continue, step over, step into, step out, restart, stop — appear in the tab strip.

## Keyboard

The defaults, all editable in Settings.

| chord                                       | action                             |
| ------------------------------------------- | ---------------------------------- |
| `Shift-Enter`                               | Run cell, move to the next         |
| `Ctrl-Enter` (also `Cmd-Enter` on macOS)    | Run cell, stay                     |
| `Ctrl-Shift-Enter` (also `Cmd-Shift-Enter`) | Run selection, or the current line |
| `Alt-Enter`                                 | Run all                            |
| `Ctrl-F5`                                   | Run file                           |
| `F5`                                        | Debug file, or continue            |
| `Shift-F5`                                  | Stop debugging                     |
| `Ctrl-Shift-F5`                             | Restart debugging                  |
| `F10` / `F11` / `Shift-F11`                 | Step over / into / out             |
| `Shift-Alt-Cmd-R` (`Ctrl-Shift-Alt-R`)      | Restart the kernel                 |

The two cell chords are Jupyter's, deliberately. The debug chords are VS Code's.

`F1` opens the command palette, which lists every editor command by name — find, replace, comment toggling, folding, formatting and the rest. It comes from Monaco rather than from the table above, so it is not editable here and it only works while the caret is in the editor; the toolbar button works from anywhere.

## Opening a folder

`Open Folder` gives you a file tree and makes that folder the project: the kernel's working directory is the folder root and stays there, so a relative path in your code means the same thing wherever the file you are editing sits. With no folder open, the working directory follows the active file instead.

One folder is open at a time. Opening another closes the tabs from the old one, asking once about anything unsaved.

## The `studio` command

A small launcher ships beside the application. Copy it somewhere on your `PATH` and then `studio`, `studio .`, `studio some/folder` or `studio part.py` opens that path in a new window — a file opens its containing folder as the project, so the kernel starts where you were. Run the application once first: it records its own location on every start, which is how the script finds it.

## Settings → Packages

Reached from the application menu. The tab reads top to bottom as three things you can do, each with the button that does it directly underneath:

```
build123d        ( ) PyPI  ( ) GitHub dev branch  ( ) Local checkout [path] [Choose…]
ocp-viewer-core  ( ) PyPI  ( ) GitHub main branch  ( ) Local checkout [path] [Choose…]
               [ Re-install build123d ]

Additional packages
               ┌────────────────────────┐
               │                        │
               └────────────────────────┘
               [ Install packages ]

Upgrade        [ Upgrade packages ]

                                          [ Cancel ]  [ Apply ]
```

**Only Apply and Cancel close the dialog.** Install, Re-install and Upgrade act on the environment and return to it, on success as well as on failure — so there is never a question of what happened or where you now are.

| button                   | what it does                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Apply**                | Saves every field and closes. Touches nothing else — no uv, no kernel restart.                                                                                                                                                                                       |
| **Install packages**     | Saves, then makes the environment match what is declared: `uv lock` then `uv sync`. Adds what is new and leaves every already-locked package where it is.                                                                                                            |
| **Re-install build123d** | Saves, then `uv sync --reinstall-package build123d`. A local checkout is installed _editable_, so ordinary code edits are already live and this is not needed for them — it is for when the package's own metadata changes, such as a new dependency or entry point. |
| **Upgrade packages**     | Saves, then `uv lock --upgrade` then `uv sync`. Every package moves as far as its own version range allows: `build123d` to any newer release, `ocp-viewer-core` within its minor. Everything else is pinned exactly and cannot move at all.                            |

Saving without installing is coherent: the application runs `uv sync` on every launch, so a change that was applied but not installed simply lands at the next start.

### Additional packages

One requirement per line. The line itself says where the package comes from — there is no source picker, because the string is the source:

```
ocp-widgets>=0.3                              PyPI, with or without a version range
/Users/me/src/mylib                           a local checkout, installed editable
git+https://github.com/someone/mylib@main     a git repository
mylib @ git+https://github.com/x/python-lib   named explicitly
```

A local checkout is installed editable, so what you edit is what runs. Give the full path: this is a dialog rather than a shell, so `../src/mylib` has nothing to be relative to and is refused — uv would resolve it against the environment directory, and the bad case is not the one that fails but the one that finds a different directory of the same name.

The name is taken from the last path segment when it is not given, which is right for most repositories and wrong whenever the distribution is not named after its folder — `python-foo` shipping `foo`. The `name @ source` form is the way to say so.

Two rules are enforced here, and only two:

- a package the application already declares — `build123d`, `ocp-viewer-core`, `jupyter_console`, `orjson`, `websockets`, `pywinpty` and `basedpyright` — cannot be named, because uv _intersects_ duplicate declarations rather than letting the later one win, so such an entry would silently do nothing. Anything they bring in is fair game: `ocp-tessellate`, `ipykernel`, `prompt_toolkit` and the rest arrive under a parent that owns their range, and constraining one of those is yours to do
- the same package cannot be given twice

Everything else — whether a version exists, whether a combination resolves, whether a URL is reachable — is uv's to answer, and it answers better than a rule here would. A line that breaks the environment does not prevent the application from starting: the failed section is dropped for that launch, with the text left in Settings to be corrected.

## Opening projects from a terminal

Each package carries a `studio` launcher beside the application. Copy it somewhere on your PATH — it does not have to stay where it came from, and nothing needs installing with a password:

```
cp "/Applications/build123d Studio.app/Contents/MacOS/studio" ~/bin/studio   # macOS
cp /path/to/build123d-studio/studio ~/bin/studio                             # Linux
copy C:\path\to\build123d-studio\studio.cmd %USERPROFILE%\bin\studio.cmd     # Windows
```

Then, from any project directory:

```
studio                  # open this directory as the project
studio /path/to/folder  # open that folder as the project
studio main.py          # open main.py, with its folder as the project
```

Every form starts a new instance, so several projects can be open at once. That matters most on macOS, where double-clicking an already-running application activates the existing window rather than starting a second one — `studio` is the only way to get two there.

Start the application once before using it. The launcher finds the application by reading a location the application records on each start, which is what lets you copy it anywhere.

## When something goes wrong

Two places say what happened, and between them they cover most of it.

**The log.** Everything the application reports about itself is appended to `build123d-studio.log` beside the environment — on macOS `~/Library/Application Support/build123d-studio/`, and the equivalent elsewhere. It carries the kernel's lifecycle, what the sidecar did, uv's own output while the environment is being built, and every warning the frontend raises. It is the first thing to attach to a report.

**The measurement backend has a tab of its own.** The bottom pane's third tab, **Backend**, shows what that process says as it says it — which shape id was clicked, what it indexed, why a measurement could not be taken. It runs in a process of its own, its troubles are frequent, and a log file you have to go looking for is the wrong first place for them. Read-only; the same lines also go to `backend.log`, which is what a report can attach.

**And `console.log`**, the browser's own output: what the embedded browser and the libraries inside it print — a renderer complaining about a malformed model, a failed request, an uncaught error with its stack. It is a separate file on purpose, so that turning it up does not bury the application's own account of what happened.

How much is captured is **Settings → Application → Debug console**: errors by default, warnings, everything, or nothing. Turn it up to reproduce something, and remember that everything can be a great deal — each file rotates at a megabyte, keeping one previous copy. All three are named in **Help → About**, so a report can carry the right ones.

That file exists because on macOS there is no developer console to open: Safari lists an embedded web view only when the application marks it inspectable, which macOS has required since 13.3 and this toolkit does not do. On Windows and Linux the embedded browser's own Inspect entry may be available by right-clicking, and the window is configured to allow it.

## Licence

Apache-2.0. See `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.md`.
