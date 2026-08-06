# build123d Studio

An IDE for [build123d](https://github.com/gumyr/build123d): a Monaco editor, a three-cad-viewer viewport, a real Jupyter console and a variable explorer, in one window, with an encapsulated Python environment it builds for itself on first start.

![build123d Studio on macOS: the file tree and tabs, an editor holding a hexapod assembly script, the viewer showing the assembled model with its object tree, the Jupyter console below, and the variable explorer expanded on the assembly's topology](build123d-studio-mac.png)

*The four panes, all describing the same object: the script that built the hexapod, the model it produced, the console it printed to, and the assembly unrolled by its children in the explorer.*

## What it is

A desktop application for writing build123d code and seeing the result. It is one window with four panes — editor, 3D viewer, console, variable explorer — and it brings its own Python.

**You do not need a Python environment, and you do not need to know how to make one.** There is nothing to `pip install`, no virtualenv to activate, no interpreter to choose. On first start the application downloads a pinned CPython and a pinned [uv](https://github.com/astral-sh/uv), builds a virtual environment of its own and installs build123d and everything else it needs into it. It never touches a system or user Python, and nothing it does is visible to any other Python on the machine.

**One release is one environment.** A given build pins one uv and one CPython — 3.14.6 today — so two people running the same release get the same interpreter and the same packages, rather than whatever happened to be current on the day each of them first started it. Both move when the application is rebuilt and retested.

Everything it writes lives in one per-user directory — `~/Library/Application Support/build123d-studio` on macOS, `%APPDATA%` on Windows, `~/.local/share` on Linux — which holds the environment, the settings and the log. The application's own directory is never written to, so it can be installed read-only. Uninstalling does not remove the environment; the path is in the About dialog and in the log.

It runs on macOS, Windows and Linux.

## Installing, and the first start

Install it the ordinary way for your platform: drag the `.app` to Applications, unzip the Windows package where you like it, or make the AppImage executable.

**The first start takes a few minutes and shows you what it is doing.** A splash overlay reports each step while it downloads uv, downloads the interpreter, and installs the packages — several hundred megabytes in total, most of it the language server and the OpenCascade bindings. It needs a network connection exactly once.

**Every start after that goes straight to the window.** The environment already exists, so all that happens is a reconciliation against the locked package list, and the window is up while the kernel warms in the background. The kernel indicator in the toolbar says `starting`, then `idle`, and you can type before it gets there.

If something goes wrong on that first start, the log says so — its path is in the About dialog.

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
build123d      ( ) PyPI   ( ) GitHub dev branch   ( ) Local checkout [path] [Choose…]
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
| **Upgrade packages**     | Saves, then `uv lock --upgrade` then `uv sync`. Every package moves as far as its own version range allows. Anything pinned to an exact version cannot move, which is what holds the viewer's packages still.                                                        |

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

- a package the application already declares — `build123d`, `ocp_vscode` and the rest — cannot be named, because uv _intersects_ duplicate declarations rather than letting the later one win, so such an entry would silently do nothing
- the same package cannot be given twice

Everything else — whether a version exists, whether a combination resolves, whether a URL is reachable — is uv's to answer, and it answers better than a rule here would. A line that breaks the environment does not prevent the application from starting: the failed section is dropped for that launch, with the text left in Settings to be corrected.

## Licence

Apache-2.0. See `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.md`.
