# Threading and communication: how solid is it?

Written 2026-07-30, after fixing three Windows bugs in one session. The question
this answers is Bernhard's: *"honestly, how stable/brittle is the whole
threading & communication code — I see too many timings, timeouts and it looks
very heuristic."*

Short answer: the instinct is right, and the three bugs found today are evidence
for it. But "too many timeouts" is not quite the defect. Most of the timeouts
are fine. The problem is narrower and more fixable than a count suggests.

Everything below was measured on Windows against the pinned environment
(CPython 3.14.6, jupyter_client 8.9.1, pyzmq 27.1.0), driving the real sidecar
over its WebSocket. Nothing here is inferred from reading alone.

---

## 1. What broke today

Three bugs. Two shared a root cause that no review had considered, and it is a
platform property rather than a mistake in the design.

**On Windows, loading a native extension deadlocks against creating a thread.**
`LoadLibrary` holds the OS loader lock while CPython holds the GIL across the
call; every new thread needs that same lock to run `DLL_THREAD_ATTACH` in each
loaded DLL. OCP is a very large native stack, so the window is wide. Measured on
its own: one `Thread.start()` during `import ocp_vscode` blocked for **0.64 s**,
3/3 runs, even where it recovered.

| # | Symptom | Mechanism |
|---|---|---|
| 1 | Run did nothing, sidecar silent for the session | Lanes were created on first use, holding `_lanes_lock` across `Thread.start()`. The first idle refresh opened the inspect lane from the iopub pump, mid-import, and wedged — holding the lock every `kernel.execute` needs. |
| 2 | `show(Box(1,1,1))` took 70 s | `websockets`' accept loop starts a thread per connection and hit the same wall, so the sidecar stopped accepting connections entirely. `_convert()` probes the viewer six times per `show()` against the port we deliberately aim at ourselves; each waited the full 10 s connect timeout instead of an instant 403. |
| 3 | Console pane empty for ~34 s after "Initializing console" cleared | The warm-up fired on the console's *first byte*, documented as meaning "the console has its kernel_info reply". True of a POSIX pty, false under ConPTY — those bytes are prompt_toolkit setting up the terminal, sent before the console asks the kernel anything. The import then queued ahead of the console's handshake. |

Measurements, before → after:

```
show(Box(1,1,1))          70.06 s  ->  0.11 s      (3 runs each)
  second show             60.04 s  ->  0.08 s
  of which workspace_config()   10.011 s   <- websockets' default open_timeout
           get_changed_config() 10.004 s
           _deliver              0.003 s   <- the model socket was never at fault
Run reaching the kernel   0/3 runs ->  3/3 runs    (kernel wrote a file, not console output)
measurement backend       never    ->  3.3-3.6 s
```

Bug 2 was invisible in a way worth remembering: the sidecar logged neither
"Measurement backend loaded" nor "failed". **An absent log line was the tell**,
and it is absent from every Windows log we have.

---

## 2. Verdict

The *decisions* are better than most codebases of this size. The *mechanisms*
are under-tested, and a handful of them infer state from timing instead of
reading it off the protocol. That handful is where every bug lives.

### Sound — keep, do not "simplify"

- Every port OS-assigned, never configured.
- Token checked pre-upgrade, constant-time, plain 403.
- One lock (`_shell_lock`) covering every touch of the shell socket.
- Restart by full replacement rather than `restart_kernel()`.
- Binary frames with 8-byte alignment for zero-copy typed arrays.
- Lanes as serial queues with preserved order.

### Brittle

Fourteen timing constants in our own code, plus two in libraries we rely on
(`websockets`' 20 s keepalive, its 10 s connect timeout — the latter is what
turned bug 2 into 70 s rather than an error). The count is not the problem. This
distinction is:

| Legitimate — a deadline on a real boundary | Heuristic — timing standing in for a fact |
|---|---|
| `wait_for_ready(60)`, `wait_for_client(30)`, `READY_TIMEOUT 90 s`, `RESTART_TIMEOUT 120 s`, `SOCKET_TIMEOUT 30` | warm-up fired on the console's first byte — **wrong, fixed today** |
| `SHELL_POLL 0.25`, iopub `0.5`, `FOLLOW_POLL 0.05` — poll slices, cheap and self-correcting | `_iopub_thread.join(timeout=2)` and then proceeding **anyway** — this is M3, unfixed, and it can put two threads on one zmq socket |
| `EVALUATE_TIMEOUT 15`, `IDLE_REFRESH_TIMEOUT 5` — bounded waits on a kernel that may be busy | `_internal_requests = deque(maxlen=64)`, appended *after* the send |
| | `_reap(2.0)` then SIGKILL |
| | the warm-up backstop `Timer(30.0)` — now only a safety net, but still a guess |

You can see the third one misbehaving in your own log without any instrumentation:

```
17:41:38.520  Kernel busy
17:41:38.521  Kernel idle
```

A busy/idle pair one millisecond apart is the variable explorer's own refresh
leaking status as if it were user activity, because its `msg_id` reaches
`_internal_requests` after the send rather than before.

---

## 3. What is still open, and it is the same class

`reviews/fix-plan-2.md` R4 already names this fault class and is unstarted:

- **M3** — restart's unchecked 2 s join; two threads on one iopub socket.
- **M8** — pty fd close/recycle TOCTOU, introduced by the lanes commit.
- **M1** — kernel *process* death undetected. Relevant now: before today's fix a
  measure click would have joined an import thread that never finished, with no
  UI signal at all — the same "goes quiet" failure mode.
- **M4** — measurement service check-then-use race across three fields.

So the codebase already knows about this; it simply has not been worked yet.

---

## 4. What would actually fix it, in order

1. **Commit an integration harness.** Highest leverage by a wide margin. Drive
   the real sidecar over its WebSocket, press Run, and assert *the kernel* wrote
   a file — not that the console drew a prompt. All three of today's bugs would
   have been caught by it. Today it is 8 tests, all for `quote()`; every bug
   here was found by a throwaway harness in a scratch directory.

2. **Give each zmq socket a single owning thread**, with request/reply futures
   instead of a shared socket under a lock. `_shell_lock`, A11's single-consumer
   invariant and the discarded-reply counting then stop being documented
   invariants and become structural. This is the one change that removes a fault
   class rather than another instance of it. A18's own fix note anticipated it:
   *"routing shell traffic through a single owning thread would subsume the
   lock."*

3. **Replace the remaining heuristics with protocol facts**, the way the warm-up
   trigger was replaced today — it now waits for the `kernel_info_request` →
   `idle` that the kernel actually publishes on iopub. Cheapest first:
   `_internal_requests.append(msg_id)` **before** the send, not after. One line.

4. **Record the Windows rule where it will be read:** no native-extension import
   off the main thread. `pty_console.py` already moved its imports to module
   scope for a neighbouring reason (CPython's per-module import locks); that
   comment is correct but describes half the hazard.

---

## 5. What is not established

Honesty about the limits of the above:

- The console fix is a real ordering bug fixed, but it has **not** been shown to
  account for the reported 34 s. On a warm machine the prompt lands at ~8.7 s
  either way, because the console process's own startup dominates there — and
  only 0.56 s of that is importing `jupyter_console` and `prompt_toolkit`, so
  roughly 3 s is IPython shell init and its history SQLite, unexplained. Cold,
  with Defender, that is the prime suspect for most of the 34 s. Needs a cold
  re-test to get a real number.
- The precise DLL whose `DllMain` closes the deadlock cycle was not identified.
  It does not change the fix, and the loader-lock/thread-creation interaction is
  reproduced and measured, but the last link is inferred rather than observed.
- Everything here was measured headlessly. The packaged window confirms Run and
  `show()` work; the rest of the UI has not been re-exercised since.
