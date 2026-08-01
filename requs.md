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

## Phase 4 "Feature release"

### 1. Usability (quick wins)

- Add an OS menu to get Cmd-C/Cmd-V/Cmd-X. Would also deliver Cmd-Q, ... (a prerequisite for code completion in group 5: without it macOS never binds the standard shortcuts, so Ctrl-Space is swallowed by the system's input-source shortcut)
- Logically, idle/busy indicator belongs to kernel button group. move it before the interrupt button
- Add all log paths to the info box
- Fix the Application icon on MacOS
- Config should get a multiline field where I can add code that should be used during "New File"
- Three distinct run shortcuts, currently two:
  - run block and move the cursor on
  - run block and leave the cursor where it is
  - run line or selection

  Most of this exists already: runCell and runSelectionOrLine both take an "advance" flag, but nothing ever passes false, so "run and keep the cursor" is implemented and unreachable. What is missing is the keymap and the bindings. Note that "run line" is inherently one physical line, so sending a block header alone - "for i in range(5):" - is incomplete input and the kernel says so; that is the shortcut behaving as named, and the reason the third one has to be clearly distinguished from the first two. Worth deciding whether run line should instead extend to the whole statement under the cursor

### 2. Multi file support

- Open Folder should work as in VS Code with a left sidebar and with tabs for files. tab label is filename with full path on hover

Before the instance model, but not because it replaces it - see group 3, the two are orthogonal. It comes first because it is the smaller and safer piece: it is self-contained, every project needs it whether or not a second window is ever opened, and it touches none of the shared state the instance work has to make safe.

### 3. Instance Model (decided: multi-instance)

Multi-instance, deliberately, and it is not an alternative to multi-file above - the two are orthogonal. Multi-file is one project with many files; multi-instance is several projects open at once. A build123d project is normally a hierarchy of files under one root, and the workflow that matters is a large assembly open beside the self-contained components it is built from. Tabs do not serve that, and neither does one window.

It is also what an editor is expected to do: browsers and VS Code both do it, and today a second instance already starts happily - it just quietly corrupts what the first one owns.

**Nothing about that is fundamental.** Every port is already OS-assigned, so the sidecar socket, the model socket and the kernel's ZMQ ports never contend. What collides is four places written when there was only ever going to be one:

- `envRoot/kernel.json` is a single hardcoded name, so the second kernel overwrites the first and either restart rewrites it under the other. Reproduced on macOS by starting two instances in the same millisecond, and the failure is worse than "the file is wrong": the kernel process is launched with `-f {connection_file}` and reads its ports *from that file*, so instance A writes ports P, instance B overwrites with ports Q, B's kernel binds Q, and A's kernel then reads Q and dies on a zmq bind because B already holds them. A's client then waits sixty seconds for a kernel that never existed and the sidecar exits. A per-instance file removes the second step and the whole chain with it
- `settings.json` is rewritten whole from an in-memory copy, so layout, theme and package sources are last-writer-wins
- the log is read and rewritten at startup, so two instances truncate each other
- both run stage-files then `uv lock` then `uv sync` against one virtual environment; uv locks the sync itself, but not that whole sequence

**The split is smaller than it sounds.** One environment stays shared, because it is the expensive part and every instance wants the same one - measured on a working install: 593 MB of uv cache, 74 MB of interpreters, 72 MB of bytecode cache, 38 MB of uv itself, and the lock file that `uv sync --frozen` reconciles against on every start. What is genuinely per-instance is the connection file, and it is **295 bytes**: five ZMQ ports and an HMAC key, all of them already unique per instance because every port is OS-assigned. Nothing needs duplicating; one filename needs to stop being shared.

The bytecode cache stays shared deliberately. It is keyed by source path, and two instances importing the same module write the same file - safe, because CPython writes a temporary and renames. Per-instance would triple it and lose the benefit.

One shared path is genuinely unsafe rather than merely shared: `runtime/uv-download`, a scratch directory that is removed and recreated when uv is fetched. Two instances bootstrapping at once would delete each other's download mid-flight. It only runs when uv is missing or the wrong version - first start, or straight after an app upgrade, which is exactly when someone is most likely to double-click twice. That is the concrete reason the environment bootstrap needs a lock.

**Per-instance directory**, which is what makes that first collision disappear and answers the product question underneath it. Phase 1 promises the connection file lives at a discoverable path so an external `jupyter console --existing` can attach to the same namespace, and with several instances "the same namespace" stops being well defined. Choosing a primary instance would be a guess at which one the user meant. So the discoverable path becomes a directory rather than a file: each instance owns `runtime/instances/<uuid>/`, puts its connection file there, and the About dialog names its own.

A random id, not the port, and identity is kept separate from liveness. `NL_PORT` was the first suggestion, on the reasoning the reverted single-instance guard used - the OS frees a port when a process dies, unlike a pid file, which goes stale exactly when it matters. But ports are reused, and that breaks both jobs at once: a new instance can be handed a dead one's number and inherit its directory, so an external `jupyter console --existing` reads a connection file naming ports that now belong to something else; and the sweep asks "does that port still serve this application", gets "yes" because the *new* instance holds it, and never cleans the old directory up.

So the directory is named by a uuid, which is never reused, and liveness is a `lock` file inside it that the instance holds open under an exclusive lock for as long as it runs. That keeps what the port was chosen for and drops what it was bad at: the operating system releases the lock when the process dies - verified including under SIGKILL - and unlike a port nobody else can acquire it and be mistaken for the owner. The sweep is then simply "try to take each lock; if it is granted, the owner is gone" - so a crashed instance tidies up after itself, and `studio --list` has something true to print.

The sidecar is the natural owner of all of it: it already writes the connection file, it lives exactly as long as the instance, and it already reports the path to the frontend in its `ready` frame.

Measured on all three platforms before committing to it, because "reasonable on paper, different on Windows" has already cost this project days once. macOS and Ubuntu 26.04 use `fcntl.flock`, Windows uses `msvcrt.locking`, and all three agree: an owner holding the lock reads as alive, the same owner after being killed reads as stale, and the directory is then removable.

Two of the checks exist only because Windows differs. Its locks cover a byte range from the current position, so a zero-length lock file is an edge case that would fail there and nowhere else - the file needs a byte written into it before it can be locked. And a file held open by a live process cannot be deleted at all, which is a property worth having rather than working around: a sweep with a bug in it fails loudly on Windows instead of quietly removing a running instance's connection file. Release on process death holds everywhere, including abnormal termination.

The remaining three are ordinary work: read-merge-write settings under a lock, one lock around the environment bootstrap, and an append-only log. **The log fix belongs in Phase 3, not here** - it is small, and until it is done the primary diagnostic artefact corrupts itself precisely when two instances are doing something interesting. Measured: of fifteen launches on one machine, four looked broken in the log and only one actually was; the rest were lines another instance had truncated, which made the log actively misleading.

Not needed, but worth recording so nobody rediscovers it: a single-instance guard was written and reverted rather than deleted, in case this decision ever goes the other way.

**Command line tool.** `studio <file>` and `studio <folder>` open a new instance on that file or folder, installable from a menu entry. `studio --list` names the live instances and their connection files, which is where a user would ask the "which namespace" question. This is also the natural entry point for the desktop integration that makes double-clicking a `.py` file open it here.

### 4. Extra packages from the UI

- Config should get a field where users can add extra packages in pyproject.toml syntax. They will be added to pyproject.toml (a "custom" section: `# --- custom: own packages ---`)

Its own group rather than a usability quick win, because it is the first place free user text reaches a command line. Everything interpolated into a command already goes through quote(), which on Windows now refuses a value containing a double quote outright rather than escaping it - that refusal exists for this field, before the field does. It wants the same care as a security item: what happens to a malformed entry, what a failed sync leaves behind, and whether the custom section survives an "upgrade packages".

### 5. Developer Experience

- Add Python code completion
  - There is none today, and there never was: monaco-editor ships language services for TypeScript, JSON, CSS and HTML only, and the editor deliberately registers just the Python grammar - tokenisation and colouring - to avoid pulling in some nine megabytes of services it cannot use. What is left is Monaco's word-based suggestion, which offers words already present in the buffer, so "time.sl" was never going to complete
  - The kernel is the better source than a language server. It already speaks Jupyter's complete_request, which is what gives IPython its Tab completion, and it completes against the live namespace: it knows time.sleep, and it also knows the methods of the "part" the user built two cells ago, which no static analysis of the file can. A Monaco registerCompletionItemProvider routed through the sidecar to complete_request reuses transport that already exists
- Debugging Python in Monaco should work
  - having the usual step buttons
  - Using the variable explorer (if possible)
  - Allows to hook into "breakpoint reached" or "Step finished" to including visual debugging, i.e. execute show_all(locals())
- The variable explorer needs to get multilevel for iterables (`a = dict(a=12, b="wert", c=[1,2,3,4,5,6], d=dict(x=dict(aa=1, bb="sdfg"), y=2))`)
- Show the repr in an expanded variable explorer row. Removing bounding box, volume and area is done - they cost 19 s, 2.8 s and 2.2 s on a real assembly and hung the pane
- Update to uv 0.12.1

### 6. OCP VS Code integration

- show_clear, show_object, push_object, show_objects, show_all, set_defaults, get_defaults, set_default, workspace_cofig, combined_config, status, ... need to work (Note in a separate project ocp_vscode needs to be restructured to better work with jupyter-cadquery and build123d studio)

## Phase 5 "Add feature tests"

- Write comprehensive feature test suite: the panes, the editor, the viewer and the workflows, as distinct from Phase 3's ipc, communication and threading

 enhance phase 2 "fix all findings" in requs.md by a list of fixed topics (not the how, but the what and why)
