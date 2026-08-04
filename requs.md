# build123d Studio - an IDE for build123d

## Phase 1

The name is deliberately not tied to a single library. "OCP" is the OpenCascade Python bindings today; should those be replaced (OCCT-Light, say), the initials can be read as "open-source CAD project" and the name still fits.

**Platforms**

- Windows, Linux and MacOS
- Based on neutralinojs 6.9.0, frontend bundled with Vite

**Self-containment**

- No fixed/well-known TCP ports anywhere: port collisions are the problem to avoid, so random or OS-assigned ephemeral ports are acceptable, a hard coded one (such as ocp_vscode's 3939) is not
- Webview <-> sidecar communicate over a WebSocket on a random loopback port. The sidecar is spawned via spawnProcess, binds port 0, and announces `{"port", "token"}` on stdout; the webview then connects. A listening socket is reachable by any local process, unlike a pipe, so the connection is authenticated with a random token
- Control messages are JSON text frames. Console keystrokes/output and the tessellated model are binary frames, so the hot paths carry no base64
- Closing the sidecar's stdin remains the shutdown signal, because it cannot be missed if the webview dies abruptly
- Kernel -> sidecar "show" payloads go over a loopback TCP connection on an OS-assigned port, authenticated with a random token. Unix sockets would avoid the port but do not exist on Windows, and one mechanism that works on all three platforms beats two, one of which is missing
- Sidecar <-> kernel use the Jupyter ZMQ protocol over tcp on ephemeral ports. ZeroMQ's ipc:// was tried and dropped: AF_UNIX paths are capped near 104 bytes and jupyter_client derives them from the connection file, so the transport silently depended on how long the install path was - ipc in a development tree, tcp under "~/Library/Application Support". The channels are HMAC-signed with the key in the 0600 connection file, so loopback reachability is not authority
- ipykernel additionally opens one random loopback port for debugpy
- Nothing needs to reach the viewer from outside the application

**UI**

- Four panes in two columns and two rows, boundaries draggable to resize:
  - top left: monaco editor
  - top right: three-cad-viewer
  - bottom left: jupyter console
  - bottom right: variable explorer
- Pane sizes persist across restarts

**Editor**

- Python with build123d
- Run whole file, run "# %%" cell at cursor, or run selection / current line
- Execution goes to the kernel over ZMQ, not typed into the console

**Viewer**

- "show" reuses ocp_vscode's `_convert()` so ocp_tessellate tessellates the build123d objects, but sends the result over the local socket instead of ocp_vscode's websocket transport
- The model payload is a JSON header plus concatenated raw buffers, sent to the webview as one binary WebSocket frame. The header is padded to an 8-byte boundary, so the tessellated arrays become zero-copy typed-array views over the received ArrayBuffer - no base64, no JSON parsing of numeric data. stdio carries the handshake line and nothing else
- Exact measurement reuses ocp_vscode's ViewerBackend, subclassed to return responses in-process rather than sending them

**Console**

- Real "jupyter console --existing" in a PTY, displayed with xterm.js: one transcript, inline `In[n]:` prompt, full IPython line editing and magics
- Shows output of every client, so editor runs appear inline as `In[n]:` (include_other_output, with the remote prefix emptied)
- Ships a ZMQTerminalInteractiveShell subclass that prints external iopub output through prompt_toolkit's `run_in_terminal`, fixing the cr/nl staircase and the intermittently missing prompt. `patch_stdout` is the obvious tool and the wrong one: its StdoutProxy holds back any trailing partial line, and a prompt is exactly that, so prompts disappeared
- The kernel connection file is written to a discoverable path so an external jupyter console can attach to the same namespace

**Variable explorer**

- Inspects the kernel namespace via silent user_expressions, never echoing into the console; refreshes when the kernel goes idle; expands on demand
- Listing is cheap and expanding is bounded. Nothing that computes geometry runs on a refresh, and an expansion buys only what a click can afford: measured on a suspension assembly, `bounding_box()` costs 19 s, volume 2.8 s and area 2.2 s, none of them cached. Those belong in the console, where the user asks for them and can see the cost

**Python environment**

- Based on astral's uv, which the application downloads on first start and keeps in the environment directory. Not bundled: it is 50 MB in every package for a tool that has to be fetched on some platforms anyway
- One release of build123d Studio pins one uv and one exact CPython (src/bootstrap/pins.json). A release is a support target: with uv floating on "latest", two people running the same build123d Studio could have different uv versions and different interpreters depending only on what was current the day each of them first started it. Nobody reports 3.14.6 versus 3.14.7, and nobody mentions that their uv shipped that morning. Both move when the application is rebuilt and retested, which is also when a CPython patch - including a security one - reaches users. That cost is accepted deliberately in exchange for a fixed, answerable configuration
- The SHA-256 of every uv artifact is committed to this repository and checked after the download, on every install. It is not fetched: the .sha256 files published beside the archives sit on the same release page as the archives, so whoever could replace one could replace the other - they prove a download is intact, not that it is the artifact this application was built against
- Provenance is verified once, when the pin is recorded, by a maintainer running "gh attestation verify --repo astral-sh/uv" - a real Sigstore signature chain and transparency log, with a human reviewing the change. Not at runtime: that meant an unauthenticated GitHub API call on the first-start path which had to fail open when the API was unreachable or rate-limited, so the strength of the check depended on the network
- "Upgrade packages" upgrades packages. It does not touch uv or the interpreter: uv no longer chooses the Python version, so refreshing it would only swap the tool that built the environment underneath a user who is chasing a package problem
- Fully self-contained: the interpreter, venv and cache are the application's own and never touch a system or user Python
- They live in the per-user app-data directory (resolve_env_root): `~/Library/Application Support/build123d-studio` on MacOS, `%APPDATA%` - Roaming, not Local - on Windows, `~/.local/share` on Linux. Never in the application's own tree, even where that is writable: preferring the app tree and falling back here meant development exercised one branch and every packaged install the other, so the configuration that ships was the one least tested
- uv.lock ships with the application and is staged into the environment on every start, so "uv sync --frozen" reconciles an environment built by an earlier version after an app update
- Uninstalling the application does not remove the environment; the path is logged at startup
- Everything else the application writes goes to the same per-user directory, beside the environment rather than inside it, so a clean rebuild of the environment does not discard it: settings.json (theme, splitter positions, package sources) and build123d-studio.log. Neither Neutralino's .storage nor its neutralinojs.log is used, because both write into the application's own directory

**Read-only installation**

- The application writes nothing into its own directory, so it can be installed read-only: a .app dragged to /Applications, an install under Program Files, an AppImage's read-only mount
- One exception is not ours: Neutralino saves .tmp/window_state.config.json beside its binary on every window close. The path is hardcoded, modes.window.useSavedState governs only restoring, and the save is an uncaught create_directories - so on a read-only directory the process aborts instead of degrading, and closing the window crashes
- Packages therefore ship an empty .tmp directory, because create_directories succeeds on a path that already exists. Everything else can be read-only
- That is not enough for an AppImage, where the whole mount is read-only, so AppRun stages a directory of symlinks into the mount under ~/.local/share and passes it as --path, which is what sets NL_PATH
- Installs the required packages via "uv sync" on first start, with progress shown in a splash overlay
- Packages can be upgraded from the UI ("uv lock --upgrade" then "uv sync")
- Dependencies are pinned to exact versions

## Phase 2 "Code review of phase 1"

- Deep Architecture review
- Deep Security review (including check for supply-chain-attacks)
- Fix all findings

Done, released as v0.2.0. What was wrong and why it mattered, grouped by what a user would have noticed. The how is in the commits.

**Windows could not run the application at all.** Neutralino's spawnProcess replaces a child's environment instead of adding to it, and builds it as UTF-16 while telling Windows it is ANSI - so uv never started, and the sidecar had been running on macOS with no PATH and no HOME since Phase 1. Then three deadlocks, all one platform property: on Windows, loading a native extension blocks thread creation, so importing OCP anywhere near a thread being started hung the application. It cost every Run in one place, sixty seconds per show() in another, and the console's whole startup in a third.

**Work could be lost silently.** A save that failed looked exactly like one that worked, and quitting after one discarded the buffer the user had just asked to keep. Saving through a symlink destroyed the link and orphaned the real file, reporting success each time. Nothing on screen ever said a buffer differed from disk.

**The application could go quiet and stay quiet.** A kernel that died - running out of memory tessellating a large model is the ordinary way - left the toolbar reading "busy" for ever, because a dead ZMQ peer raises nothing. A restart could leave two threads on one socket. A variable expansion that cost more than fifteen seconds left the row saying "loading" until the application was restarted; on a real assembly the bounding box alone cost nineteen.

**The variable explorer broke permanently on a large namespace.** Past a thousand names the answer came back truncated with an Ellipsis in it, which then failed to serialise on every idle from then on. `from sympy import *` was enough.

**Things that were trusted and should not have been.** The webview read lengths off the wire and used them to index a buffer with no bounds check. A quote in a Windows path escaped the command line, and the test that certified it safe modelled the wrong parser. Any local process could hold the model socket open and stop the viewer working. The pin file named a tool that verified uv's provenance, and that tool did not exist.

**And the reason several of those shipped at all:** there was no linter, and nothing tested the application above the level of a single function. Both now exist and run on every change.

## Phase 3 "Ensure ipc, comms and threading are sound"

- Write tests for ipc, communication and threading
- one owning thread per zmq socket, with request/reply futures instead of a shared socket under a lock
- Make the log append-only. Pulled forward from the instance model in Phase 4 because it is what everything else is diagnosed from: two instances currently read and rewrite it at startup and truncate each other, so the file misrepresents what happened exactly when something went wrong. Each line should also carry which instance wrote it, or two interleaved runs cannot be told apart

Done. What changed, and why it was worth doing.

**Three fixes stopped being arguments.** M3, §3.3.7 and the internal-request record were fixed in Phase 2 by reading the code and reasoning about it, and nothing distinguished a race that had been cured from one that had merely stopped showing up. They are now reproduced. The technique is race widening - hold a thread exactly where the unlucky one would have been, then do the thing the race needs - and it turns a window a few instructions wide into an instruction. Running the code more often does not work and this project has the evidence: the pre-fix code passed three times out of three against a 46 MB assembly. Measured instead: 100 internal requests misread as user activity out of 100, against none.

**The rule about the shell socket became a property of the design.** "Only one thread at a time may touch this" was a lock that four separate callers had to remember - the channel thread for a Run, the iopub pump for the refresh after an idle, the pty reader and a fallback timer for the warm-up - and getting it wrong interleaves the frames of two messages on the wire, which the kernel reports as "Invalid Signature". One thread owns the socket now and the only way to reach it is to put a request in an outbox, so a caller who has never heard of the rule cannot break it.

**Replies go to whoever asked for them.** Serialising the reads was never enough, because whoever held the lock took whatever reply arrived: an inspection polled in slices, discarded what was not its own, and relied on the real consumer coming back for it - which worked only because exactly one caller ever awaited a reply. That is a coordination requirement between parts of the application that have no other reason to know about each other. Futures keyed by request id remove it, and two consequences follow for free: inspections can overlap instead of queueing, and one caught by a restart is answered at once instead of holding the inspect lane for fifteen seconds waiting for a kernel that has gone.

**And the log stopped losing the evidence.** Of fifteen launches on one machine, four looked broken in the log and only one was; the rest were lines another instance had truncated.

## Phase 4 "Feature release"

### 1. Usability (quick wins)

- Add an OS menu to get Cmd-C/Cmd-V/Cmd-X. Would also deliver Cmd-Q, ... (a prerequisite for code completion in group 3: without it macOS never binds the standard shortcuts, so Ctrl-Space is swallowed by the system's input-source shortcut). Same for Windows and Linux including typical short-cuts on these OS.

  `Neutralino.window.setMainMenu` is the API and it exists in the pinned 6.9.0 - checked in the JS client and in all three native binaries. The comment in `src/main.js` claiming "Neutralino creates no native menu bar" is stale, and the hand-rolled Cmd-Q keydown handler underneath it exists because of that belief; both go when the menu lands.

  | menu | items                                                                                |
  | ---- | ------------------------------------------------------------------------------------ |
  | File | New, Open File…, Open Folder…, Save, Save As…, Save All, Close, Close All, Close Tab |
  | Edit | Cut, Copy, Paste                                                                     |
  | Run  | Run Cell, Run Cell (Keep Cursor), Run Selection or Line, Run File                    |

  The File items that need tabs - Save All, Close All, Close Tab, and Open Folder itself - are built now and disabled (`isDisabled`) until group 2 enables them. The structure is what is expensive to retrofit; the items are not.

  Four Run items rather than five bindings, because run-selection and run-line share one chord and differ only by whether there is a selection. A menu cannot show the same shortcut twice, so the item is "Run Selection or Line" and the distinction stays where the user actually experiences it.

  Two things to establish on the first build rather than assume. Clicks come back as a `mainMenuItemClicked` event carrying the item id, so **every item's behaviour is ours to implement** - and `WindowMenuItem` has an `action` field which may be a native role, except that no role vocabulary (`copy`, `paste`, `cut`) appears in any of the three binaries. If roles work, Edit is trivial; if not, Cut/Copy/Paste needs a focus-aware dispatcher, because Monaco has its own clipboard actions, xterm.js needs the selection written out and pasted text pushed to the pty, and dialog inputs are a third case. Either way the menu solves the problem it was added for, which is getting the keystroke _delivered_ rather than swallowed.

  Menu behaviour also differs by platform - a system bar on macOS, inside the window elsewhere, which may shift the pane layout and make stored splitter positions mean something slightly different across an upgrade. Worth a real build on each early rather than at the end of the group.

  The menu is a pure function of state - which items are enabled, and what each one's shortcut currently is - so it is rebuilt rather than mutated, and that function is unit-testable without a window.

- **The application must never reload.** There is no guard today: the only global key handler is Cmd/Ctrl-Q, so an accidental F5 (Windows, Linux) or Cmd-R (macOS) discards the editor buffer and re-runs the whole bootstrap. Same family as the Phase 2 work on losing edits silently, and a prerequisite for binding F5 to anything.
- Logically, idle/busy indicator belongs to kernel button group. Tried in front of the buttons first, as originally written here, and it read as a _label for_ them rather than as the kernel's state - a word followed by two icons is taken as a caption. So the group is Restart, Interrupt, indicator, and the indicator needs a fixed-width box or the dot slides about as the word changes between "starting", "busy" and "idle"
- Add all log paths to the info box
- Fix the Application icon on MacOS (logo.svg should now be compliant with Apple rules for Tahoe)
- Config should get a multiline field where I can add code that should be used during "New File"
- Five run actions, of which two are bound today and one is implemented but unreachable - `runCell` and `runSelectionOrLine` both take an `advance` flag that nothing ever passes as false.

  | shortcut                                                           | action         | cursor               |
  | ------------------------------------------------------------------ | -------------- | -------------------- |
  | Shift-Enter                                                        | run cell       | next cell            |
  | Ctrl-Enter, and Cmd-Enter on macOS                                 | run cell       | stays                |
  | Ctrl-Shift-Enter, and Cmd-Shift-Enter on macOS, _with a selection_ | run selection  | end of the selection |
  | the same, _with no selection_                                      | run line       | next line            |
  | F5                                                                 | run whole file | -                    |

  Ctrl and Shift throughout, which is Jupyter's own pair for the two cell actions - Shift-Enter to advance, Ctrl-Enter to stay - so the muscle memory that matters most for this audience carries over exactly. macOS additionally accepts Cmd, as Jupyter does there.

  Monaco's modifiers do not line up with that intent and the trap is worth writing down: `KeyMod.CtrlCmd` is Ctrl on Windows and Linux but **Cmd** on macOS, while `KeyMod.WinCtrl` is the Super key on Windows and Linux but **Ctrl** on macOS. So literal Ctrl everywhere is `CtrlCmd` plus, on macOS only, `WinCtrl` - registering `WinCtrl` off macOS would only bind a Super chord the window manager takes.

  **"Run line" means one physical line.** A line that is not valid on its own - `for i in range(5):` - gets the kernel's "incomplete input" back, and that is the shortcut behaving as named. Blocks are what run-cell and run-selection are for, and second-guessing the user by extending to the enclosing statement would make the one literal action ambiguous.

- Keyboard shortcuts are subjective, so the five above are **defaults rather than verdicts**: a defaults map, the bindings read from `settings.json`, and a `parseChord("ctrl+shift+enter")` function turning a VS Code-style string into Monaco modifiers. That parser is a pure function and is where the platform subtlety above lives, so it is unit-testable in the way `quoting` already is. The editing dialog is group 5, where the config dialog is being opened up anyway; nothing is thrown away, because by then actions are already registered from a map instead of from literals.

  The map has to land before or with the menu rather than after it. Menu items carry their own `shortcut` strings, so configurable bindings mean the menu is rebuilt when they change - trivial if both read the same map from the start, and a rewrite if the menu is built from literals first.

### 2. Multi file support

- Open Folder should work as in VS Code with a left sidebar and with tabs for files. tab label is filename with full path on hover

Before the instance model, but not because it replaces it - the two are orthogonal, and V2 says why. It comes first because it is the smaller and safer piece: it is self-contained, every project needs it whether or not a second window is ever opened, and it touches none of the shared state the instance work has to make safe.

**Size.** The largest group so far and laborious rather than risky - unlike Phase 3, where the danger was a race nobody could see, the danger here is forgetting a case. Two things make it smaller than it looks. The single-buffer assumption is concentrated rather than spread: nineteen call sites in `editor/files.js`, fourteen in `editor/monaco.js`, four in `toolbar.js`, and nowhere else. And nothing needs inventing - Monaco holds many models natively (`createModel` and `setModel` against one editor), `filesystem` has `readDirectory` and `createWatcher`, and `os.showFolderDialog` is the Open Folder dialog.

**The pieces, in the order they want building.** Each is a commit; the first is a prerequisite for everything after it.

1. **Many buffers, one editor.** A buffer is a path, a Monaco model, a saved version id and a view state. Today each of those is a single module-level value, and _that_ is the work - the multiplicity itself is a Map. Ships with one tab's worth of behaviour and no visible tabs, so it can be verified before any UI depends on it.
2. **The tab strip.** Label is the filename, the full path on hover. Fiddly rather than deep: overflow, close targets, a dirty mark, and two files of the same name in different folders needing a disambiguating hint.
3. **The sidebar.** The most genuinely new code - a lazily expanded tree, sorted, with `__pycache__` and `.git` filtered out, behind a new splitter whose width persists like the others.
4. **Save All, Close, Close All, and quitting.** The menu already carries these disabled; this enables them. `confirmDiscardChanges` reasons about exactly one buffer today and has to ask _once_ for many rather than once per file.
5. **The workspace, restored.** `lastFile`/`lastPosition`/`lastScrollTop` become a folder, a set of open tabs, which one is active, and a caret for each - with a migration, because an existing installation has the old keys.

**Where this can actually hurt.** Closing a tab must dispose its Monaco model; nothing in the application disposes anything today because nothing has ever needed to, and the leak is invisible until someone has opened forty files. `confirmDiscardChanges` is load-bearing - Phase 2 exists partly because work could be lost silently - and rewriting it for many buffers is the one change here that can lose somebody's edits. A CAD project full of STEP exports is large, so the tree has to expand lazily or Open Folder hangs on it. And `createWatcher` is undocumented enough that live updates should wait: ship a refresh, then add watching once a build has said how it behaves.

Plenty of it is pure and testable in the way the rest of the frontend now is: tab labels and their disambiguation, tree sorting and filtering, workspace serialisation, whether anything is dirty.

Done, in five commits. What changed, and what it cost to find out.

**The single-buffer assumption was concentrated, as hoped, and one of its habits was a bug.** A buffer's path, model, saved version and view state were four module-level values; making them a Map was the whole of piece 1. What it also fixed was undo bleeding between files - opening a file poured it into the previous file's model and carried that file's undo history with it, so Cmd-Z in a freshly opened file could put back a line belonging to a file no longer on screen.

**Two defects were only ever going to be found on a real build, and both looked like something else.** The tree's splitter had no width, because `.splitter-v` positions itself with `grid-column` and the sidebar's row is flex - five pixels of nothing to grab. And `▸`/`▾` have no glyph in WKWebView and render as a dot, so folder rows now use the bundled icon subset, which either renders or nothing does.

**The dirty indicators lied, and the way they lied said where to look.** Undoing back to the saved version left the tab's dot and the title's bullet on - but closing that buffer asked nothing, so the answer was right and only the moment it was asked was wrong: the alternative version id had not settled while the content-change event was being delivered. Deferring the check a tick fixed it without anyone having to know Monaco's internals. Worth remembering that this id tracks undo-stack position rather than content equality, so retyping a deleted character is legitimately still dirty.

**Asking about unsaved work once was the point of piece 4, not Save All.** The prompt had grown from one file to a loop over many, and five questions in a row is how people learn to dismiss a dialog without reading it. One prompt, one list, and the same implementation behind quitting, closing a tab, Close All and both folder commands - which is what stops them drifting into asking differently.

**Open Folder, decided.** One folder at a time, which is VS Code's model without multi-root workspaces - and it is what makes "the project root" a well-defined thing for the kernel's working directory to be.

**A folder is the project, and the project is the whole session.** That is the sentence the rest follows from. Both folder commands take everything with them rather than editing part of it: Open Folder is a context reset and Close Folder is a context close, so the answer to "what happens to my tabs" is always all of them, never some. The alternative - keeping the tabs that happened to live outside the old folder - was considered and dropped, because "which tabs survive this" then depends on where each file sits, which is a rule the user has to hold in their head to predict what a menu item will do.

- **Exactly one folder is open at a time**, or none. Files from anywhere else can still be opened alongside it and are ordinary tabs; what is singular is the folder, not where the files come from
- **Open Folder closes every tab first**, asking about any that are dirty, then opens the new root with nothing showing. It is a reset: the previous project leaves nothing behind
- **Close Folder closes every tab too** and returns to the no-folder state, where the working directory follows the active file again as Phase 1 chose. Without it there is no way back to that behaviour once any folder has been opened
- **The working directory is the folder root and stays there**, however deep the file being edited sits inside it, and whether or not the active tab is inside the folder at all. A hierarchy is one project, and a project has one place its relative paths resolve against. This is the whole reason one folder had to be singular
- Cancelling the save prompt for any dirty tab cancels the whole command, folder and all, exactly as it cancels a quit

**Decided.** Six questions that changed the design rather than the code, answered before any of it was written.

- **The kernel's working directory follows the folder when there is one, and the file when there is not.** No folder open: the active file's directory, exactly as Phase 1 chose, so `export_step(part, "bracket.step")` still lands beside `bracket.py` - and $HOME until the buffer has been saved anywhere, which is already what an unsaved buffer does today. Folder open: the project root, and it stays there rather than moving as tabs are switched. Both halves are what VS Code does - a workspace root when there is a workspace, the file's own directory when there is not - so the two readings of "like VS Code" agree, and the Phase 1 promise is kept in precisely the case it was made for, a single script opened on its own
- **The sidebar shows every file**, not Python only. A build123d project is STEP exports, STL, images and a README as much as it is `.py`, and a tree that hides them is a tree that has to be explained
- **Closing the last tab leaves the editor with no tab at all** - no phantom empty buffer to save, close or wonder about. The editor pane shows nothing until a file is opened or created
- **Restart restores the previous session's open tabs**, not just the folder, along with which one was active and a caret for each
- **Tab overflow scrolls the strip.** A dropdown is a second place to look for a file that is already on screen somewhere
- **No preview tabs.** VS Code's single-click italic tab that the next file replaces is an extra concept - a second kind of tab, an italic state, and a promotion rule - for little gain at the number of files this application is opened with. Every file that is opened gets a tab, and it stays until it is closed

### 3. Developer Experience

- Add Python code completion
  - There is none today, and there never was: monaco-editor ships language services for TypeScript, JSON, CSS and HTML only, and the editor deliberately registers just the Python grammar - tokenisation and colouring - to avoid pulling in some nine megabytes of services it cannot use. What is left is Monaco's word-based suggestion, which offers words already present in the buffer, so "time.sl" was never going to complete
  - Two sources, merged in the sidecar, because neither is enough alone. The kernel speaks Jupyter's complete*request, which is what gives IPython its Tab completion, and it completes against the live namespace: it knows the methods of the "part" the user built two cells ago, and a variable made in the console, neither of which any reading of the file can. What it cannot do is know anything before the code has been \_run* - and an editor is where people write a whole file first. A language server reads the buffer and infers without executing, which is exactly the other half. This bullet said "the kernel is the better source than a language server" until it was tried; see the write-up below for what changed it
- Debugging Python in Monaco should work
  - having the usual step buttons
  - Using the variable explorer (if possible)
  - Allows to hook into "breakpoint reached" or "Step finished" to including visual debugging, i.e. execute show_all(locals())

  **Two worlds: the debugged file runs in its own process, and the kernel is not touched by any of it.** That is the decision the whole design follows from, and it was taken deliberately over the alternative. ipykernel can be debugged in place - the Jupyter protocol wraps DAP in a `debug_request` on the control channel - and it was probed first: the handshake works, `dumpCell` maps a cell to a temp file, the filename an executed cell reports is exactly the one `dumpCell` returns, and an explicit `breakpoint()` call genuinely stops the kernel. What could not be made to work was the thing that matters: a breakpoint set through `setBreakpoints` reports itself verified and execution runs straight past it, on ipykernel 7.3.0, with the DAP ordering rule about waiting for the `initialized` event observed.

  It would have been the wrong shape even if it had worked. Debugging in the kernel means the debugged file's names land in the namespace the console shares, the console is unusable while execution is paused, and what is left behind afterwards depends on how far the session got. Two worlds costs one thing and it is worth saying plainly: **when the session ends the process dies and its objects go with it**, so a shape built while debugging cannot be poked at in the console afterwards. In exchange the kernel is exactly as it was before the session started, and the console works throughout.

  **The debuggee dials out to us.** `python -Xfrozen_modules=off -m debugpy --connect 127.0.0.1:<port> --wait-for-client <file>`, spawned by the sidecar in the application's own environment. `--connect` rather than `--listen` because this application configures no ports: the sidecar binds port 0 and debugpy connects to it, which is the same arrangement the model socket uses and for the same reason. The frozen-modules flag is there because debugpy warns that they "may make the debugger miss breakpoints" - it worked without it, but that is not a warning to leave standing. The process gets the kernel's environment, so `show()` from the file being debugged reaches the same viewer, which is what makes the visual-debugging hook work at all.

  Measured, against the pinned environment: the debuggee connects in 0.71 s, a breakpoint on the real file at its real line number binds and stops, the stack comes back naming `bracket.py:5`, locals arrive typed, and an `evaluate` in the paused frame answers in 13 ms - `b.volume` giving 27.0 off a Box built two frames up.

  **Because the file is on disk, there is no line mapping anywhere.** A breakpoint goes on the line the user put it on. That removes the one failure in this feature that would have been silent: a mapping that is out by one binds successfully and stops on the wrong line.

  **The sidecar is a relay, not a debug client.** It owns only what a webview physically cannot: spawning the process with the right environment, holding the socket debugpy dials into, piping the process's stdout and stderr - measured, a `print()` in the script does _not_ arrive as a DAP `output` event and needs the pipe - and killing it when the session ends or the application quits. Everything else, `seq` numbering and breakpoints and frames and variables, lives in the frontend, because that is where the UI needs it and a second copy in the sidecar would be a second thing to keep in step. Three of what would otherwise be features stop being features: the debug console is the frontend sending `evaluate`, the on-stop hook is the frontend seeing `stopped` and sending `evaluate`, and the explorer's frame view is the frontend sending `variables`. `ipc.request()` already correlates a reply to a request by id, which is what DAP's `seq` needs.

  **Decided, so the UI costs no layout.** Debugging starts with Shift-F5 and saves the buffer first, as VS Code does; F5 stays Run File. The step controls are right-aligned _in the tab strip_ and appear only while a session is running - no second toolbar, and the strip simply scrolls in less width. The debug console is a second tab on the console pane rather than a pane of its own, and it is a plain input line evaluating in the selected frame - never the kernel. Breakpoints are not persisted across runs, which removes storage, migration and stale-breakpoint reconciliation.

  Four commits: the relay and the process lifecycle; breakpoints and starting a session; the paused UI - current line, step controls, call stack, the explorer's frame view; then the debug console and the on-stop hook.

  Done. What the plan did not know, and what testing it changed.

  **The relay was the right shape and the measurements held.** Everything probed before a line was written - a breakpoint binding on the real file at its real line, `evaluate` in a paused frame at 13 ms, `show()` from that frame reaching the viewer in 0.02 s - behaved the same through the finished path. What the sidecar contributes is still only what a webview cannot do, and three would-be features stayed one frontend call each.

  **The panes swap rather than sharing.** The plan had the debug console as a second tab beside the Jupyter one; his objection settled it, and the objection is the better design: with both on screen, the variable explorer describes the kernel while the editor describes the debuggee, and somebody has to remember which pane means what. Swapping gives one rule - while a session runs, every pane in the window describes the debugged process, and otherwise every pane describes the kernel. The viewer is the deliberate exception, because a picture is not state.

  **`justMyCode` is not a detail.** debugpy defaults it to true, and with it on a step into `extrude(Ellipse(10, 6), 2)` stays on the line it started on, silently, as though the call had no inside. Measured: off, the same step lands in `Ellipse.__init__` in build123d's own source. It is a setting, defaulting to on, because on this application the library is often the interesting part but meeting that on your first step is disorienting.

  **The on-stop hook drew nothing and hung the window.** `show_all(locals())` handed `_convert` an ordinary list of floats, which produced a model with a header and no geometry, and three-cad-viewer does not come back from one - the app needed a force-quit. Three fixes, and the first is the lesson: the filter now uses `ocp_tessellate.ocp_utils`' own `is_build123d`, `is_vector`, `is_topods_shape` and the rest, which is what ocp_vscode's `show_all` uses, rather than the hand-rolled "not a scalar, not a module, not callable" that let the list through. Whoever wrote the tessellator knows what it can take. Beyond that, nothing sends a model with no geometry, and the viewer refuses one - a hang is not an acceptable answer to a bad frame from anywhere.

  **Stepping is line by line and there is no switch for it.** DAP's `next` takes a `granularity` of `statement`, `line` or `instruction`, and debugpy ignores it: `base -= Cylinder(a, b, c)` written over five lines stops six times - the call line, each argument line, then the call line again as it executes - identically for all three values. So the hook is gated on the `stopped` reason instead, drawing at breakpoints only by default, which is one tessellation per place somebody deliberately stopped.

  Two smaller things worth not rediscovering. The Neutralino `shortcut` field on macOS _binds_ Command plus one character rather than displaying a string, so `Shift-Enter`, `F5` and `Shift-F5` cannot be expressed through it at all and a value chosen to look right would bind a chord nobody asked for - the chords are written into the label there instead. And `* { box-sizing: border-box }` was quietly re-laying out three-cad-viewer, whose tree rows are `height: 16px; padding: 2px 0`: 20px under content-box and 16px under border-box, which took four pixels off every row and squeezed the icons. Found by screenshotting the library's own dev page beside ours.

- The variable explorer needs to get multilevel for iterables (`a = dict(a=12, b="wert", c=[1,2,3,4,5,6], d=dict(x=dict(aa=1, bb="sdfg"), y=2))`)
- the variable explorer needs to support paging to avoid showing hundreds of objects for arrays
- the columns of the variable explorer need to be resizable. currently type uses way too much space
- Show the repr in an expanded variable explorer row. Removing bounding box, volume and area is done - they cost 19 s, 2.8 s and 2.2 s on a real assembly and hung the pane
- Update to uv 0.12.1
- Add this as default coed for new files:

  ```
    # Default code for new files. It can be adapted in settings
    #
    # Note: lines starting with "# %%" are cell boundaries for "Run cell"
    #
    # Shift+Enter runs the cell at the cursor and moves on, Ctrl/Cmd+Enter runs
    # it and stays, Ctrl/Cmd+Shift+Enter runs the selection or the current line,
    # and F5 runs the whole file. Output appears in the console below as In [n]:,
    # and the kernel is shared with it - so you can poke at "b" down there
    # straight after running this.

    from build123d import *
    from build123d_studio import show

    # %%

    b = Box(1, 2, 3)

    show(b)
    # %%
  ```

Done: the uv pin, the New File template, the language support - completion, signatures, diagnostics and hover - the variable explorer, and debugging. Two of its settings ship without a dialog to reach them, the New File template and `justMyCode`, and group 5's tabs are where they land.

**There was no completion of any kind before this, and not for the reason above.** `registerCompletionItemProvider` is part of `editor.api.js`; the widget that displays what a provider returns is a separate contribution and was never imported, so a provider would have been registered and never asked - not even the word-based suggestions the editor worker has always computed could appear. Three more contributions have been imported since for the same reason, one per feature: the suggestion widget, the parameter hints popup and the hover tooltip. Assume it again for anything added later - go-to-definition and rename each need their own. Together they cost 104 kB gzipped and Monaco's 141 kB codicon font.

**The kernel alone was not enough, and that reversed the decision this group was planned on.** On a cold kernel a freshly typed file beginning `from build123d import *` offered nothing for `b = Bo`, because nothing had bound `Box` anywhere. In a notebook that is the accepted bargain; in an editor it is most of the time. jedi was tried first, since IPython already depends on it and it needed nothing new to ship, and it fails on build123d's central idiom: for `with BuildPart() as bd:` it infers `bd` as `Builder` rather than `BuildPart`, so `bd.part` - the property the whole builder pattern exists to produce - is not offered at all. build123d annotates `__enter__ -> Self` correctly; jedi binds `Self` to the class that _defines_ the method rather than the one it was reached through. basedpyright resolves it. That is the argument in one line: build123d is a large API leaning on overloads, `Self` and typed builder context managers, and the difference between a parser that mostly works and a type checker that follows the annotations shows up on it immediately.

**basedpyright ships as a pinned dependency rather than a downloaded runtime**, which is the only reason a Node program is admissible here at all. It is Pyright with Node bundled as a Python wheel, so it locks in `uv.lock` like everything else and has wheels for all seven platform targets - macOS arm64 and x86_64, Linux glibc and musl on both arches, Windows amd64 and arm64. 271 MB, in the per-user environment that already holds the interpreters and uv's cache, not in the 4 MB bundle. The PyPI `pyright` package was rejected for the opposite property: it fetches Node on first use, which is exactly the floating, machine-dependent version that `pins.json` exists to prevent.

**The kernel half stays and is worth its keep.** It is the only source that knows a variable built in the console or an object whose type nothing annotates. It is skipped outright while the kernel is busy rather than asked with a short timeout: the kernel serves shell requests serially, so during a cell the live answer is not late, it is unavailable, and waiting to discover that would delay the static half, which is sitting ready and needs no kernel at all. That also means completion keeps working while a long tessellation runs - which the kernel path cannot do, and which group 6's subshells would fix for it.

**IPython's own completer was returning nothing for the objects this application is about.** It is jedi-backed by default, and with a `Box` in the namespace `part.` gives 0 matches through jedi and 126 through `dir()`, including the `center` and `volume` someone would actually reach for. Builders complete either way; shapes did not. The warm-up now sets `Completer.use_jedi = False`, and the console shares the setting.

**Diagnostics were mostly a question of what not to report.** On an ordinary build123d file - a builder block, two shapes and two deliberate mistakes - the defaults produce nine problems, seven of them wrong about idioms this application ships in its own New File template. Two real ones among seven false is how somebody learns to ignore a gutter. `extraPaths` removes five on its own and is not a preference: `build123d_studio` is the kernel-side package the application puts on `PYTHONPATH` when it launches the kernel, so nothing outside that process can resolve it, and the template's second line was an unresolved import. The three overrides are each correct build123d: the wildcard import, a `Box` called inside a builder for its effect, and a bare expression on its own line. What is left is exactly the two mistakes.

**Configuring it failed silently, which is the part worth remembering.** Four different settings produced four identical sets of diagnostics, because the reply to `workspace/configuration` was one flat object and the server asks for one section at a time - `python`, then `basedpyright.analysis`, then `basedpyright`. An answer of the wrong shape is accepted without complaint and changes nothing.

**One thing is not reported and is not a fault.** `bd.<typo>` is not flagged, because `Builder` defines `__getattr__` and a class with one may legitimately answer to any attribute; `Box` has none, so `c.part` is flagged. The irony is that `Builder.__getattr__` exists only to raise a friendlier `AttributeError`, and that message is what suppresses the static one. Guarding it with `if not TYPE_CHECKING:` upstream restores the check and keeps the runtime message - one line, in build123d, and measured rather than assumed. No workaround was added here: the only ones available would guess at which classes to distrust, and a checker that invents errors is worse than one that misses some.

**And the kernel indicator stopped flickering.** Every shell request publishes busy and idle, not only the ones that execute something, and the console asks several as a matter of course - an `is_complete_request` per line at its prompt, a `complete_request` per Tab, `history_request` at startup. One session's log had 41 pairs against 3 Runs, every one of them one to four milliseconds. The indicator answers "is the kernel running my code", so status now forwards only for an `execute_request` - the gate the variable explorer's refresh has always used - and the log line names the request it was answering, because "Kernel busy" alone could not be accounted for afterwards.

### 4. A second instance must not corrupt the first

Multi-instance is the decided direction, and the feature half of it - the command line tool, `--list`, opening a file or folder in a new window - is in V2. This group is only the half that is a defect today: **a second instance already starts happily and quietly corrupts what the first one owns.** It is reachable without anyone asking for multi-instance at all - double-clicking the application twice, or opening a `.py` from the file manager while it is already running.

It is first because it is the smallest remaining piece and the only one that is a defect rather than a missing feature. Nothing in it needs designing or measuring; both are done below.

**Nothing about the corruption is fundamental.** Every port is already OS-assigned, so the sidecar socket, the model socket and the kernel's ZMQ ports never contend. What collides is four places written when there was only ever going to be one:

- `envRoot/kernel.json` is a single hardcoded name, so the second kernel overwrites the first and either restart rewrites it under the other. Reproduced on macOS by starting two instances in the same millisecond, and the failure is worse than "the file is wrong": the kernel process is launched with `-f {connection_file}` and reads its ports _from that file_, so instance A writes ports P, instance B overwrites with ports Q, B's kernel binds Q, and A's kernel then reads Q and dies on a zmq bind because B already holds them. A's client then waits sixty seconds for a kernel that never existed and the sidecar exits. A per-instance file removes the second step and the whole chain with it
- `settings.json` is rewritten whole from an in-memory copy, so layout, theme and package sources are last-writer-wins
- the log is read and rewritten at startup, so two instances truncate each other
- both run stage-files then `uv lock` then `uv sync` against one virtual environment; uv locks the sync itself, but not that whole sequence

**The split is smaller than it sounds.** One environment stays shared, because it is the expensive part and every instance wants the same one - measured on a working install: 593 MB of uv cache, 74 MB of interpreters, 72 MB of bytecode cache, 38 MB of uv itself, and the lock file that `uv sync --frozen` reconciles against on every start. What is genuinely per-instance is the connection file, and it is **295 bytes**: five ZMQ ports and an HMAC key, all of them already unique per instance because every port is OS-assigned. Nothing needs duplicating; one filename needs to stop being shared.

The bytecode cache stays shared deliberately. It is keyed by source path, and two instances importing the same module write the same file - safe, because CPython writes a temporary and renames. Per-instance would triple it and lose the benefit.

One shared path is genuinely unsafe rather than merely shared: `runtime/uv-download`, a scratch directory that is removed and recreated when uv is fetched. Two instances bootstrapping at once would delete each other's download mid-flight. It only runs when uv is missing or the wrong version - first start, or straight after an app upgrade, which is exactly when someone is most likely to double-click twice. That is the concrete reason the environment bootstrap needs a lock.

**Per-instance directory**, which is what makes that first collision disappear and answers the product question underneath it. Phase 1 promises the connection file lives at a discoverable path so an external `jupyter console --existing` can attach to the same namespace, and with several instances "the same namespace" stops being well defined. Choosing a primary instance would be a guess at which one the user meant. So the discoverable path becomes a directory rather than a file: each instance owns `runtime/instances/<uuid>/`, puts its connection file there, and the About dialog names its own.

A random id, not the port, and identity is kept separate from liveness. `NL_PORT` was the first suggestion, on the reasoning the reverted single-instance guard used - the OS frees a port when a process dies, unlike a pid file, which goes stale exactly when it matters. But ports are reused, and that breaks both jobs at once: a new instance can be handed a dead one's number and inherit its directory, so an external `jupyter console --existing` reads a connection file naming ports that now belong to something else; and the sweep asks "does that port still serve this application", gets "yes" because the _new_ instance holds it, and never cleans the old directory up.

So the directory is named by a uuid, which is never reused, and liveness is a `lock` file inside it that the instance holds open under an exclusive lock for as long as it runs. That keeps what the port was chosen for and drops what it was bad at: the operating system releases the lock when the process dies - verified including under SIGKILL - and unlike a port nobody else can acquire it and be mistaken for the owner. The sweep is then simply "try to take each lock; if it is granted, the owner is gone" - so a crashed instance tidies up after itself, and `studio --list` has something true to print.

The sidecar is the natural owner of all of it: it already writes the connection file, it lives exactly as long as the instance, and it already reports the path to the frontend in its `ready` frame.

Measured on all three platforms before committing to it, because "reasonable on paper, different on Windows" has already cost this project days once. macOS and Ubuntu 26.04 use `fcntl.flock`, Windows uses `msvcrt.locking`, and all three agree: an owner holding the lock reads as alive, the same owner after being killed reads as stale, and the directory is then removable.

Two of the checks exist only because Windows differs. Its locks cover a byte range from the current position, so a zero-length lock file is an edge case that would fail there and nowhere else - the file needs a byte written into it before it can be locked. And a file held open by a live process cannot be deleted at all, which is a property worth having rather than working around: a sweep with a bug in it fails loudly on Windows instead of quietly removing a running instance's connection file. Release on process death holds everywhere, including abnormal termination.

The remaining three are ordinary work: read-merge-write settings under a lock, one lock around the environment bootstrap, and an append-only log. **The log is already done** - it was pulled forward into Phase 3 on the grounds that the primary diagnostic artefact must not corrupt itself precisely when two instances are doing something interesting, which is the situation this group is about. Measured before the fix: of fifteen launches on one machine, four looked broken in the log and only one actually was; the rest were lines another instance had truncated. So two remain.

Not needed, but worth recording so nobody rediscovers it: a single-instance guard was written and reverted rather than deleted, in case this decision ever goes the other way. Refusing the second instance is the other way to close this defect, and it is rejected for the same reason it was reverted: it makes a double-click do nothing, which is a worse answer than the one the directory gives.

**What this group deliberately does not build.** The sweep leaves the directory tidy and the lock makes liveness answerable, but nothing yet asks the question out loud - `studio --list` is what reads this, and it is V2 along with the rest of the command line tool. The About dialog naming this instance's own connection file is in scope here, because that is the Phase 1 promise being kept rather than a new feature.

Done. What the plan had wrong, and what two platforms said about it.

**"The sidecar is the natural owner of all of it" was true of one collision and false of the other two.** The connection file is the sidecar's, exactly as designed. But `ensureEnvironment()` runs at `src/main.js:297` and `initStore()` at `:289`, while `ipc.startSidecar()` is at `:521` - and on first start there is no interpreter at all when the bootstrap runs, because uv is what creates it. Several settings writes land before the sidecar exists too; `restoreWorkspace` is one. So the uuid-and-lock scheme, which is Python, cannot reach either of them, and Neutralino 6.9.0 offers no lock primitive of any kind - the filesystem API has `createDirectory`, `remove`, `writeFile`, `openFile`, `move`, `getStats`, `access`, `chmod`, and nothing that takes a lock or opens exclusively.

**So both were closed by removing the sharing rather than by serialising it**, which is the same answer the connection file gets: the fix for a shared name is a name that is not shared. `runtime/uv-download` became `uv-download-<uuid>`, removed in a `finally` on every exit path - which also stops the leak the old code had, where a failed extraction left the directory for the next run to clear. Two instances now download side by side, each verified against the pinned checksum independently, and the loser of the race to install the binary checks the version at the destination and uses it, because what it wanted is what the winner just put there. A lock was considered and rejected on cost: a first-run bootstrap legitimately takes minutes downloading 500 MB, so any break-the-stale-lock timeout is either short enough to kill a live download or long enough to block the next start after a crash.

**The settings bug was not a race at all.** `store.js` wrote its whole in-memory copy, and that copy is a snapshot taken when the instance started, so a second instance reverted the first one's settings on *every* write it made, whatever the timing. One window changing the theme and the other dragging a splitter is enough to lose the theme. Read-merge-write fixes it, and the merge is a pure function in `src/merge.js` so it can be tested without Neutralino - the same split as keys/keybindings. The file on disk wins for every key except the one being written; the read is deliberately not merged back into memory, because adopting the other window's theme mid-session would change this window because that one was touched.

**Every fix was proved against the unfixed code** by copying the sources to a scratch tree and un-applying exactly one guard at a time: the connection file back to one shared name (2 tests fail, 12 pass), the lock file left zero-length (1 fails, 15 pass), settings writing the whole in-memory copy (2 fail, 5 pass). One-to-one each time. The zero-length case is the one worth keeping in mind - it fails **on macOS**, for a defect that could only ever manifest on Windows.

**The sweep is the mechanism and the tidy exit is a courtesy - which is the opposite of how this was written.** `release` drops the lock and removes the directory when an instance quits, and the sweep at the next startup was described as the backstop for crashes. Testing says otherwise: on both platforms the directory *sometimes* survives an ordinary quit, and the next start collects it. So the sweep is not the backstop, it is the guarantee, and the two mechanisms should be read the other way round.

The reason is worth stating precisely, because a first plausible answer was wrong. On Windows a live process's open file cannot be deleted, and the kernel that has been *asked* to stop has not necessarily stopped - which explains a failure there. It does not explain macOS, where POSIX unlinks open files quite happily, so a surviving directory there means `release` did not run at all rather than that it failed. The likely cause is that quitting races the sidecar's own termination: `stopSidecar` sends the shutdown frame, closes stdin and lets `app.exit()` follow immediately, while `stop` still has a completer, a debugger, a console, a kernel and a model socket to close before it reaches `release`. That is a hypothesis, not a measurement - the frontend is what writes the log and it is gone before anything the sidecar prints at quit could be captured, so this particular path cannot report on itself.

None of which needs fixing, and that is a decision rather than an omission. The directory is 295 bytes and a lock file, the sweep collects it deterministically at the next start, and the alternative - making quit wait for the kernel, or reordering a shutdown path to win a race - is exactly the kind of change this project has already been burned by, when a gate on the restart path cost 90 s to refuse one Run. What *was* worth fixing is that `ignore_errors=True` made the Windows failure silent; `release` now reports, as `sweep` already did, even though on the quit path there may be nobody left to hear it. `sweep`'s own reporting runs at startup with the frontend fully alive, and that is the one that guards against a buggy sweep quietly removing a live instance's connection file on Windows.

**Two smaller things.** The env root arrives from the frontend written with forward slashes even on Windows, so `os.path.join` produced `C:/Users/.../runtime\instances\<uuid>\kernel.json` - accepted by Windows, and wrong in the one field that exists to be copied into a `jupyter console --existing` command. And the pre-instance `envRoot/kernel.json` is deleted when found, because every environment root built before this has one and nothing writes it any more: left alone it is the path Phase 1 told people to attach to, now naming a kernel that stopped days ago.

#### The `studio` command

Multi-instance is not an alternative to multi-file - the two are orthogonal. Multi-file is one project with many files; multi-instance is several projects open at once. A build123d project is normally a hierarchy of files under one root, and the workflow that matters is a large assembly open beside the self-contained components it is built from. Tabs do not serve that, and neither does one window. Group 4 made a second instance safe, and that turned out to be the whole of it - every port has been OS-assigned since Phase 1, so nothing else was in the way.

What was left was a way in from outside the application. It was written down as a V2 item and turned out to be small enough to do here, once `--list` and desktop integration were dropped from it - see the end of this section for why each went.

**One rule, and the command line collapses into it: open this path, defaulting to the current directory.** `studio` and `studio .` are the same thing. `studio /path/to/folder` opens that folder. `studio main.py` opens the file *and its containing folder as the project*, which is what makes the kernel's working directory the one the command was typed in - group 2 already decided the working directory is the project root, so opening the folder is how a file argument gets that behaviour rather than a third rule about working directories being invented for it. Every form starts a new instance, so there are never tabs to discard and the context-reset semantics of Open Folder cost nothing here.

**No argument means a double-click, which restores the previous session.** That falls out rather than being detected: the script always passes an absolute path, so the frontend's whole rule is "a path in `NL_ARGS` means open it, no path means restore". An argument replaces the restore instead of joining it, because restoring five files and then opening a folder - which closes them all again - would be silly.

**The script resolves the path before launching, and that is not a nicety.** `studio .` means something only relative to the shell's working directory, and the application will not have it: on macOS `open` launches through LaunchServices, which starts the process from `/`. An unresolved `.` opens the wrong folder silently.

**It is copied onto the user's PATH, not installed.** Installing from the UI would mean writing outside our own directory and, on the directories people actually have on PATH, asking for a password - for a convenience. So the launcher ships beside the binary and the release notes say to copy it.

That is also why it cannot find the application from its own location: once copied it has no relationship to the bundle it came from. Searching the usual install locations works on macOS and nowhere else - a Windows package is unzipped wherever the user felt like it, and an AppImage lives anywhere at all. **So the application records its own location on every start and the script reads that**, which means it must be run once first. Recording on every start rather than once is what makes moving the application fix itself; two installations disagree, and the most recently started wins, which is the only answer available without asking the user which one they meant. On Linux it is AppRun that records the path, because `$APPIMAGE` is the only durable name the application has there - the staged resource directory is symlinks into a mount that is gone once the process exits.

**Not built, and each for a reason.** `studio --list` would name the live instances and their connection files, and the data is all there - group 4's per-instance directory and lock file are exactly what it would read. It is out because liveness means taking each lock, which is awkward from a shell script, and the About dialog already names this instance's connection file. Desktop integration, so double-clicking a `.py` opens it here, is out until somebody asks: it is per-platform registration work, and the command above already covers opening a project deliberately.

**One gap that stays.** On Windows and Linux, running the executable again gives a second instance. On macOS it does not - LaunchServices activates the existing window - so `studio` is the only route to a second instance there. Which raises its value on macOS rather than lowering it, but it does mean the platforms differ in how a second window is reached.

### 5. Config dialog: extra packages, and editing the shortcuts

- Rename from Packages to Settings
- Config should get a field where users can add extra packages in pyproject.toml syntax. They will be added to pyproject.toml (a "custom" section: `# --- custom: own packages ---`). Allow pypi, github sources and local paths if possible
- remove bd_warehouse from standard installations, it gets a custom package
- Editing the keyboard shortcuts, on top of the defaults map group 1 lands. This is the expensive half of "shortcuts are configurable" and is deliberately not a quick win: capturing a chord, detecting conflicts both between our own actions and against Monaco's built-in bindings, reset-to-default, and displaying each binding the way its platform writes it (⌘⇧↵ against Ctrl+Shift+Enter). By this point the storage, the parser and the re-registration all exist, so it is a form over data rather than new machinery.
- make the settings dialog tabbed (Packages|Updates|New file|Debugging)

Its own group rather than a usability quick win, because it is the first place free user text reaches a command line. Everything interpolated into a command already goes through quote(), which on Windows now refuses a value containing a double quote outright rather than escaping it - that refusal exists for this field, before the field does. It wants the same care as a security item: what happens to a malformed entry, what a failed sync leaves behind, and whether the custom section survives an "upgrade packages".

### 6. Inspecting while the kernel is busy

The smallest remaining piece, and the one whose answer is already measured. It buys two things rather than one, which is what moved it ahead of the OCP work: the variable explorer stops lying while a cell runs, and completion's kernel half stops going dark - group 3 skips it outright while the kernel is busy, so a long tessellation currently costs the live namespace half of every suggestion. Both are the same defect seen from two panes.

Expanding a variable while a cell is running shows "Loading..." until the cell finishes. The kernel serves shell requests serially and the variable explorer inspects with a silent `execute_request`, so the inspection waits in the _kernel's_ queue. Measured on a ten second loop: 13.32 s before Phase 3c and 13.43 s after, so it is not the sidecar's doing and 3c neither caused nor could fix it. Past EVALUATE_TIMEOUT it is worse than slow - the row reports "could not be read in time", which is untrue: the value was readable and the kernel was busy.

ipykernel 7 subshells (JEP 91) are the answer, and they work: a `create_subshell_request` on the control channel returns an id, a request carrying that id in its header is served by a separate thread with the same namespace, and a probe against the pinned ipykernel 7.3.0 answered in **0.01 s** while the main shell was six seconds from finishing. Route inspections there and leave Run, the chdir and the warm-up on the main shell - the chdir in particular must stay ordered with respect to Runs.

Two things already known about the shape of it. Building the message by hand (`session.msg` plus `shell_channel.send`) is needed because jupyter_client's `execute()` cannot set a subshell id, and that incidentally closes the internal-request window for good rather than locking it, since the msg_id is known before the send. And the inspector already snapshots with `list(namespace.items())`, so inspecting a namespace that running code is mutating does not iterate a dict as it changes. It must degrade to the main shell when the kernel has no subshell support, or the application stops working against anything but ipykernel 7.

### 7. OCP VS Code integration

Last, and deliberately so. It is the only group whose scope leaves this repository - ocp_vscode has to be restructured, in its own project, to serve jupyter-cadquery and build123d Studio both - so it wants a base that has stopped moving under it.

- show_clear, show_object, push_object, show_objects, show_all, set_defaults, get_defaults, set_default, workspace_cofig, combined_config, status, ... need to work (Note in a separate project ocp_vscode needs to be restructured to better work with jupyter-cadquery and build123d studio)
- every show should first get the tree status (see "status" in ocp_vscode) and apply it after show to keep the user intent on what to show. At the end, this is what viewer.html in ocp-vscode does. We need to understand what it does and what and how to replicate it.

## Phase 5 "Feature test suite"

Write a comprehensive feature test suite: the panes, the editor, the viewer and the workflows, as distinct from Phase 3's ipc, communication and threading.

Its own phase, and after the whole of Phase 4, which is the rhythm this project already has: Phase 1 built, Phase 2 reviewed what it had built, Phase 3 tested the layer everything else is diagnosed through. A feature suite wants the features to have stopped moving, and the last thing Phase 4 does is change what `show` means.

The alternative considered and rejected: writing the half that does not touch the viewer - editor, panes, workflows - before group 7, as a regression net for the restructure. It reads well and does not survive the detail. Group 7 changes the viewer's semantics _deliberately_ - every `show` reading the tree status first and reapplying it afterwards - so tests written against today's behaviour would be updated by design rather than catching anything, and a suite that has to be rewritten to go green teaches everyone to rewrite it.

What this phase has to reach that nothing does today is the part Phase 3 explicitly left out. Phase 3's harnesses drive the sidecar over its WebSocket, which is the right layer for ipc and threading and the wrong one for "the dirty dot appeared on the tab". Several of Phase 4's defects were found only because the application was built and used by hand - a splitter with no width, a chevron with no glyph, a dirty mark a tick early - and deciding which of those a suite can honestly reach, and which stay a human test script, is the first question this phase answers rather than assumes.

## BUGS:

## FEATURES:

- Clicking on a file in the file tree should determine whether it is text or not. If not dont open it (show a dialog)
