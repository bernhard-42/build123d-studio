# build123d Studio - Design

How the application is built, and why it is built that way. `requs.md` records what was decided, phase by phase, and is the authoritative log; this document describes what stands now, from the top down, for somebody reading it cold.

## 1. What it is

A desktop IDE for [build123d](https://build123d.readthedocs.io): write Python that constructs geometry, see it rendered, and inspect the objects afterwards. One window, one webview, and a small family of child processes behind it.

It brings its own Python. On first start the application downloads a pinned uv and a pinned CPython, builds an environment under the user's data directory, and installs build123d into it. There is nothing to `pip install`, and no system Python is read or written.

The window is four panes in two rows, all boundaries draggable:

```
+---------------------------+---------------------------+
|  Monaco editor            |  three-cad-viewer         |
|  (tabs, toolbar)          |  (the model)              |
+---------------------------+---------------------------+
|  Jupyter console          |  Variable explorer        |
|  / Backend / Run-Debug    |  (the kernel namespace)   |
+---------------------------+---------------------------+
```

A file tree appears to the left when a folder is open. Pane sizes are stored as fractions of the window rather than pixels, so a restored layout survives a resize or a different display.

## 2. Components

| Component | Where | Owns | The boundary it defends |
|---|---|---|---|
| **Frontend** | `src/`, in the webview | Every pixel, and the state the UI needs: buffers, tabs, breakpoints, DAP client, settings, the health picture. Also the environment bootstrap, because it has to run before any Python exists | Never trusts wire data. Every binary frame is bounds-checked; the variable explorer is built from text nodes, because repr output plus Neutralino's filesystem reach would make one missed escape into remote code execution |
| **Sidecar** | `sidecar/`, Python | Everything Python-side: the kernel and its client, the console pty, the model socket, the measurement process, the language server, the run and debug relays | One owning thread per socket, and a receive thread that never blocks. Loopback reachability is never authority - every channel is authenticated |
| **Kernel** | ipykernel, out of process; support package in `kernel/build123d_studio/` | The user's namespace, shared by editor runs, the console and the explorer. `show()` runs here | The namespace is sacrosanct. Warm-up, `chdir` and inspection use silent requests and `__import__` so nothing the application does appears in `In [n]`, the console, or the explorer |
| **ocp_viewer_core** | shared library, Python and JS, consumed as a dependency | The whole show pipeline, config semantics, camera policy, tree-state restore, the viewer page, the measurement backend | Host-neutrality: nothing in it can name a host. The ruling is that all four viewers built on it have the same features and defaults, and a divergence is a defect |

The studio's own kernel-side contribution is deliberately small: a comms class, a settings source, a buffer splitter, and a bindings module that re-exports one `Viewer`/`Config` pair.

One pattern runs through the frontend and is worth naming, because it is why any of it can be tested at all. Wherever a decision matters more than the plumbing around it, the decision is lifted into a module that imports nothing from Neutralino and takes its world as arguments - the shell quoting rules, the buffer bookkeeping, the atomic write, the changed-on-disk comparison, the recovery journal, the layout arithmetic, the health model, the keybinding parser. Each has a sibling that does the talking. That split is what lets `node --test` reach a full-disk save, a stale stat and a burst of typing, none of which can be arranged through a running window.

## 3. The process tree

Everything Python is a child of the application, and everything else is a child of the sidecar. The frontend spawns through Neutralino's `spawnProcess`, which on macOS and Linux runs the command under `/bin/sh -c` - the shell execs itself away for a simple command, so the program is a direct child and its own process-group leader - and on Windows wraps every command in `cmd.exe /c`. On Windows there is a second layer: every interpreter in the environment is a uv trampoline stub that relaunches the real one, so each Python process appears twice. Parent links identify a process there; command lines do not.

That doubling is not only a reading problem. Neutralino's kill on Windows walks **one level** of children and there are no process groups, so killing a tracked handle reaches `cmd.exe` and the thing it wraps, and no further - which is why the row below about uv's own children is marked as unmeasured rather than claimed.

```
build123d-studio                        the Neutralino binary; the webview is in-process
│
├── uv, curl, tar, python -c "import OCP"    bootstrap and maintenance, transient
│   └── uv's own children: git, build backends      (one level further down)
│
└── sidecar          .venv/bin/python sidecar/main.py
    │
    ├── kernel       python -m ipykernel_launcher -f <instance>/kernel.json
    │   └── whatever the user's own code spawns
    │
    ├── console      python -m build123d_studio_console --existing <kernel.json>, under a pty
    │
    ├── measurement  python sidecar/measure_process.py
    │
    ├── language server   basedpyright-langserver --stdio
    │   └── node        the actual server; the wheel's entry point is a wrapper
    │
    ├── run file     python _supervise.py python -u <file>            (only while running)
    │   └── python -u <file>
    │
    └── debug        python _supervise.py python -m debugpy --connect <port> <file>   (only while debugging)
```

### How each one is meant to end

The application never kills the sidecar. It sends a `shutdown` frame, closes the sidecar's stdin, and exits. The sidecar tears its own tree down - measured at one and a half to two and a half seconds - under an eight-second watchdog that names whichever step is stuck and then exits hard. So for a moment after every quit the Python tree is still alive, on purpose.

The reason for that shape is that **stdin cannot be missed**. A frame needs a working WebSocket and a frontend healthy enough to send it; a closed pipe is delivered by the operating system when the parent dies, however it dies - a clean quit, a crash, a kill, a logout. It is watched from the first line of the sidecar's `main()`, on a thread of its own, because reading it after startup meant a quit arriving during a launch was not heard until the launch finished - and every blocking wait in startup stacked up behind that.

Every child in the tree has a parent-death contract of its own, so that killing the sidecar outright still empties it:

| Process | Stopped by | If that never happens |
|---|---|---|
| sidecar | `shutdown` frame, or stdin EOF | stdin EOF is the fallback; it needs no cooperation from anyone |
| kernel | polite shutdown, escalating to a group kill | ipykernel polls for its parent - but that poller is a Python thread, so a native call holding the GIL starves it |
| console | signal, then the pty closes | the pty master dies with the sidecar, and the console gets EIO |
| measurement | killed outright, without taking the service lock | reads stdin, so it sees EOF |
| language server | EOF on stdin, then terminate, then kill - each bounded | stdio EOF, and it was told the sidecar's process id at startup |
| run file / debuggee | the supervisor's stdin is closed | the supervisor watches that pipe and kills its child on EOF |
| uv, curl, tar, warm-up | killed by the frontend before it exits | nothing. They are the one group with no contract of their own - and on Windows the kill reaches one level of children, so uv's own `git` may not be covered. Unmeasured; `tests/manual.md` M23 |

**The kernel goes first**, because that fallback is the weakest one in the table: a user computation inside a single long OCCT call holds the GIL for its whole duration, so the poller cannot run and the kernel cannot notice we have gone. Anything ahead of it that spent the deadline used to leave it running. Every other child is caught by a pipe or a pty, which need nothing of the interpreter.

Three of those rows are scars. The measurement backend is killed rather than asked because taking the service lock waits on the one thing that can block indefinitely - a request holding it while writing megabytes into a 64 kB pipe that the backend may not be reading. Closing stdin has the same shape one level down, since closing a buffered writer flushes it. That pairing is what left seven orphaned sidecars behind, and it is why the row says "killed" and "without the lock".

The language server has the same hazard and cannot take the same answer, because what needs to hear about it is a grandchild: the process spawned here is a wrapper and the node process doing the work is its child, so terminating what we spawned leaves node holding these pipes - and a stdout that never reaches EOF is a reader thread that never returns. EOF on stdin is what actually stops it, so it stays first; every close is simply given a deadline of its own, and the escalation breaks the pipe a blocked flush is waiting on.

The last row is newer and simpler: uv and the tools around it are started by the frontend and awaited, and the handle that could stop them used to be thrown away. Neutralino kills nothing of its own at exit, so closing the window during a first run left an install writing into the environment of an application that had gone. They are now tracked and killed on the way out - safe by construction, because every start runs `uv sync`, which finishes an interrupted one.

The run and debug processes are stopped by closing a pipe rather than by killing the supervisor, because killing the supervisor is the one action that would strand the script underneath it. The supervisor exists for exactly this: it holds a pipe that is never written to, watches it, and kills its child on EOF - which works even when every thread in the debuggee is suspended at a breakpoint, because the watcher is not in the debuggee.

Nothing sweeps for leaked processes at the next start. The instance sweep collects dead instances' directories, not their processes. Process-id-based sweeping was considered and rejected: a process id is reused, and killing the wrong one is worse than leaving the right one.

What the user's own code spawns is deliberately out of scope. The graceful path's group kill takes such children as a courtesy; a `setsid` child escapes it, and the abrupt path never offers it at all.

## 4. Transports

Every port in the system is assigned by the OS. A hardcoded port is the thing that collides, so there is not one anywhere - not in Neutralino's own server, the sidecar's WebSocket, the model socket, the kernel's five ZMQ ports, the debug listener, or ipykernel's debugpy port.

### Webview <-> sidecar: a WebSocket on loopback

The sidecar binds `127.0.0.1:0` and prints one JSON line on stdout announcing its port and a 32-byte token. Stdout carries that handshake and nothing else; all sidecar logging goes to stderr. The frontend connects with the token in the query string, and the token is redacted before any line is logged.

A listening socket is reachable by any local process, unlike a pipe, which is why the token exists. It is compared in constant time *during the HTTP handshake*, and a bad one gets a plain 403 before the upgrade - closing after the upgrade made a neighbouring viewer's probe read "present but broken".

Control messages are JSON text frames, about forty types, with request/reply exchanges carrying an id. Waits are always raced against sidecar exit and disconnection as well as a timeout, because awaiting only the success frame once hung startup forever.

The two hot paths are binary, so they carry no base64 and no JSON-escaped numbers:

```
kind (uint8) | 3 pad | header length (uint32 BE) | header JSON | pad | payload
```

The prefix is 8 bytes and the header is padded to a multiple of 8, so the payload always begins on an 8-byte boundary. That is the precondition for building typed-array views straight over the received buffer. Kind 1 is console bytes, kind 2 is the tessellated model. Both decoders bounds-check every declared length against what actually arrived and return nothing rather than throw.

Handlers declare a **lane**: either inline on the receive thread, for pure forwarding, or a named serial queue. The lanes are `execute`, `inspect`, `complete`, `format`, `measure`, `control` and `debug`. `control` is separate so that a kernel restart can never queue behind the stuck thing it is meant to fix. All lanes are created before any thread starts, because creating one lazily under a lock deadlocked against the Windows loader lock.

### Kernel -> sidecar: the model socket

Loopback TCP on an OS-assigned port, with the port and token handed to the kernel in environment variables. TCP rather than a Unix socket because AF_UNIX does not exist on Windows, and one mechanism that works everywhere beats two, one of which is missing.

Each message is length-prefixed and carries its token, which is read and compared **before anything else** - the earlier order let any local process make the sidecar allocate half a gigabyte per unauthenticated connection. A stranger has five seconds to authenticate; an authenticated peer has a deadline for the whole body, so a client sending one byte at a time cannot hold the loop.

One connection per message. Model data, mappings and config go through a single delivery worker in arrival order, because a mapping that overtook its model would describe the wrong one. The delivery queue holds two items on purpose: filling it blocks the connection thread, which blocks the kernel's send. That backpressure is the design.

The one message kind that gets an answer is `COMMAND`, and it exists because a show reads the viewer's state before it sends anything.

### Sidecar <-> kernel: Jupyter over ZMQ

Standard `jupyter_client`, TCP transport, five OS-assigned ports, HMAC-signed with the key in a `0600` connection file. `ipc://` was tried and dropped: the AF_UNIX path cap is about 104 bytes and the path is derived from the connection file, so the transport silently depended on how long the install path was.

Exactly one thread ever touches the shell socket. Callers submit requests and get back futures; replies are routed by message id to the future that asked. Getting this wrong interleaves message frames and the kernel answers "Invalid Signature".

A kernel and its client, threads and stop flag are one value handed to the pumps by argument, so a straggler from a retired kernel physically cannot touch its replacement. Restart is a full stop and a fresh start on fresh ports, because reusing them lost about one restart in two to a reconnect race.

Inspection and completion ride ipykernel 7's **subshell**, so they answer while a cell is running. Measured on a ten-second cell: 9.57 s on the main shell against 0.01 s on the subshell. Runs, warm-up and `chdir` stay on the main shell, because they must be ordered and `os.chdir` is process-wide.

### The debug wire

The sidecar binds a port and the debuggee dials out to it - the same policy as everything else. DAP and LSP use identical `Content-Length` framing, so one implementation serves both the debugger socket and the language server pipe. The sidecar is a relay, not a debug client: it spawns, frames both directions, pipes the process's real stdout, and understands no DAP. Sequence numbers, breakpoints and frames all live in the frontend.

## 5. Workflows

### Startup

The window is laid out, restored to its remembered geometry and shown before anything Python happens. The environment is ensured behind a splash that shows uv's own output rather than a spinner. Then the editor, tabs, viewer, explorer, console and menus are wired, the previous workspace is restored, the splash lifts - and only then is the sidecar spawned. The window is usable seconds before the kernel is warm.

The kernel's warm-up is held back until the console's own handshake is seen on iopub, because the shell channel is serial and the console would otherwise queue behind a two-second `import build123d`. A timer backstops a console that never handshakes.

The application starts on the Backend tab, streaming the log, and switches to the console only if startup ends with nothing unwell.

### Running code

Run Cell, Run Selection-or-Line and Run All send text to the kernel as one frame. Nothing is typed into the console, but the console *shows* the result inline as `In [n]:`, because it subscribes to every client's output. The sidecar reports "busy" the moment it accepts a run rather than waiting for the kernel, since a queued run used to read as idle.

Run File and Debug File are a different world: the buffer is saved, and the file on disk is executed in its own process with the kernel's environment and working directory. `show()` still reaches the same viewer, because the environment carries the model socket's port and token. While something else is running, every pane describes that something else.

### From `show()` to pixels

1. In the kernel, the shared pipeline assembles the configuration - workspace settings, then the viewer's reported state, then defaults, then this call's keywords - and hands the objects to `ocp_tessellate`.
2. The buffers are base64-decoded once, replaced by offset-and-length references, and concatenated into one raw payload with each array padded to an 8-byte boundary. Decoding costs about a gigabyte a second and saves a far more expensive JSON parse on the other side. A model with no geometry is refused outright: a header with nothing behind it once hung the viewer hard enough to need a force-quit.
3. The sidecar forwards the header **as the bytes the kernel produced** and the payload untouched, as one binary frame. The id-to-shape mapping goes to the measurement process instead of the webview - it would roughly double the traffic for data the viewer cannot read.
4. The frontend replaces every buffer reference with a typed-array view directly over the received `ArrayBuffer`. Nothing copies, and no number is parsed. A misalignment throws rather than silently falling back to a copy.
5. The page itself is the shared one. The studio supplies pane geometry, the binary path, and the wiring.

Measurements go the other way: the viewer reports a change, the sidecar keeps the picture, and only the active tool and selection reach the measurement process, which answers from the real boundary representation rather than the mesh - a radius is the radius. Event keys ride only on the change that carried them and are never accumulated, so a selection made minutes ago cannot replay into a later measurement.

### Quitting

Four routes lead out - the File menu, the close button, Cmd-Q or Ctrl-Q, and a window-close event - and all four arrive at one function. The window is configured *not* to exit on close, so closing it is an event the application handles rather than an exit it suffers. There is exactly one call that exits the process.

That function asks about unsaved buffers first, and a cancel there genuinely aborts the quit. If the prompt itself fails, the quit proceeds - nobody should be trapped in an application that will not close because its dialog broke. Then the recovery journal is thrown away, the open tabs and the window geometry are saved, the sidecar is told to go, whatever the frontend started itself is killed, and the process exits.

The journal goes first, and deliberately: everything unsaved has just been asked about, so whatever survived that prompt was either saved or discarded on purpose. Offering it back at the next start would argue with an answer the user has already given.

Below that, the guarantee does not depend on any of it running. See the contracts in section 3: a signal, a crash or a logout runs no JavaScript at all, and the tree still empties, because the operating system closes the pipes. That is also the case the journal exists for - what the pipes cannot save is the text in the window.

## 6. Editing and files

Buffers are keyed by an increasing integer, never by path: Save As re-keys, and an untitled buffer has no path at all. One editor holds many models; dirty state is a version-id comparison.

### Saving

The one thing here that can destroy work nobody can get back, so it is worth setting out in full.

**A save carries the buffer it started with.** There are two awaits in it - a format that takes as long as the sidecar takes, and the write - and the editor is live across both, so a click on another tab changes which buffer is "current" while it runs. Everything is therefore keyed: the text and the version it is on are read together from the captured buffer's own model, and that version is what the buffer is later marked clean at. Taking a fresh reading after the write would mark as saved every keystroke typed while it was in flight. A buffer with a save already in flight gets that save's answer rather than a second one.

**No two buffers may name one file.** A path another buffer holds is refused, whether it arrives from a save or a Save As. Two tabs on one path is a state with no correct behaviour left in it: both dirty against the same bytes, last save wins silently, and closing either offers to discard work the other still holds.

**The write itself never truncates the file it replaces.** Symlinks are resolved first - a plain rename used to replace the symlink rather than its target - then the content is written to a temporary beside the target, moved into place, and the permissions restored. The temporary is named for the instance, so two windows saving one file cannot collide on it.

There is a fallback to writing the target directly, and it is not decoration: it covers a writable file in a directory that refuses new entries, and a rename onto an existing file, which is well defined on POSIX and not on Windows. Because that write does truncate, the previous contents are read first and put back if it fails - so a failed save leaves the file as it was and the buffer still modified, rather than an empty file whose only remaining copy is on screen.

**Nothing is fsynced**, which the code says plainly rather than implying otherwise. The guarantee is against this process dying, not against losing power.

**A file that moved underneath the buffer is noticed.** A size and a modification time are recorded when a file is loaded and after every successful save, and compared immediately before the next one; on a mismatch the save asks - Overwrite, Reload, or Cancel. Reload is an edit rather than a fresh buffer, so the tab and the undo stack survive. Where a platform reports no usable modification time the comparison falls back to the size alone - still catching an edit that changed the length, missing one that replaced a character - and says so once in the log rather than silently detecting nothing.

**And what is unsaved survives an end that asks nobody.** Dirty buffers are shadowed into the application's data directory as they are typed, one file per buffer, and the copy is removed the moment it stops being the only one - a save, a closed tab, a graceful quit. What is left at the next start therefore means exactly one thing: that session ended without being asked. It is offered back in one prompt, buffers open modified and nothing is written, and a window still beating is left alone.

Two properties keep that honest. **Nothing on the typing path does any work** - the content-change event replaces a timer and returns, and the copy is made a second after the typing stops, which is also exactly how much work a crash can cost. And the copy is **the document, unwrapped**: not JSON with the text inside it, which would escape the whole buffer into a second string of its own size and make recovery parse it all back. A recovery copy is therefore an ordinary source file, openable in any editor by somebody who does not trust the prompt. Buffers past two megabytes are not shadowed at all - files over ten only *ask* before opening, so without a cap the worst case would be whatever somebody said yes to, serialised every second - and that is said once in the log, because silently having no recovery is worse than having none.

The liveness test is a heartbeat file, not a lock. The lock that answers dead-versus-running lives in the sidecar, and recovery runs at startup several seconds before the sidecar exists. A window touches its journal every thirty seconds and one is treated as abandoned after three missed beats: calling a live sibling dead would hand somebody else their unsaved work while they were still typing it, and calling a dead session live only defers the offer to the next start.

There is exactly one open folder or none. Opening or closing a folder closes every tab. The kernel's working directory follows: the folder root when one is open, otherwise the active file's directory, otherwise home. The change travels the same lane as runs, so a run can never overtake its own `chdir`, and it lands as a silent internal call that never appears in the console.

Language services come from two places and are merged in the sidecar. The static half is **basedpyright** over LSP, chosen over jedi because jedi binds `Self` to the defining class and so missed the builder variable in a `with BuildPart() as bd:` block. The live half is the kernel, which knows the object you built two cells ago; its entries win the merge because they carry real signatures. Diagnostics are pushed rather than polled, and ten severity overrides tuned for build123d idioms take a demo file from nine diagnostics, seven of them wrong, to exactly the two real ones. Formatting is black in-process, about a quarter of a millisecond per line; a buffer that does not parse is left alone silently, because the squiggle has already said so.

Monaco is assembled by hand - the editor API and the Python grammar only, plus about forty explicit widget imports. The barrel would add megabytes of unusable language services, and a provider registered without its widget succeeds and is then never asked, which is what once left the editor with no completion at all.

## 7. The console

A real `jupyter console --existing` running under a pty and displayed with xterm.js. A pipe would degrade prompt_toolkit to a dumb prompt; the tty is what buys line editing, history search, completion menus and magics.

A subclass fixes the two faults stock jupyter_console has with a second client: output written while prompt_toolkit holds raw mode staircases, and the prompt intermittently vanishes. External output is printed through prompt_toolkit's own `run_in_terminal` with explicit line-ending translation. `patch_stdout` is the obvious tool and the wrong one - it holds back trailing partial lines, and a prompt is exactly that.

Keystrokes and output cross as binary frames. A resize must reach the pty before the banner, or the first prompt wraps wrong, and the terminal refuses to measure a hidden pane, because fitting a `display:none` box once resized it to nothing.

## 8. The variable explorer

The namespace is inspected with an empty, silent execute request carrying a user expression, so the result comes back on the shell channel: no iopub traffic, no console echo, and `In [n]` untouched. Everything crosses as a JSON string, because IPython's pretty printer truncates long sequences with a literal ellipsis that then cannot be serialised - forever, on every refresh.

Refreshes are pushed, not polled: only an idle whose parent was an execute request triggers one, so console keystrokes and the application's own inspections do not. Refreshes coalesce to one queued.

It is bounded on purpose. Listing reads type, length and a short repr; rows are capped with a summary line, children are paged, and expansion has a budget. Nothing expensive is computed - measured on a real assembly, a bounding box costs 19 seconds, volume 2.8, area 2.2, and none of them are cached. Those belong in the console, where somebody asks for them and can see the cost.

Because inspection now overtakes running code, a read can race a mutation. Single-call reads were measured safe over 900 attempts; the others retry and then report "changing while the kernel runs", which is a state, not a failure.

## 9. The Python environment

Everything lives under the user's data directory, never in the application tree - even where the tree is writable, because a prefer-and-fall-back scheme means the shipped configuration is the least tested one. Settings and logs sit *beside* the environment, so rebuilding it keeps them.

One release pins one uv and one exact CPython. A release is a support target: with uv floating, two people running the same build could have different interpreters depending only on the day each first started it. Nobody reports a patch version, and nobody mentions that their uv shipped that morning. The cost - that a CPython security patch reaches users only when the application is rebuilt and retested - is accepted deliberately.

The SHA-256 of every uv artifact is committed to this repository and checked after every download. The `.sha256` files published beside the archives are deliberately not fetched: they sit on the same release page, so whoever could replace one could replace the other. They prove a download is intact, not that it is the artifact this application was built against. Provenance is verified once, at pin time, by a script with a real Sigstore chain, rather than at runtime by an unauthenticated API call that would have to fail open. The download uses an absolute-path `curl`, because PATH is the last place to trust for the binary that installs everything else.

The environment's `pyproject.toml` is generated from settings at every start: pinned dependencies, a floating build123d, and a custom section from a free-text field. Custom lines are PEP 508 - a bare name is PyPI, an absolute path is an editable checkout, a URL is git. Strings are escaped by a JSON round trip, because they are written into a file uv parses. Two entries are refused: a package already declared, since uv intersects duplicate declarations and the entry would silently do nothing, and a relative path, since there is nothing for it to be relative to and the dangerous case is the one that finds a same-named directory.

## 10. More than one instance

Nothing is shared, so nothing needs a lock to arbitrate it. Each instance owns a directory named by a UUID, holding its kernel connection file and a lock file held under an OS exclusive lock for the process's lifetime. Identity and liveness are deliberately separate: a UUID is never reused, and the lock is released by the operating system on any death, including a kill. A port would have conflated the two and broken both when reused.

The startup sweep that collects dead instance directories is the guarantee; the tidy release on the way out is a courtesy. That is the measured order, not the hoped-for one.

Settings are written by reading, merging one key, and writing back - the file wins for every key except the one being changed, and the read is not merged back into memory, because adopting another window's theme mid-session is not what anyone asked for. The original bug was never a race: writing the whole in-memory snapshot reverted the other instance on every write.

Logs are append-only with an instance id on every line. Four launches in fifteen once *looked* broken because another instance had truncated the file.

## 11. Diagnostics and health

Three log files sit beside the environment: the application's narrative, a mirror of the browser console at a level chosen in settings, and the measurement backend's own stream. Each rotates at start, keeping the previous session. The console mirror's level resets every start, because it is a tool, not a preference.

Subsystems report `ready`, `starting`, `degraded` or `failed`. `starting` counts as healthy, because the measurement backend legitimately loads for seconds at every start. Membership is not "can it break" but **"can it break without the user being told, and with nothing they can do about it"** - which is why the console, which prints `[console exited]` and is fixed by restarting the kernel, is deliberately not in the model.

The toolbar chip carries the worst state and is hidden while all is well: a status light that is always on teaches people not to look. A newly failed subsystem brings the Backend tab forward by itself; a degraded one does not. The recovery banner offers the *matching* action, worded differently for a backend and a kernel, because what was lost differs.

Every kernel request is watched. At five seconds, and every thirty after, one line reports the whole picture: is the kernel alive, is it believed busy, what the model channel and measurement process are doing, and which lanes are deep. Nothing is cancelled - the log simply stops going quiet. A line recording something starting is half a sentence, and the other half not arriving is itself worth writing down. A startup that wedges dumps every thread's stack after two minutes.

## 12. Public API

User code has two ways in, and they are the same thing:

```python
from build123d_studio import show, show_all      # this host, named
from ocp_viewer_core import show, set_defaults   # whichever host is running
```

The first names the application. The bindings module is a thin re-export over a single shared viewer and config object. A handful of keywords are excluded from that surface - the ones naming a window, a port or a pane, which have no meaning in a host that owns its own layout.

The second is the ecosystem's universal import: four packages export the same show family, each bound to its own transport, and a script that imports from the core leaves the choice of host to the core. It resolves by three rules - an environment variable names one, or exactly one host is installed and is therefore meant, or several are and it asks.

Asking is impossible here: a kernel has no terminal. So the kernel's environment carries `OCP_VIEWER_HOST=build123d_studio`, and the first rule settles it without a question. The variable is set in `kernel_environment()` rather than at kernel start, which is what makes it true for the two other processes built from the same environment - Run File and Debug File - so a script behaves identically whether it is run in the kernel, run as a file, or stepped through under the debugger.

Both imports resolve to the same bound methods on the same viewer, so mixing them in one session is harmless. The core's exported names are the "every host behaves the same" contract, and this host answers all of them. One visible difference: resolving through the core prints `Using viewer build123d_studio` the first time, which in this application lands in the console pane.

A script written either way runs unchanged in any of the four viewers - which is the entire point of the split, and the reason not to prefer one import over the other in documentation or examples.

The other public surface is the `studio` command, copied onto PATH by the user rather than installed, since installing would mean writing outside the application's tree. It has one rule: open this path, defaulting to the current directory, and always in a new instance. `studio part.py` opens the file **and its containing folder as the project**, so a file argument inherits the working-directory rule instead of inventing a third one. Paths are resolved before launching, because macOS starts applications from `/` and an unresolved `.` would silently open the wrong folder.

The kernel's connection file is deliberately discoverable, so an external `jupyter console --existing` can attach to the same namespace.

## 13. Dependencies

Python, all exactly pinned except build123d itself: ipykernel, jupyter_client, jupyter_console, prompt_toolkit, pyzmq, orjson, websockets, pywinpty on Windows, basedpyright, black, ocp-viewer-core and ocp-tessellate. build123d floats, because a blanket upgrade cannot move an exact pin, and the shipped exactness lives in the lockfile instead.

JavaScript: Neutralino as the shell, Monaco, xterm.js, three-cad-viewer, ocp-viewer-core's JS half, Vite for bundling.

Neutralino's own binaries are not committed; a script fetches them and verifies them against pinned digests, failing closed. They were previously the least-verified input to the shipped product.

## 14. Assumptions and safeguards

Stated plainly, because each one is load-bearing:

- **The installation may be read-only.** Nothing is ever written into the application tree. The one exception is Neutralino's window-state save, neutralised by shipping the directory it wants to create.
- **Loopback is not private.** Every channel is authenticated - a token on the WebSocket handshake, a token on every model-socket message, HMAC on the kernel channels.
- **Wire data is hostile.** Lengths read off the wire are bounds-checked on both sides before they index anything, and the explorer builds text nodes rather than markup.
- **A local process may be adversarial about resources, not just content.** Hence the read-token-first ordering, the message caps, and the per-receive deadlines.
- **Windows is not POSIX.** The loader lock deadlocks against thread creation, a zero-length file cannot be range-locked, an open file cannot be deleted, and the executable is shipped byte-for-byte unpatched because rewriting its resources made Defender score it a trojan.
- **The kernel's namespace belongs to the user.** Every internal request is silent and recorded, so it never shows up as activity.
- **A slow thing must not block an unrelated thing.** One owning thread per socket, lanes for everything that can be slow, a subshell for everything that must answer during a run.
- **Nothing is fsynced on save.** Said out loud in the code rather than implied. So the atomic write defends against this process dying, not against losing power - and the recovery journal does not change that, because it is written the same way.
- **An end that asks nobody will happen.** A webview that dies, a kill, a logout that never delivers `windowClose`, a power cut. Every graceful exit prompts; none of those is graceful, which is why unsaved work is shadowed as it is typed rather than only at the end.
- **A test fake that cannot express a failure hides it.** Three times in one session a green test turned out to be green because the fake could not do the thing being defended against: a `writeFile` that failed without truncating, a stat with no modification time, a `remove` that was not recursive. A fake is part of the claim, not scaffolding around it.
- **Session state is shared between windows, and that is a known limitation.** The open folder, the tabs, the window geometry and the splitter fractions all live under single keys in one settings file, so two windows are last-writer-wins for them. It costs which files were open, never their contents - and the recovery journal is deliberately per instance rather than in settings for exactly that reason.

## 15. Build, test and release

Vite bundles the frontend into Neutralino's document root. The CSS target is pinned separately from the JS target, because building CSS at `esnext` deleted the one vendor prefix that WKWebView honours.

Packaging assembles what the shell does not know about: the platform binary, the bundle, the sidecar and kernel trees, the generated environment inputs, the CLI launchers, and an empty temporary directory that stops a read-only installation crashing on close. macOS ships a disk image, Windows a zip whose executable is unmodified with the icon on a shortcut instead, Linux an AppImage that stages symlinks because its mount dies with the process. Nothing is code-signed yet, and that is the known fix for the Windows antivirus false positive.

Five test suites, run by what a change reaches rather than all at once:

| Suite | What it exercises |
|---|---|
| `yarn test` | Pure frontend modules under node:test - no DOM, no Neutralino, no Monaco |
| `yarn test:sidecar` | Sidecar classes directly, with races widened, through the application's own interpreter |
| `yarn test:integration` | The real sidecar and real kernel over the real socket, against the real user environment. The application must be quit first |
| `yarn test:frontend` | Playwright against **WebKit**, the same engine family as the macOS and Linux webviews, which reproduced two defects nothing else did. The sidecar is not stubbed; the test drives the real frame codec |
| `tests/manual.md` | By hand, on all three platforms. What the other four cannot reach |

The fifth is a suite even though nobody runs it with a command. Nearly everything in it fails for the same reason: the symptom is *a process or a file that outlives the application*, which nothing running inside the application can observe. The rest needs a window, a second program, a full disk, or a machine that is not this one - and several claims about Windows teardown rest on a single hand measurement, which is exactly what it is for.

An environment built for a test is a different environment from the one that breaks, which is why the integration suite uses the real one. And no test is counted until it has been shown to fail: the fix is un-applied in a throwaway copy outside the repository, and the proof is recorded in the spec's header rather than kept runnable.

Iterating on one frontend spec needs the bundle rebuilt first - `npx vite build --config vite.config.test.js` and then `npx playwright test -g "…"`. Playwright on its own runs whatever was last built, which is a stale-artefact failure that looks exactly like a real one.

## 16. Glossary

- **sidecar** - the Python helper process the frontend spawns; owns the kernel, the console pty, the model socket, measurement, the language server and the debug relays.
- **kernel** - the out-of-process ipykernel holding the user's namespace, shared by editor runs, the console and the explorer.
- **lane** - a named serial queue in the sidecar; how a slow handler is kept off the receive thread while staying ordered against its own kind.
- **subshell** - ipykernel 7's second execution thread over the same namespace; what lets inspection and completion answer while a cell runs.
- **tessellation** - turning exact CAD geometry into the triangles and edges a GPU can draw.
- **BRep** - boundary representation, the exact geometry the mesh came from, and what measurements are computed on.
- **OCCT** - Open CASCADE Technology, the C++ geometry kernel underneath everything. **OCP** is its Python binding.
- **three-cad-viewer** - the three.js renderer in the viewer pane.
- **ocp_viewer_core** - the shared library owning the show pipeline, config semantics and the viewer page across four hosts.
- **DAP / LSP** - the debug and language server protocols; the same `Content-Length` framing serves both.
- **uv** - Astral's Python package and interpreter manager; downloads the pinned CPython and builds the environment.
- **connection file** - the JSON naming a kernel's ports and signing key; the attach point for an external console.
