"""Static analysis of the buffer, from basedpyright over LSP.

The kernel completes against the live namespace, which is the thing no reading
of a file can do: it knows the methods of the part the user built two cells ago,
because that object exists. What it cannot do is know anything at all until the
code has been *run* - a freshly opened file with `from build123d import *` at the
top offers nothing for "b = Bo", because on a cold kernel there is no Box. In a
notebook that is the accepted bargain. In an editor, where people write a whole
file before running it, it is most of the time.

So both, and this is the half that reads.

## Why a language server and not jedi

jedi was tried first, because IPython already depends on it and it needed
nothing new to ship. It answers the ordinary cases and misses build123d's
central idiom: for

    with BuildPart() as bd:
        Box(1, 2, 34)
    bd.part

it infers `bd` as Builder rather than BuildPart, so `part` - the property the
whole builder pattern exists to produce - is not offered. The cause is `Self`:
build123d annotates `__enter__ -> Self` correctly, and jedi binds Self to the
class that *defines* the method instead of the one it was reached through.
basedpyright resolves it, measured on the same file: `bd.pa` gives `part` first.

build123d is a large API that leans on overloads, Self, and typed builder
context managers, and the difference between a parser that mostly works and a
type checker that follows the annotations shows up immediately on it.

Measured against the pinned environment, basedpyright 1.39.9:

    initialize                    2.8 s, once, at startup
    first completion              1.1 s, while build123d is analysed
    afterwards                    0.00-0.27 s
    the same completion again     0.00 s

## What it costs

basedpyright is Pyright with Node bundled as a Python wheel, so it pins and
installs like every other dependency - no runtime download, and wheels for every
platform this application ships: macOS arm64 and x86_64, Linux glibc and musl on
both arches, Windows amd64 and arm64. 271 MB installed, into the per-user
environment that already holds the interpreters and uv's cache, not into the
4 MB application bundle.

It is a separate process speaking JSON-RPC over stdio, which is what this module
is. It runs here rather than in the kernel, so it also answers while a cell is
running - the kernel serves shell requests serially and cannot.
"""

import os
import pathlib
import subprocess
import sys
import threading
import time

from channel import log
from framing import encode, read_message

# How long to wait for one answer. Generous next to the measured 0.0-0.3 s,
# because the number that matters is not this one: main.py holds a single
# completion slot and refuses the rest, so a slow answer costs one keystroke's
# suggestions rather than a queue of them.
REQUEST_TIMEOUT = 10

# How long the server gets to answer `initialize`. Cold, on a slow machine, this
# is the one call that legitimately takes seconds.
INITIALIZE_TIMEOUT = 60

# The buffer the warm-up pretends to be. Named rather than left as None so it
# cannot collide with a real unsaved buffer, and so a diagnostic arriving from
# it is recognisable.
WARM_UP_KEY = "warm-up"

# LSP CompletionItemKind, which is a number on the wire, against the vocabulary
# the frontend maps to Monaco kinds - IPython's, because the kernel got there
# first and both sources have to arrive in one list speaking one language.
KINDS = {
    2: "function",    # Method
    3: "function",    # Function
    4: "class",       # Constructor
    5: "instance",    # Field
    6: "instance",    # Variable
    7: "class",       # Class
    8: "class",       # Interface
    9: "module",      # Module
    10: "instance",   # Property
    14: "keyword",    # Keyword
    21: "instance",   # Constant
    22: "class",      # Struct
    23: "keyword",    # Event
    25: "param",      # TypeParameter
}


def analysis_settings(kernel_dir):
    """How strict to be, and where else to look for modules.

    Squiggles are only worth drawing if they are almost always right. Measured
    on an ordinary build123d file - a builder block, a couple of shapes, and two
    deliberate mistakes - the defaults produce nine diagnostics, seven of them
    wrong about this application's own idioms. The two real ones are then
    indistinguishable from the noise, which is how people learn to ignore the
    whole gutter.

    ``extraPaths`` alone removes five of the seven. `build123d_studio` is the
    kernel-side package this application puts on PYTHONPATH when it launches the
    kernel, so nothing outside that process can resolve it: `from
    build123d_studio import show` - the second line of the New File template -
    was an unresolved-import error, and `show` being untyped then produced three
    more. Telling the server where that package lives is not a preference, it is
    the truth about how the code runs.

    The overrides are each about a build123d idiom that is correct code:

      reportWildcardImportFromLibrary  `from build123d import *` is how
                                       build123d is used, and it is line one of
                                       the template this application ships
      reportUnusedCallResult           `Box(10, 10, 10)` inside a builder block
                                       is called for its effect on the builder;
                                       its result is *meant* to be unused
      reportUnusedExpression           a bare expression on its own line is how
                                       a script shows a value, which is the
                                       whole shape of an interactive CAD file

    The rest are basedpyright's strictness beyond Pyright's own default -
    reportAny and the reportUnknown* family - which on a dynamically typed
    geometry library means underlining most of the file. typeCheckingMode
    "standard" is Pyright's default rather than basedpyright's "recommended",
    for the same reason.

    None of this is a judgement about type checking in general. It is a
    judgement about a scratch file for building a bracket.
    """
    return {
        "typeCheckingMode": "standard",
        "extraPaths": [kernel_dir],
        "diagnosticSeverityOverrides": {
            "reportWildcardImportFromLibrary": "none",
            "reportUnusedCallResult": "none",
            "reportUnusedExpression": "none",
            "reportMissingTypeStubs": "none",
            "reportUnknownMemberType": "none",
            "reportUnknownVariableType": "none",
            "reportUnknownArgumentType": "none",
            "reportUnknownParameterType": "none",
            "reportAny": "none",
            "reportExplicitAny": "none",
        },
    }


class LanguageServer:
    """One basedpyright process, and the JSON-RPC conversation with it.

    Answers rather than raises, throughout. This is analysing half-written code
    by definition - that is when completion is asked for - and a server that
    dies or a reply that does not come must cost that one keystroke's
    suggestions, not the frame that carried it.
    """

    def __init__(self, python_path, analysis=None, on_diagnostics=None):
        self._python_path = python_path
        self._analysis = analysis or {}
        self._on_diagnostics = on_diagnostics
        self._process = None
        self._replies = {}
        self._arrived = threading.Condition()
        self._next_id = 1
        # Guards the id counter and the write end. LSP framing is a header and a
        # body, so two threads writing at once would interleave them into
        # something the server reads as one corrupt message - the same hazard,
        # and the same answer, as the kernel's shell socket.
        self._send_lock = threading.Lock()

    # --- lifecycle ---

    def start(self):
        """Launch the server and complete the handshake. True if it is usable."""
        if self.alive():
            return True
        command = [_langserver_binary(), "--stdio"]
        try:
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                # The server's own logging, which is not this application's log.
                stderr=subprocess.DEVNULL,
                # Never the application directory: a read-only install, and a
                # bundle that can be replaced underneath a running process.
                cwd=os.path.expanduser("~"),
            )
        except OSError as exc:
            log(f"Could not start basedpyright: {exc}")
            self._process = None
            return False

        threading.Thread(target=self._read, name="lsp-read", daemon=True).start()

        started = time.monotonic()
        reply = self.request("initialize", _initialize_params(), timeout=INITIALIZE_TIMEOUT)
        if reply is None:
            log("basedpyright did not answer initialize; static completion is off")
            self.stop()
            return False
        self.notify("initialized", {})
        log(f"basedpyright ready in {time.monotonic() - started:.1f}s")
        return True

    def alive(self):
        return self._process is not None and self._process.poll() is None

    def stop(self):
        """Stop the server, and wait for it to actually be gone.

        Waited for rather than signalled and forgotten. This is a Node process
        holding an analysis of the whole environment, and the sidecar's own exit
        is an os._exit that runs no cleanup - so a terminate nobody waits on
        leaves it to be reparented and to keep its memory until the OS gets
        round to it.
        """
        process, self._process = self._process, None
        if process is None:
            return
        try:
            process.stdin.close()
            process.terminate()
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        except OSError:
            pass
        for stream in (process.stdout, process.stdin):
            try:
                stream.close()
            except OSError:
                pass

    # --- the protocol ---

    def request(self, method, params, timeout=REQUEST_TIMEOUT):
        """Send a request and wait for its reply. None if there is not one."""
        with self._send_lock:
            request_id = self._next_id
            self._next_id += 1
        if not self._write({"jsonrpc": "2.0", "id": request_id, "method": method,
                            "params": params}):
            return None

        deadline = time.monotonic() + timeout
        with self._arrived:
            while request_id not in self._replies:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # Dropped rather than remembered: every keystroke is a
                    # request, so a map that keeps what timed out grows for the
                    # life of the process.
                    log(f"basedpyright did not answer {method} in {timeout}s")
                    return None
                self._arrived.wait(remaining)
            return self._replies.pop(request_id).get("result")

    def notify(self, method, params):
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _write(self, message):
        framed = encode(message)
        with self._send_lock:
            if not self.alive():
                return False
            try:
                self._process.stdin.write(framed)
                self._process.stdin.flush()
            except (OSError, ValueError) as exc:
                log(f"basedpyright stopped listening: {exc}")
                return False
        return True

    def _read(self):
        """Deliver replies, and answer the server's own questions.

        A language server asks things back - which interpreter to analyse
        against, above all - and a client that ignores those hangs waiting for
        an answer the server is not going to give until it has been answered
        itself.
        """
        process = self._process
        stream = process.stdout
        while True:
            message = read_message(stream)
            if message is None:
                break
            if "method" in message and "id" in message:
                self._write({"jsonrpc": "2.0", "id": message["id"],
                             "result": self._answer(message)})
                continue
            if "method" in message:
                self._notified(message)
                continue
            with self._arrived:
                self._replies[message.get("id")] = message
                self._arrived.notify_all()

        if process is self._process:
            log("basedpyright exited; it will be restarted on the next request")

    def _notified(self, message):
        """A notification: diagnostics, progress, log lines.

        Only the first is wanted. Progress and log notifications are the
        server's own business and there are a great many of them; forwarding
        them anywhere would be noise in a log this application's users are
        invited to send in.
        """
        if message.get("method") != "textDocument/publishDiagnostics":
            return
        if self._on_diagnostics is None:
            return
        params = message.get("params") or {}
        uri = params.get("uri")
        diagnostics = params.get("diagnostics")
        if not isinstance(uri, str) or not isinstance(diagnostics, list):
            return
        try:
            self._on_diagnostics(uri, diagnostics)
        except Exception as exc:  # noqa: BLE001 - this runs on the reader thread
            log(f"Diagnostics handler failed: {exc}")

    def _answer(self, message):
        """What the server asks the client for, in the one case it matters.

        `workspace/configuration` is how it learns which Python to analyse
        against, and getting it wrong means every build123d import is unresolved
        and every completion empty. The interpreter is this process's own: the
        sidecar runs inside the application's environment, so sys.executable is
        by definition the one the user's code will run in.

        The same answer carries how strict to be, and *which section is being
        asked for decides the shape*. That is not a detail: an answer of the
        wrong shape is accepted silently and changes nothing, which is exactly
        what happened first - four different configurations produced four
        identical sets of diagnostics until this stopped returning one flat
        object to every request. The server asks for one section at a time -
        observed: "python", then "basedpyright.analysis", then "basedpyright" -
        and each wants what it is named for.
        """
        if message.get("method") != "workspace/configuration":
            return None
        items = message.get("params", {}).get("items", [])
        return [self._section(item.get("section")) for item in items]

    def _section(self, section):
        if section == "python":
            return {"pythonPath": self._python_path}
        if section in ("basedpyright.analysis", "python.analysis"):
            return dict(self._analysis)
        if section in ("basedpyright", "pyright"):
            return {"analysis": dict(self._analysis)}
        return {}


class Completer:
    """basedpyright, wrapped in the surface the sidecar asks questions through.

    Document state is held here rather than left to the caller. LSP is stateful
    - the server has to be told a file is open and told again when it changes -
    while the frame that arrives from the frontend carries the whole buffer
    every time. Reconciling the two is this class's job, and it is why nothing
    above it has to know that a language server is involved at all.
    """

    def __init__(self, env_root, app_dir, python_path=None, on_diagnostics=None):
        self._on_diagnostics = on_diagnostics
        self._server = LanguageServer(
            python_path or sys.executable,
            analysis=analysis_settings(os.path.join(app_dir, "kernel")),
            on_diagnostics=self._diagnostics,
        )
        # Where an unsaved buffer pretends to live. A real path when there is
        # one, because that is what lets the server resolve `import helpers`
        # against the file beside it.
        #
        # One pseudo-file per buffer rather than one for all of them: the
        # application opens as many unsaved buffers as somebody presses New, and
        # a shared name would give them one document between them - so the
        # diagnostics for each would be published against the others.
        self._untitled = os.path.join(env_root, "untitled")
        self._versions = {}
        self._sources = {}
        # uri -> what the frontend called it, so a diagnostic can be sent back
        # to the buffer it belongs to rather than to a path it has never heard
        # of.
        self._owners = {}
        self._lock = threading.Lock()

    def warm(self):
        """Start the server and let it analyse build123d before anyone is waiting.

        initialize is 2.8 s and the first completion another 1.1 s while
        build123d is read. Left alone both land on whichever keystroke happens
        to be first, which is the same argument the kernel warm-up makes and the
        same answer.
        """
        if not self._server.start():
            return
        started = time.monotonic()
        # Under a key of its own, and closed afterwards. The analysis of
        # build123d it pays for is cached in the server and survives; what does
        # not survive is a document nothing is showing, which would otherwise go
        # on publishing diagnostics against a buffer the editor has never heard
        # of for the rest of the session.
        self.complete("from build123d import *\nb = Bo", 2, 6, None, WARM_UP_KEY)
        self.forget(None, WARM_UP_KEY)
        log(f"Completion warm-up finished in {time.monotonic() - started:.1f}s")

    def stop(self):
        self._server.stop()

    def complete(self, source, line, column, path=None, key=None):
        """Completions at a position, as entries the sidecar can merge.

        ``line`` is 1-based and ``column`` is 0-based - Monaco's line and one
        less than Monaco's column. LSP counts both from zero.

        The span each match replaces comes from the server's own textEdit where
        there is one, which is the only reliable answer: for "part.ce" it is
        "ce" and not "part.ce", and getting it wrong is silent until somebody
        accepts a suggestion and finds "part.cecenter" in their file.
        """
        uri = self._sync(source, path, key)
        if uri is None:
            return []
        result = self._server.request("textDocument/completion", {
            "textDocument": {"uri": uri},
            "position": {"line": line - 1, "character": column},
        })
        items = _items_of(result)
        if items is None:
            return []

        # The server's own ranking, applied here rather than left to Monaco.
        # Pyright returns everything and expects the client to sort by sortText;
        # the sidecar then truncates, and truncating an unsorted list is how the
        # one match somebody wanted ends up being the one dropped.
        items.sort(key=lambda item: (item.get("sortText") or item.get("label") or ""))

        lines = source.split("\n")
        line_text = lines[line - 1] if 0 < line <= len(lines) else ""

        entries = []
        for item in items:
            label = item.get("label")
            if not isinstance(label, str) or label == "":
                continue
            start, end = _replacement(item, line_text, column)
            entries.append({
                "text": label,
                "type": KINDS.get(item.get("kind"), "instance"),
                "signature": item.get("detail") or "",
                "start": start,
                "end": end,
            })
        return entries

    def signatures(self, source, line, column, path=None, key=None):
        """The call the cursor is inside, for the parameter hints popup.

        Structured rather than a docstring: Monaco highlights the parameter
        being typed, so it needs the parameters as a list and the index of the
        current one.

        Returns None when the cursor is not inside a call, which is most of the
        time and is not a failure.
        """
        uri = self._sync(source, path, key)
        if uri is None:
            return None
        result = self._server.request("textDocument/signatureHelp", {
            "textDocument": {"uri": uri},
            "position": {"line": line - 1, "character": column},
        })
        if not isinstance(result, dict):
            return None
        found = result.get("signatures") or []
        if len(found) == 0:
            return None

        active_signature = result.get("activeSignature")
        active_signature = active_signature if isinstance(active_signature, int) else 0
        chosen = found[active_signature] if active_signature < len(found) else found[0]
        # A signature may carry its own active parameter, which overrides the
        # one on the envelope. Both are optional, and "no parameter is current"
        # is a real answer - a call with more arguments than the signature has.
        active = chosen.get("activeParameter", result.get("activeParameter"))

        return {
            "signatures": [
                {
                    "label": signature.get("label") or "",
                    "parameters": [
                        parameter.get("label") or ""
                        for parameter in signature.get("parameters") or []
                    ],
                    "documentation": _summary(signature.get("documentation")),
                }
                for signature in found
            ],
            "activeSignature": active_signature,
            "activeParameter": active if isinstance(active, int) else -1,
        }

    def hover(self, source, line, column, path=None, key=None):
        """What the name under the pointer is. None when it is nothing.

        The cheapest of the three, because the process, the document and the
        transport all exist for completion already. It answers the question a
        CAD script raises constantly - what does this name actually hold -
        which on this API is rarely obvious: build123d's operations return
        Part, Sketch, Curve and Compound, and which one decides what the next
        line is allowed to do.

        The contents come back as one string. LSP allows three shapes for them
        and a server may pick any, so flattening happens here rather than in the
        frontend, which has no business knowing the protocol.
        """
        uri = self._sync(source, path, key)
        if uri is None:
            return None
        result = self._server.request("textDocument/hover", {
            "textDocument": {"uri": uri},
            "position": {"line": line - 1, "character": column},
        })
        if not isinstance(result, dict):
            return None
        value = _hover_text(result.get("contents"))
        if value == "":
            return None
        return {"value": value, "range": result.get("range")}

    def sync(self, source, path=None, key=None):
        """Tell the server the buffer changed, without asking it anything.

        The editor calls this on a timer after an edit. Completion and the rest
        sync as a side effect of asking, but diagnostics are *pushed* - the
        server publishes them when it has analysed a document it was told about
        - so without this the squiggles would only refresh when somebody
        happened to open the suggestion list.
        """
        self._sync(source, path, key)

    def forget(self, path=None, key=None):
        """Close a document, when its tab closes.

        Otherwise the server holds an analysis of every file opened this
        session, and goes on publishing diagnostics for buffers that are no
        longer on screen.
        """
        uri = self._uri_for(path, key)
        with self._lock:
            known = self._sources.pop(uri, None)
            self._versions.pop(uri, None)
            self._owners.pop(uri, None)
        if known is not None:
            self._server.notify("textDocument/didClose", {"textDocument": {"uri": uri}})

    def _uri_for(self, path, key):
        if isinstance(path, str) and path != "":
            return pathlib.Path(path).as_uri()
        # A buffer that has never been saved. Named after the key the frontend
        # gave it, which is stable for as long as the tab is.
        name = "".join(c if c.isalnum() else "-" for c in str(key or "buffer"))
        return pathlib.Path(os.path.join(self._untitled, f"{name}.py")).as_uri()

    def _diagnostics(self, uri, diagnostics):
        """Hand diagnostics back to whoever owns that document.

        The server publishes against a uri, including for files it read on its
        own account while following an import - somebody else's library, which
        no tab is showing. Those are dropped here: an owner is a buffer this
        class was told about.
        """
        if self._on_diagnostics is None:
            return
        with self._lock:
            owner = self._owners.get(uri)
        if owner is None:
            return
        self._on_diagnostics(owner["path"], owner["key"], diagnostics)

    def _sync(self, source, path, key):
        """Tell the server what the buffer says now. Returns its uri, or None.

        Full text every time rather than incremental edits. The frontend sends
        the whole buffer with every request, so there is no edit to send - and
        a diff computed here to save bytes on a loopback socket would be
        machinery whose only job is to be wrong in some corner.
        """
        if not self._server.alive() and not self._server.start():
            return None

        uri = self._uri_for(path, key)
        with self._lock:
            known = self._sources.get(uri)
            version = self._versions.get(uri, 0) + 1
            self._versions[uri] = version
            self._sources[uri] = source
            # The warm-up deliberately gets no owner. Its diagnostics are then
            # dropped by the same path that drops a library file the server read
            # on its own account: an owner is a buffer somebody is looking at,
            # and closing the document afterwards is too late - the publish has
            # already happened by then.
            if key != WARM_UP_KEY:
                self._owners[uri] = {"path": path, "key": key}

        if known is None:
            self._server.notify("textDocument/didOpen", {"textDocument": {
                "uri": uri, "languageId": "python", "version": version, "text": source}})
        elif known != source:
            self._server.notify("textDocument/didChange", {
                "textDocument": {"uri": uri, "version": version},
                "contentChanges": [{"text": source}],
            })
        return uri


def _langserver_binary():
    """basedpyright's console script, beside the interpreter running this.

    The documented way to launch it. `python -m basedpyright.langserver` is not
    an alternative: the module has no __main__ guard, so it imports and exits
    without starting a server - silently, which is worth writing down.
    """
    directory = os.path.dirname(sys.executable)
    name = "basedpyright-langserver"
    if sys.platform == "win32":
        name += ".exe"
    return os.path.join(directory, name)


def _initialize_params():
    return {
        "processId": os.getpid(),
        # No workspace folder. The application opens one folder at a time and
        # can have none at all, and a server told to index a project root would
        # walk a CAD directory full of STEP exports to answer a question about
        # one open buffer. Every file this asks about is one the editor has open
        # and has just sent the text of.
        "rootUri": None,
        "workspaceFolders": None,
        "capabilities": {
            "workspace": {"configuration": True},
            "textDocument": {
                "synchronization": {"didSave": False},
                # No snippets: an insertText carrying ${1:...} placeholders
                # would be inserted literally by a client that cannot expand
                # them, and this one cannot.
                "completion": {"completionItem": {"snippetSupport": False,
                                                  "documentationFormat": ["plaintext"]}},
                "signatureHelp": {
                    "signatureInformation": {
                        "documentationFormat": ["plaintext"],
                        # Lets the server say which parameter is current per
                        # signature rather than only per reply.
                        "parameterInformation": {"labelOffsetSupport": False},
                        "activeParameterSupport": True,
                    },
                },
            },
        },
    }


def _items_of(result):
    """The items out of a CompletionList, or a bare list, or neither."""
    if isinstance(result, dict):
        items = result.get("items")
        return list(items) if isinstance(items, list) else None
    if isinstance(result, list):
        return list(result)
    return None


def _word_start(line_text, column):
    """Where the identifier being typed begins, as a line-relative offset.

    Pyright returns its items without a textEdit and leaves the range to the
    client, which is ordinary for LSP: the server says what could go here, and
    where it goes is a property of the text the client is holding. So this is
    computed rather than read, and it is the one number in this file that would
    silently corrupt a buffer if it were wrong - a completion of "pa" in "bd.pa"
    whose span began at the wrong character gives "bpart" or "bd.papart", and
    nothing says so until somebody reads their own file back.

    Identifier characters only, so the dot in "bd.pa" ends the run and "pa" is
    what gets replaced.
    """
    start = min(column, len(line_text))
    while start > 0 and (line_text[start - 1].isalnum() or line_text[start - 1] == "_"):
        start -= 1
    return start


def _replacement(item, line_text, column):
    """Which characters of the line a match replaces.

    The server's textEdit where there is one - it knows better than any rule
    here - and the word under the cursor where there is not. Line-relative,
    matching what the kernel returns for its own matches, so the frontend has
    one rule for both.
    """
    edit = item.get("textEdit")
    if isinstance(edit, dict):
        span = edit.get("range") or edit.get("replace") or edit.get("insert")
        if isinstance(span, dict):
            start = span.get("start", {}).get("character")
            end = span.get("end", {}).get("character")
            if isinstance(start, int) and isinstance(end, int):
                return start, end
    return _word_start(line_text, column), column


def _hover_text(contents):
    """Flatten LSP's three shapes for hover contents into one string.

    MarkupContent ({kind, value}), a marked string (plain, or {language, value}
    which is a code block), or a list of either. A server may answer with any of
    them and this one has been seen to change shape between requests, so all
    three are handled rather than the one that turned up first.
    """
    if isinstance(contents, list):
        parts = [_hover_text(item) for item in contents]
        return "\n\n".join(part for part in parts if part != "")
    if isinstance(contents, str):
        return contents.strip()
    if isinstance(contents, dict):
        value = contents.get("value")
        if not isinstance(value, str):
            return ""
        language = contents.get("language")
        if isinstance(language, str) and language != "":
            # A {language, value} pair is code, and arrives without the fence
            # that would make Monaco render it as code.
            return f"```{language}\n{value.strip()}\n```"
        return value.strip()
    return ""


def _summary(documentation):
    """The first paragraph of a docstring, and no more.

    The parameter hints popup sits over the code being written. build123d's
    docstrings run to a paragraph per argument, and a popup that long covers the
    thing it is describing.
    """
    if isinstance(documentation, dict):
        documentation = documentation.get("value")
    if not isinstance(documentation, str) or documentation == "":
        return ""
    paragraph = documentation.strip().split("\n\n", 1)[0]
    return " ".join(paragraph.split())
