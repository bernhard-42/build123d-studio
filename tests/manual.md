# Manual tests

The fifth suite. Everything here is a property the other four cannot reach, and the reason is nearly always the same: the symptom is *a process or a file that outlives the application*, and no test that runs inside the application can see it. The rest need a human because they need a window, a second program, a full disk, or a machine that is not this one.

Run them on **macOS, Windows and Linux**. Several of the findings behind them are platform-shaped - every interpreter on Windows is a uv trampoline stub, AppImage stages symlinks that die with the mount - and every one of those contracts has been measured exactly once, by hand, on one build. A shell wraps every spawn on **every** platform, not only Windows: Neutralino implements `spawnProcess`'s `cwd` by prefixing `cd '<dir>' &&`, so the macOS tree is `build123d-studio` → `/bin/sh -c` → the sidecar, exactly as Windows is via `cmd.exe`. Measured 2026-08-17; the stdin-EOF shutdown contract therefore passes through a shell everywhere.

Nothing here needs millisecond timing. Where a test is about a race, the setup widens the window until a person can walk into it; if a step ever reads "quickly", the setup is wrong and should be fixed rather than practised.

## Before you start

1. Build and install the release artefact for the platform, not a development tree - packaging is part of what is under test (the empty `.tmp/`, the AppImage's staging, the unpatched Windows executable).
2. **Quit the application before replacing the bundle.** Replacing it underneath a running process deletes the directory the sidecar is holding.
3. Have a terminal open beside it. Most tests end in "and now look at what is still running".
4. Work on a copy of any file you care about. Several tests are about losing them.

### What is still running

The one command each test refers back to. Run it *after* the application's window has gone.

Anchor on **the paths the application runs from**, never on the word "build123d" or on interpreter names. Measured on 2026-08-17 against a live 0.3.0.dev139: a name-based pattern matched a jupyter server belonging to an entirely different project, and - because the pattern text appears in the command line of the shell running it - the check also matched itself. The `[b]` is what stops that second one: the regex `[b]uild123d` matches the text `build123d`, which the command's own `[b]uild123d` does not contain.

**macOS / Linux**

```sh
pgrep -fl '[b]uild123d Studio\.app|[b]uild123d-studio/runtime'      # macOS
pgrep -fl '[b]uild123d-studio/(runtime|app)|[b]uild123d-studio.*AppImage'   # Linux
```

With parents, which is the form worth using because an orphan's parent is 1:

```sh
pids=$(pgrep -f '[b]uild123d Studio\.app|[b]uild123d-studio/runtime')
[ -z "$pids" ] && echo "clean" || ps -o pid,ppid,comm -p $(echo $pids | tr ' ' ',')
```

**Windows** (PowerShell). Parent links, not command lines: every interpreter appears twice because of uv's trampoline stub, and every spawn is wrapped in `cmd.exe`. The runtime path is the anchor that catches the kernel, the console, `measure_process`, basedpyright and its node, which share no command line with each other - only an interpreter.

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*build123d-studio\runtime*' -or $_.Name -eq 'build123d-studio.exe' } |
  Select-Object ProcessId, ParentProcessId, Name |
  Sort-Object ParentProcessId | Format-Table -AutoSize
```

**Run it bare.** The `[b]` protects the pattern, not the rest of the line: piping the result through a `sed` that spells out the runtime path made the check match its own shell, measured while writing this. Do not decorate it, and do not run it from a directory whose name it matches.

A pass is **no output at all**. The old wording here allowed "except processes you started yourself", which is exactly the judgement call this anchoring removes - and which made the check unusable on a machine doing anything else.

**And as a tree, which is the better thing to look at when it fails.**

```sh
pstree -s 'build123d-studio/runtime'      # macOS (homebrew pstree)
```

Anchored on the path for the same reason the `pgrep` is - `pstree -s build123d` drags in anything merely *named* that, another project's jupyter server included. It finds fewer processes than the `pgrep` does (the app binary's own command line does not contain the runtime path) and still shows all of them, because **a tree goes up to the root for every process it matches**, so the app appears as the ancestor of the sidecar that did match.

That rooting is the point rather than a cost. A surviving sidecar has been reparented to pid 1, so it appears as **its own branch directly under `launchd`** - which is the seven-orphan signature, and is invisible in a flat list. The pass here is "the only branch is my own terminal": `pstree` matches its own command line and no bracket trick can stop it, because `-s` is a substring match rather than a regex. Measured with nothing to find, that leaves exactly one branch, rooted at the terminal.

Two things it is not. Anchoring on a **pid** instead - `pstree -p $(pgrep …)` - has no self-match at all, but fails with a usage dump the moment nothing matches, which is the case this check exists for. And on **Linux** `pstree` is psmisc's, where `-s` means "show the parents of this pid" and there is no string filter at all, so the line above does something else entirely there; use the `pgrep`, or `pstree -sp <pid>` against one match.

---

## A. Nothing outlives a quit

### M1 — The ordinary quit

**Proves** the whole tree goes. **Status:** should pass today.

1. Start the application. Wait for the console prompt and the variable explorer to be live.
2. Run a cell so the kernel is warm.
3. Quit from the File menu.
4. Wait five seconds, then run *What is still running*.

**Pass:** nothing. **Repeat** for each exit route, because they are separate code paths that happen to meet: the window close button, `Cmd`/`Ctrl`-Q, and the menu item.

### M2 — Quit during the first-run install

**Proves** uv and its children are collected. **From** F1, commit for `src/running.js`. **Status:** the point of that commit; fails before it.

1. Move the environment aside so the next start builds one:
   - macOS `mv ~/Library/Application\ Support/build123d-studio/runtime ~/runtime.bak`
   - Linux `mv ~/.local/share/build123d-studio/runtime ~/runtime.bak`
   - Windows `Move-Item $env:APPDATA\build123d-studio\runtime $env:APPDATA\runtime.bak`
2. Start the application. The splash will say it is downloading and installing - this takes minutes and is the window.
3. While it is still installing, close the window.
4. Run *What is still running*, and look for `uv`, `curl`, `tar`, and any `python` warming the geometry kernel.

**Pass:** none of them. **Before the fix:** `uv` continues, reparented, still writing into the environment.

**Then** restore the environment (`mv ~/runtime.bak .../runtime`) or let the next start rebuild it.

### M3 — Quit before the window is usable

**Proves** stdin is watched from the first line. **From** F2, `dfee3ae`.

1. Start the application and quit **while the splash is still up** - before the editor is usable at all. On a warm environment this is a few seconds; if that is too tight, use M2's setup to make startup take minutes.
2. Run *What is still running*.

**Pass:** nothing, and within a second or two. **Before the fix:** the sidecar continued its whole startup - launching a kernel and a console it was about to throw away - and sat out every blocking wait first, up to thirty seconds for a webview and sixty for a kernel.

### M4 — Quit with a wedged language server

**Proves** teardown's first step cannot spend the whole budget. **From** F3, `5be17c6`.

1. Start the application, open a Python file, and type enough to have the language server analysing.
2. Make it deaf rather than dead, so it stops reading its input but keeps the pipes open:
   - macOS/Linux `pkill -STOP -f langserver`
   - Windows: suspend the `node` process with Process Explorer (right click → Suspend)
3. Quit.
4. Run *What is still running*.

**Pass:** the sidecar, kernel, console and measurement backend are all gone within a few seconds. The suspended `node` may remain - it is suspended, and nothing can be done about that from here - so **kill it yourself afterwards**. What is being tested is that everything *else* was still reached.

**Before the fix:** closing a buffered writer nobody reads never returned, the eight second watchdog fired, and every later step - including the kernel's kill escalation - never ran.

### M5 — Quit during a long computation

**Proves** a kernel inside a GIL-holding native call is still taken. **From** F4. **Status: not implemented yet** - expect this to fail until the kernel is stopped first and by something it cannot ignore.

1. Run something that spends a long time inside one OCCT call - a boolean or a fillet on a large assembly, thirty seconds or more in a single operation, not a Python loop. A Python loop is not the case; it releases the GIL.
2. While it is still computing, quit.
3. Run *What is still running*.

**Pass:** no `ipykernel`. **Before the fix:** the kernel's parent poller is a Python thread and cannot run while a native call holds the GIL, so it computes on, orphaned, holding hundreds of megabytes.

### M6 — Quit with a Run File in flight

**Proves** the supervisor takes its script.

1. Open a file whose body is `import time; time.sleep(600)`.
2. Run File (`Ctrl`-F5). The Run/Debug tab shows it running.
3. Quit.
4. Run *What is still running*.

**Pass:** neither the supervisor nor the script.

### M7 — Quit while stopped at a breakpoint

**Proves** the supervisor's pipe works when every debuggee thread is suspended.

1. Open a file, set a breakpoint on an early line, Debug File (`F5`).
2. Wait until it stops at the breakpoint and the variable explorer shows the frame.
3. Quit **without** continuing or stopping the session.
4. Run *What is still running*.

**Pass:** no `debugpy`, no supervisor, no debuggee.

### M8 — Kill the application outright

**Proves** every child's parent-death contract, with no cooperation from anything.

1. Start the application, warm the kernel, start a Run File as in M6.
2. Kill the application process itself - not the sidecar. Anchor on the path it runs from, for *What is still running*'s reason: `-f build123d-studio` also matches other projects' processes, and here it would match the sidecar too, which is the one thing this test must not kill directly.
   - macOS `kill -9 $(pgrep -f '[b]uild123d Studio\.app/Contents/MacOS/build123d-studio')`
   - Linux `kill -9 $(pgrep -f '[b]uild123d-studio/(app|AppImage)')`
   - Windows `Stop-Process -Name build123d-studio -Force`
3. Wait ten seconds. Run *What is still running*.

**Pass:** nothing. This is the case no JavaScript runs in, so only the pipes and the pollers can save it.

**Do it for `-9`, `-15` and `-3`, and once from Activity Monitor's Quit.** They are one case - the application ends without running any of its own code - and each of them was failing on 2026-08-17 at 0.3.0.dev139, macOS. The tree survived every one of them, `ppid 1`, holding kernel, console, measurement backend and language server; Activity Monitor's *Force Quit* was the only variant that cleaned up, because it takes the whole group rather than the one process.

**What it was, since it is the shape to check for again.** The sidecar's contract is that closing its stdin starts the teardown - but a kill closes stdin, stdout *and* stderr in the same instant, and the first thing the teardown does is write "stdin closed, shutting down" to stderr. That write got EPIPE, `BrokenPipeError` ended the watch thread, and `stop()` was never called; the eight-second watchdog that exists to leave anyway was defeated the same way, since it announces itself on the same stream. `channel.log` now swallows `OSError`, and both exit paths run their teardown in a `finally`. Held by `test_the_sidecar_goes_when_the_application_is_killed_rather_than_quitting` and `test_a_signal_still_tears_down_with_nobody_left_to_log_to`, which fail against the old code.

Two more observations from the same session, worth keeping because they say where to look next time: killing the intervening `/bin/sh -c` does **not** clean up (it holds nothing - it is there because the spawn is a `cd … && …` command string), while `kill <sidecar-pid>` does, which is the signal handler working.

### M9 — Two instances

**Proves** instances are independent and neither sweeps the other away.

1. Start two instances (`studio .` twice; on macOS the second needs `open -n`).
2. Warm the kernel in both.
3. Quit one. Confirm the other still runs code, still shows models, still completes.
4. Quit the second. Run *What is still running*.

**Pass:** nothing after the second quit, and nothing disturbed after the first.

---

## B. Nothing is lost

Everything in this section is about the save path, and all of it is implemented - these are checks, not a to-do list. What none of them has ever been is *run*: every cross-platform claim here rests on reading rather than measurement, which is what the results table at the end is for.

### M10 — Switch tabs during a slow save

**Proves** the save writes the buffer it started with. **From** D1.

1. Make the window wide enough to walk into. Format on save is on by default and black costs roughly a quarter of a millisecond per line, so a large file gives seconds:
   ```sh
   python3 -c "open('big.py','w').write('x = 1\n' * 40000)"
   ```
2. Open `big.py` and a second file `small.py` with recognisable content.
3. Edit `big.py`. Press `Cmd`/`Ctrl`-S and **immediately click the `small.py` tab**.
4. When the save finishes, look at both tabs, then at both files on disk.

**Pass:** `big.py` on disk holds big.py's text; `small.py` is untouched; the tabs still name the files they did.

**The failure:** `small.py`'s text is written into `big.py`, and the `small.py` *tab* is renamed to `big.py` and marked clean - so nothing prompts at quit and big.py's real content is gone.

### M11 — Type during a save

**Proves** the version recorded is the version written. **From** D2.

1. With `big.py` from M10 open, press `Cmd`/`Ctrl`-S and keep typing a recognisable word while it saves.
2. When it settles, check the tab's modified dot, then quit.

**Pass:** either the typing is on disk, or the tab is still marked modified and quitting asks about it.

**The failure:** the tab is clean, quitting asks nothing, and the typing is gone.

### M12 — New file over one that appeared meanwhile

**Proves** the tree does not truncate what it did not know about. **From** D3.

1. Open a folder in the sidebar so it lists.
2. In a terminal, create a file in that folder with content: `echo "important" > <folder>/notes.py`
3. **Without refreshing the tree**, use the sidebar's New file and name it `notes.py`.

**Pass:** it refuses, saying the file exists. **The failure:** the file is truncated to nothing and opened empty, and the content is unrecoverable.

### M13 — Save As onto an existing file

**Proves** a save lands on the name the panel vetted, and asks about it once. **From** D7.

1. Have a `bracket.py` in a folder, with content you can recognise.
2. From a different buffer, Save As into that folder and type the name **`bracket`** - without the extension.

**Pass:** the file is written under the name typed, and `bracket.py` is untouched. See M25.

3. Now do it again typing the name **with** its extension, so the panel's own replace prompt appears, and answer **Replace**.

**Pass:** it saves, and asks nothing further. **The failure, found on 2026-08-17:** a second dialog, "It changed on disk … was modified by something else since it was opened here", about a file nothing had touched. The stamp a buffer carries describes the file it came from, and this was comparing it with a different file. Its Reload button made it worse than noise: the way out of a save was an offer to replace the buffer with the contents of the file just chosen to overwrite. The check now runs only when the target is the path the stamp describes.

4. **Focus.** The panel must take the keyboard when it opens - type a character and it goes into the name field, not into the editor behind it.

**macOS asks once**, the first time: *"build123d Studio wants to control System Events."* Allow it. The panel is run inside System Events because a dialog belongs to the process that showed it, and `osascript` is not a foreground application - one it owns opens behind the window that asked for it. **Denying it is not fatal**: the script fails, and the built-in dialog is used instead, which takes focus but puts the whole path in the name field.

**It may open collapsed** the first time - the compact panel with no file browser. Click the disclosure triangle; macOS remembers the expanded state per owning application, so it stays expanded afterwards. Measured 2026-08-17.

Three forms were measured before this one was chosen: an untargeted `activate` costs four seconds waiting for an event nobody answers and does not focus; `tell me to activate` is the same; System Events is prompt and focuses.

5. **macOS only**, on the first Save As of the session: the panel's **Save As:** field holds `part.py`, not `/Users/…/part.py`, and it opens in that file's folder.

**The failure:** the whole path in the name field. Neutralino's dialog is AppleScript underneath and has one string for two independent parameters - it hands anything that is not a directory to `default name`. The application runs its own `choose file name` on macOS now (`src/savedialog.js`); Windows and Linux still use Neutralino's, which split a full path themselves. Worth re-checking on both of those for exactly that reason.

### M14 — Save onto a full disk

**Proves** a failed save does not destroy the last good copy. **From** D4.

1. Make a small volume and put a file on it:
   - macOS `hdiutil create -size 2m -fs APFS -volname tiny tiny.dmg && hdiutil attach tiny.dmg`
   - Linux `truncate -s 2M tiny.img && mkfs.ext4 tiny.img && mkdir -p /tmp/tiny && sudo mount -o loop tiny.img /tmp/tiny && sudo chown $USER /tmp/tiny`
   - Windows: create and mount a 2 MB VHD in Disk Management
2. Put a recognisable `part.py` on it, then fill the volume: `dd if=/dev/zero of=<volume>/filler bs=1k count=10000` until it errors.
3. Open `part.py` in the application, edit it, and save.

**Pass:** the save fails with a message, the tab stays modified, and **`part.py` on disk still holds its original content**.

**The failure:** the fallback write truncates the original and then fails too, so the only copy left is the one in the editor.

### M15 — The file changed underneath you

**Proves** an external edit is noticed. **From** D5.

1. Open `part.py` in the application.
2. In another editor - or another instance of this one - change and save it.
3. Back in the application, edit and save.

**Pass:** it says the file changed on disk and offers Overwrite / Reload / Cancel. **The failure:** the external edit is silently overwritten.

### M16 — Recovering after a crash

**Proves** unsaved work survives an abrupt end. **From** D6.

1. Open two files, edit both, and open a third, brand-new, unsaved buffer with recognisable text. Save none of them.
2. Kill the application outright (as in M8).
3. Start it again.

**Pass:** it offers to recover, and accepting brings back all three buffers - the untitled one included - still marked modified. **The failure:** everything unsaved is simply gone.

**It failed outright on 2026-08-17 at 0.3.0.dev140/141, macOS.** Twice, for two different reasons, and the copies were being written correctly throughout - twenty-one leftover journals were sitting in `~/Library/Application Support/build123d-studio/recovery`, several holding real work.

The first: a session whose beat was over a minute old was skipped as "asleep", which is every crash not restarted within a minute. The second, after that was fixed: a session whose beat was *younger* than ninety seconds was skipped as "alive" - and a kill followed by a restart is about seven seconds, so every attempt landed inside the window and nothing was ever offered. Measured at 16:24:14 and 16:24:21.

**Both were the same mistake**: a heartbeat is a clock, and no interval lets a clock tell a dead window from a live one. Liveness is now the operating system's answer. Each journal records the pid that owns it, and a start asks `ps -A -o pid=,comm=` (or `tasklist /NH /FO CSV`) which pids are windows of this application. Nothing waits, nothing ages.

**Why the suite was green through all of it:** `tests/frontend/recovery.spec.mjs` seeded the beat file as `""`, and `Number("")` is `0` - the one value the rule stepped around. Every test ran down a path no crashed session ever takes.

**When re-running this, also check the pile**: `ls ~/Library/Application\\ Support/build123d-studio/recovery` should not accumulate directories across sessions. One per running window, and gone after each is answered.

**And run it twice more, because the two halves fail separately:**

4. **Restart immediately** - within a few seconds of the kill. It must offer at once, with no waiting.
5. **Two windows.** Open a second Studio, leave unsaved work in both, kill only the first, and start a third. It must offer the killed window's files and **not** the running one's - and answering Discard must leave the running window's copies on disk. Check with `ls ~/Library/Application\\ Support/build123d-studio/recovery/*/`.

### M17 — A file that is not UTF-8

**Proves** bytes survive a round trip. **From** D8, and this one is an **experiment**: the answer is not yet known, so record what happens rather than expecting a pass.

1. Make a file with a raw high byte:
   ```sh
   printf 'x = "caf\xe9"\n' > latin.py
   ```
2. Open it, change something elsewhere in the file, save.
3. `xxd latin.py | head` and compare with the original.

**Record:** whether the `0xe9` survived, became `EF BF BD`, or the file failed to open at all.

**Recorded 2026-08-17, macOS, 0.3.0.dev139: `EF BF BD`.** The file is read as UTF-8 with replacement and written back as UTF-8, so the original byte is gone and cannot be recovered from the saved file.

**And VS Code does exactly the same thing, byte for byte, on the same file.** Measured side by side rather than assumed. So this is what an editor does by default, not something this application gets wrong: the expectation users bring is calibrated on it, and a Python 3 source file with a raw high byte and no PEP 263 declaration is not valid Python 3 in the first place - `python latin.py` refuses it with `SyntaxError: Non-UTF-8 code starting with '\xe9'`.

**The control, and run it first, because it is what bounds all of the above.** A file containing `\u03b1 = 3` - a Greek alpha, `CE B1`, and a legal Python 3 identifier under PEP 3131 - opens, edits, saves and reloads with its bytes intact. Measured 2026-08-17. So what is lossy is not "non-ASCII", which is ordinary and works; it is "not valid UTF-8", which cannot be decoded at all and has to become something. Without this control the recording above reads as though unicode were broken here, and it is not.

**Left as it is, deliberately.** What VS Code has and this does not is a way to *see* it: an encoding in the status bar and a "Reopen with Encoding" command. If this is ever revisited, that is the shape worth copying - say so on open, rather than refusing the file or guessing at latin-1. `readBinaryFile`/`writeBinaryFile` exist, so a lossless round trip is reachable without leaving Neutralino; it was not done because nothing about it is what a user of this application expects to be different.

### M18 — What a save does to the file's identity

**Proves** what is lost when the inode is replaced. **From** D8. Also an experiment.

1. macOS/Linux: `ln part.py hard-link.py`, and on macOS `xattr -w com.apple.metadata:test 1 part.py`.
2. Edit and save `part.py` in the application.
3. `ls -li part.py hard-link.py` and `xattr -l part.py`.

**Record:** the link count and inode, and whether the attribute survived. Permissions are restored deliberately; ownership and extended attributes are not.

---

## C. Platform-shaped

### M19 — The Windows process tree, read by parent

**Windows only.** Every claim about Windows teardown in this repository was measured once, on one build.

1. Start the application, warm the kernel, open a Python file so basedpyright starts.
2. With the application still running, capture the tree:
   ```powershell
   Get-CimInstance Win32_Process | Select ProcessId, ParentProcessId, Name |
     Where-Object { $_.Name -match 'python|node|uv|cmd' } | Format-Table -AutoSize
   ```
3. Record it. Expect `cmd.exe` wrapping the sidecar, and each interpreter doubled by uv's trampoline stub.
4. Quit, and capture again.

**Pass:** the second capture is empty. **Record the first**, because it is the map, and it is currently written down from one measurement.

### M20 — A read-only installation

**Proves** nothing is ever written into the application tree.

1. Make the installed application read-only:
   - macOS `chmod -R a-w /Applications/build123d\ Studio.app`
   - Linux: run the AppImage from a read-only directory
   - Windows: deny write on the install folder for your user
2. Start it, use it, resize the window, quit. Start it again.

**Pass:** it starts, the window geometry is remembered, and quitting does not crash. This is what the shipped empty `.tmp/` is for.

### M21 — The `studio` command

1. Copy `studio` onto PATH. From a project directory, run `studio` with no arguments, then `studio part.py`.

**Pass:** the first opens that directory as the project; the second opens the file **and its containing folder**, and the kernel's working directory is that folder in both cases (`import os; os.getcwd()` in the console).

### M22 — Quit while the kernel is restarting

**Proves** a stop landing during a restart finds the new kernel. **From** F7, `340e5e7`.

1. Warm the kernel, then use Restart Kernel and quit immediately afterwards.
2. Run *What is still running*.

**Pass:** no `ipykernel`. This one is genuinely narrow by hand; the unit test is the real proof, and this is a sanity check.

**Widen the pass to "nothing at all", and repeat it.** On 2026-08-17 at 0.3.0.dev139, macOS, this left the *sidecar* behind twice out of several attempts - no kernel and no console, which is the restart having done its half, but `measure_process` and basedpyright still running under a sidecar that never exited. `ipykernel` alone would have called that a pass.

**Caught in the act with `sample <sidecar-pid>`, and it is two faults on top of each other.** The receive thread was inside `Sidecar.stop()`'s first step, blocked in ZeroMQ's `zmq_ctx_term` - jupyter_client's `cleanup_resources` calls `context.destroy(linger=100)`, and `term()` waits for every socket in that context to be closed, with nothing bounding the wait. `restart()` and `shutdown()` both reach `_shutdown()` and nothing makes them exclusive, so a quit landing inside a restart's `start()` tears down a context another thread is still building on - which zmq's own documentation says must not be done. The tells in the sample, worth repeating because they are what identified it: the `lane-control` thread (the restart) had exited, every `ZMQbg` thread was gone, and `stdin-watch` was on a lock rather than on `read` - it had heard the quit and was waiting behind the receive thread's `_stop_lock`.

The eight-second deadline exists for precisely this and could not fire either, because `_give_up_stopping` announces itself on a stderr the departing application had already taken with it - the same broken pipe as M8. Both halves are fixed: the deadline can speak and leave, and `Kernel` now has a lifecycle lock so a quit cannot destroy a context a restart is still building on. A quit landing inside a restart waits for that restart's kernel to come up instead, which is bounded by the restart rather than by nothing at all.

**So the pass is "nothing at all", promptly.** If a quit here takes eight seconds and the log says `Shutdown stuck on the kernel`, the deadline has done its job and something else is holding the step - record it, because that is a new one.

---

### M23 — uv's own children on Windows

**Windows only.** F1 kills what `run()` started, and Neutralino's kill there enumerates **one level** of children and terminates them - there is no process group and no job object. Every spawn is additionally wrapped in `cmd.exe /c`, so one level from the handle is `cmd.exe` and the next is `uv`. Anything **uv** itself started - `git`, for a package source it has to fetch - is a level further down and may survive.

1. Put a git package source in Settings → Packages, so `uv lock` has to run `git`.
2. Move the environment aside as in M2 and start the application.
3. While it is resolving, close the window.
4. Run *What is still running*, and look specifically for `git`.

**Record either way.** If `git` survives, F1 is complete on POSIX and partial on Windows, and the fix is a job object rather than a deeper walk. This has never been measured.

### M24 — A deep path on Windows

**Windows only.** The scratch file is named for the instance now, which makes it about nine characters longer than before. Paths are capped at 260 unless long paths are enabled.

1. Make a project whose full file path is within about twenty characters of 260.
2. Open a file in it, edit, and save.

**Pass:** it saves, or it refuses and says so - what must **not** happen is an emptied or half-written file. It is allowed to fall back to a direct write, which is the designed behaviour when the temporary cannot be created; check the log for "Could not save through a temporary file".

**Settled 2026-08-18, measured on dev167.** Past 260 characters the save fails with "Unable to write file on save"; one directory shorter it succeeds. That is where it stays: supporting longer paths needs a `longPathAware` manifest in the packaged executable *and* the machine-wide registry setting, so it would still fail on a default Windows - and the refusal already protects the work, which is what this test is for. A project that deep belongs in another folder.

### M25 — Save As takes the name as typed

The application appends nothing to a name. The panel asks before replacing a file and can only ask about the name it was given, so a save must land on exactly that name.

1. Have `bracket.py` in a folder. From another buffer, Save As into it and type **`bracket`**, without an extension.

**Pass:** a file called `bracket` is written, `bracket.py` is untouched, and **no second dialog appears** - the panel's own replace prompt is the only one there is. The tab reads `bracket`.

### M26 — Does a stat carry a modification time on this platform?

**All three, and this one is a measurement rather than a pass or a fail.** Neutralino's `Stats` type declares `modifiedAt` on every platform, but a type declaration is a promise and not evidence. The changed-on-disk check compares size **and** time; where no usable time comes back it falls back to size alone, which still catches an edit that changed the length and misses one that replaced a character.

1. Open a file in the application and save it, so a stamp is recorded.
2. In another editor, change **one character** for another - the same number of bytes - and save.
3. Back in the application, edit and save.

**Record:** whether it asked about the file having changed on disk.

- Asked → the platform reports a usable modification time. Full detection.
- Did not ask → size-only. Then repeat with an edit that **adds** a line; it must ask that time, and if it does not, the check is not working at all on this platform and that is a defect rather than a degradation.

The application also says so once in the log the first time it stamps a file without a time. Check `build123d-studio.log` for it.

### M27 — A kernel wedged in a native call, on Windows

**Windows only, and unmeasured.** The kernel is stopped first precisely because its fallback is the weakest: its parent poller is a Python thread, and a long OCCT call holds the GIL for its whole duration, so the poller cannot run. On POSIX that is answered by jupyter_client escalating to a group kill, and a signal needs nothing of the GIL.

Windows has no SIGKILL. `provisioner.kill()` becomes `TerminateProcess` on its **direct child**, which per the measured tree is uv's launcher stub rather than the interpreter doing the work - and `ParentPollerWindows` needs the GIL to run its exit. So both layers may miss it. Nobody has ever checked.

1. Run something that spends a long time inside one OCCT call - a boolean or a fillet on a large assembly, a minute or more in a single operation, not a Python loop.
2. While it is still computing, quit from the File menu.
3. Run *What is still running*, and look for a `python.exe` holding the instance's `kernel.json`:
   ```powershell
   Get-CimInstance Win32_Process |
     Where-Object { $_.CommandLine -match 'ipykernel|kernel.json' } |
     Select-Object ProcessId, ParentProcessId, CommandLine | Format-Table -AutoSize
   ```

**Record either way.** If it survives, the kernel is holding a loaded geometry kernel and the whole namespace, indefinitely if the call never returns - and the fix is a Job object around it rather than a deeper walk, the same answer M23 would need.

This is the same shape as M23 - a kill that reaches one level - but on jupyter_client's path, which M23 does not cover. Doing both in one Windows session is sensible.

### M28 — The process listing, per platform

**Proves** the one thing recovery now depends on. **macOS and Linux are measured**; Windows is not, and this is where that is closed.

The application asks the operating system which pids are windows of itself, and matches on the name it finds beside its *own* pid rather than on a constant - because the answer differs on every platform:

```sh
ps -A -o pid=,comm=      # macOS: full path.  Linux: name truncated to 15 chars
```

macOS reports `/Applications/build123d Studio.app/Contents/MacOS/build123d-studio`; Linux reports `build123d-studi`, because `comm` holds fifteen characters and the name is sixteen. Both measured on 2026-08-17.

**On Windows**, run this with Studio open and confirm the shape:

```powershell
tasklist /NH /FO CSV | Select-String build123d
```

**Pass:** a quoted CSV row whose **first** field is the image name and whose **second** is the pid, e.g. `"build123d-studio.exe","1234","Console","1","50,000 K"`. If either the order or the quoting differs, `src/liveness.js` parses it wrongly and every journal will look dead - which offers a running window's work to another window. `tests/unit/liveness.test.mjs` holds the expected shape; correct it there.

### M29 — Save All with an unnamed buffer

**Proves** the command reaches the buffers with no other copy.

1. Edit a saved file, then New File and type something into it. Both tabs dirty.
2. **Save All.**

**Pass:** the saved file is written, and the unnamed buffer opens a save panel asking where it should go. Answering it writes the file and clears both dots; cancelling it leaves that buffer dirty and stops the run, so a quit afterwards still asks about it.

### M30 — Rename and delete from the tree

**Proves** the tab follows a rename, and that a delete is recoverable.

1. Open a file from the tree, so it is the one on screen.
2. Right-click it. **Pass:** the menu appears, the row is picked out, and nothing new opens in a tab.
3. **Rename** it, type a new name, Enter.

**Pass:** the file is renamed on disk, the tab holding it now reads the new name, and the row's temporary mark is gone. **Then edit and save it**: the bytes must land in the new file, and the old name must not reappear - a buffer left pointing at the old path recreates it on the next save, which is the failure worth looking for.

4. Right-click another file and choose **Delete**.

**Pass:** it asks, and answering moves the file to the platform's trash - check it is actually there and can be put back. Where a volume has no trash the application asks a second time before removing it for good.

5. Dismiss a menu with Escape, and abandon a rename with Escape.

**Pass:** the temporary mark comes off in both cases. Only the file on screen stays marked, or none if nothing is open.

### M31 — An interrupt that cannot land

**Proves** the button says something when it cannot work.

1. Run something OCCT holds the GIL through - a boolean on a large assembly, not a `while True: pass`, which interrupts normally.
2. Press **Interrupt**.

**Pass:** nothing for five seconds, then a prompt offering to restart the kernel, saying why the interrupt could not arrive. **Cancel** leaves the work running; **Restart** stops it and empties the namespace. Pressing Interrupt several times must produce one prompt, not one per press.

### M32 — User snippets

**Proves** a snippet file written outside the application is found and usable.

1. **With no file of your own**, type `?bdp` in a Python file. **Pass:** the shipped set is offered - build123d-portable's, vendored - and accepting inserts `with BuildPart() as p:`.
2. Put a snippets file at the path About names - `snippets.json` beside the settings. **Copy a `.code-snippets` file in unedited**, comments and trailing commas included: it is read with jsonc-parser, the library VS Code itself uses. [build123d-portable's set](https://github.com/build123d/build123d-portable/blob/main/scripts/build123d-OCP.code-snippets) is the one to try. A file that will not parse says where in the log and costs nothing else.
3. Start the application, or press Apply in Settings if it was already running.
4. In a Python file type the first character of a prefix, e.g. `?`.

**Pass:** the suggestion list opens showing every snippet with that mark, and narrows as more is typed. Accepting one **replaces the mark** - no stray `?` is left in front of the inserted text - and its tab stops are live, so Tab walks them. An entry of yours with a prefix the shipped set also uses replaces it.

### M33 — The menu bar inside the window

**Windows and Linux.** The window keeps its system frame - so its rounding, its shadow, its dragging, its resizing and its buttons are the window manager's - and a strip below it carries the icon and the menus. macOS keeps its system menu and must be checked for *no* change.

Drawing the bar and its keyboard are covered by `tests/frontend/titlebar.spec.mjs` and `tests/unit/titlebar`; what needs a person is that it looks right beneath a real frame and that the keyboard route works against a real window manager.

1. **One frame, one strip.** The system title bar, and below it the menu strip - not two title bars, and no system menu bar as well as ours.
2. **The window behaves as any other.** Rounded corners, a drop shadow, drag by the title bar, resize by every edge and corner, snap to the sides, double-click to maximise. All of this is the window manager's, so a failure here is a Neutralino question rather than ours.
3. **The keyboard.** `Alt` alone underlines a letter in each menu. `Alt-F` opens File from anywhere, including with the caret in the editor. Arrows walk the bar and its items, Enter chooses, Escape closes. Typing in the editor is untouched.
4. **The mouse.** Clicking a menu opens it and clicking it again closes it; with one open, moving across the bar follows; clicking anywhere else closes it.
5. **No inspector window.** `enableInspector` is off, so nothing opens beside the application. `yarn start` still has it for development.

**macOS:** no strip at the top of the window, the system menu is still there, Cut/Copy/Paste still work, and `Alt-F` still reaches the editor.

### M34 — The keyboard after Open Folder, on Windows

**Windows only.** The folder chooser is `SHBrowseForFolderW`, which is modal on the application's own thread: the window stays the active one throughout, so no `WM_ACTIVATE` is sent, so Neutralino never calls `MoveFocus` and the keyboard is left with the frame rather than the WebView. The repair is a second, one-pixel, off-screen window that takes the foreground and exits, which makes the activation happen. Neutralino's own fix for the general case is #1491/#1564 and is in the version we ship.

1. **Open a folder and type.** File > Open Folder, choose a folder, and without clicking anything press `Alt`. The menu underlines appear - no Windows beep. `Alt-F` opens File.
2. **The same after cancelling.** Open the chooser, cancel it, and press `Alt`. The keyboard is back either way.
3. **Nothing flashes.** No window appears anywhere on screen, on any monitor, and the application does not blink or drop to the taskbar.
4. **Nothing is left running.** Afterwards the process tree has exactly one `build123d-studio.exe` per window, and no extra one loitering. The throwaway exits on `ready` and has a four-second timer behind that.
5. **No ring around the tree.** With no file open the caret goes to the tree; the pane must not be outlined.
6. **Open File is unaffected.** `GetOpenFileNameW` restores the focus itself, and no second window is created for it.

**macOS and Linux:** opening a folder creates no second window - the platforms restore the focus themselves. Worth one check that opening a folder there still leaves the keyboard where it should be.

## Results

One row per platform per run. Record the build, not just the date.

| | macOS | Windows | Linux |
|---|---|---|---|
| Build | 0.3.0.dev167 | 0.3.0.dev167 | |
| M1 ordinary quit | ok | ok |  |
| M2 quit during install | ok | ok |  |
| M3 quit before usable | ok | ok |  |
| M4 wedged language server | ok | ok |  |
| M5 long computation | ok | ok |  |
| M6 run in flight | ok | ok |  |
| M7 at a breakpoint | ok | ok |  |
| M8 killed outright | ok | ok |  |
| M9 two instances | ok | ok |  |
| M10 tabs during save | ok | ok |  |
| M11 typing during save | ok | ok |  |
| M12 new file collision | ok | ok |  |
| M13 Save As collision | ok | ok |  |
| M14 full disk | open | open |  |
| M15 changed on disk | ok | ok |  |
| M16 crash recovery | ok | fixed (dev168) |  |
| M17 not UTF-8 | ok | ok |  |
| M18 file identity | ok | n/a |  |
| M19 Windows tree | n/a | ok | n/a |
| M20 read-only install | ok | ok |  |
| M21 studio command | ok | warn |  |
| M22 quit during restart | ok | ok |  |
| M23 uv's children (Windows) | n/a | open | n/a |
| M24 deep path (Windows) | n/a | won't fix | n/a |
| M25 Save As name as typed | ok | ok |  |
| M26 stat carries mtime | ok | ok |  |
| M27 wedged kernel (Windows) | n/a | ok | n/a |
| M28 process listing | ok | ok |  |
| M29 Save All unnamed | ok | ok |  |
| M30 tree rename/delete | ok | ok |  |
| M31 interrupt cannot land | ok | ok |  |
| M32 user snippets | ok | ok |  |
| M33 menu bar in window | n/a | ok |  |
| M34 keyboard after Open Folder | ok | ok |  |

**The run of 2026-08-18, macOS and Windows, 0.3.0.dev167.** The first full pass; Linux has still never been run. What it left:

- **M16 failed, and it was the untitled buffer rather than the platform.** Ctrl-N, type, kill, restart: two Untitled tabs, one empty and one holding the work. The workspace remembers paths and never contents, so an untitled buffer is not among the tabs that reopen; with nothing else open the start puts up an empty scratch tab, and recovery opened its own beside it. macOS passed only because that session had named files. Fixed by taking the empty tab over, covered by `tests/frontend/recovery.spec.mjs`.
- **M21 warned on Windows** with `NE_RS_UNBLDRE: Unable to load application resource file /resources/favicon.ico` on every launch from a console. The page names an icon now, so nothing asks for the one we do not ship.
- **M26 answers an open design question**: the "It changed on disk" dialog appeared on both, so `stat` carries mtime on Windows and the check runs at full strength rather than falling back to size alone.
- **M28 confirms what pid ownership needs**: `tasklist` matched exactly one row per window - the sidecars carry other names - which is what makes `liveWindows()` a list of windows rather than of processes.
- **M14 is the only row never attempted**, and M23 waits on ocp-tessellate and ocp-viewer-core reaching PyPI.
