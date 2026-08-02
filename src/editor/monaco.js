// Import the editor core and just the Python grammar, not the "monaco-editor"
// barrel. The barrel registers every bundled language, which drags in the
// TypeScript, CSS, HTML and JSON language services and their web workers -
// about 9 MB of assets for an editor that only ever shows Python.
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/python/register.js";
// Not the "monaco-editor/esm/vs/editor/editor.worker" path that most guides
// still show: as of 0.56 the exports map is {"./*": "./esm/vs/*.js"}, so the
// esm/vs prefix is added for us and spelling it out resolves to esm/vs/esm/vs.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

import { cellAt, findCells, nextCell } from "./cells.js";
import { COMMANDS } from "../keys.js";
import { bindingsFor } from "../keybindings.js";
import * as ipc from "../ipc.js";
import * as log from "../log.js";
import { onThemeChange, resolvedTheme } from "../theme.js";

// Monaco needs a worker to do anything non-trivial off the main thread. Python
// has no dedicated language service in monaco-editor, so the generic editor
// worker is the only one required - which is also why the bundle stays small.
self.MonacoEnvironment = {
  getWorker() {
    // The worker is what computes word-based suggestions, so when it fails to
    // start the editor loses completion and says nothing about why. Monaco
    // reports that on the console, which this application does not have. Both
    // ends are logged: that one was asked for, and that it failed if it did.
    const worker = new EditorWorker();
    worker.addEventListener("error", (event) => {
      log.error("Monaco editor worker failed:", event.message ?? String(event));
    });
    log.info("Monaco editor worker started");
    return worker;
  },
};

/**
 * The jump start, shown once: on the very first run and never again.
 *
 * Exported because whether it belongs in the buffer is a startup decision, not
 * an editor one - see restoreLastFile. The editor itself opens empty.
 */
export const SAMPLE_SOURCE = `# %%
from build123d import *
from build123d_studio import show

# %%
part = Box(10, 10, 10) - Cylinder(3, 12)
show(part)
print(f"volume = {part.volume:.3f}")

# %%
# Ctrl/Cmd+Enter runs the cell at the cursor, Shift+Enter the selection or
# current line, Ctrl/Cmd+Shift+Enter the whole file. Output appears in the
# console below as In [n]:, and the kernel is shared with it - so you can
# poke at "part" down there straight after running this.
part.bounding_box()
`;

let editor = null;
let currentFile = null;

/** Send code to the kernel. It is echoed into the console pane as In [n]:. */
function execute(code) {
  if (code.trim() === "") {
    return;
  }
  if (!ipc.isConnected()) {
    log.warn("Cannot run: the sidecar is not connected");
    return;
  }
  log.info(`Run: sending ${code.length} chars to the kernel`);
  ipc.send("kernel.execute", { code });
}

export function runFile() {
  execute(editor.getValue());
}

export function runCell({ advance = true } = {}) {
  const source = editor.getValue();
  const position = editor.getPosition();
  const cell = cellAt(source, position.lineNumber);
  if (cell === null) {
    return;
  }
  execute(cell.code);

  if (!advance) {
    return;
  }
  const next = nextCell(source, cell);
  if (next !== null) {
    // Land on the first line of code, not on the "# %%" marker itself.
    const target = Math.min(next.startLine + 1, next.endLine);
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(target);
  }
}

export function runSelectionOrLine({ advance = true } = {}) {
  const selection = editor.getSelection();
  const model = editor.getModel();

  if (selection !== null && !selection.isEmpty()) {
    execute(model.getValueInRange(selection));
    if (advance) {
      // To the end of what was just run, and deselected. Leaving the selection
      // standing means the next press runs the same text again, which is the
      // opposite of what "advance" means everywhere else here.
      editor.setPosition({
        lineNumber: selection.endLineNumber,
        column: selection.endColumn,
      });
      editor.revealLineInCenterIfOutsideViewport(selection.endLineNumber);
    }
    return;
  }

  const line = selection.positionLineNumber;
  execute(model.getLineContent(line));

  if (advance && line < model.getLineCount()) {
    editor.setPosition({ lineNumber: line + 1, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(line + 1);
  }
}

/** Highlight cell boundaries so the run-cell target is obvious. */
function decorateCells() {
  const cells = findCells(editor.getValue());
  const decorations = cells
    .filter((cell) => cell.startLine > 1)
    .map((cell) => ({
      range: new monaco.Range(cell.startLine, 1, cell.startLine, 1),
      options: {
        isWholeLine: true,
        className: "cell-marker-line",
        marginClassName: "cell-marker-margin",
      },
    }));
  return editor.createDecorationsCollection(decorations);
}

export function getValue() {
  return editor.getValue();
}

// Version id of the buffer as last written to or read from disk.
//
// Monaco's alternative version id is the right thing to compare, rather than
// the text: it moves with every edit but comes *back* to an earlier value when
// those edits are undone. So typing a line and undoing it leaves the buffer
// clean, which matches what the user believes, whereas comparing strings would
// also be correct here but means keeping a whole copy of the file around.
let savedVersionId = null;

export function setValue(text, fileName = null) {
  editor.setValue(text);
  currentFile = fileName;
  markSaved();
}

/** Record the buffer as matching disk - after a load or a successful save. */
export function markSaved() {
  savedVersionId = editor.getModel().getAlternativeVersionId();
  notifyDirtyChanged();
}

// Whether the buffer matches disk is the one piece of editor state the rest of
// the application has to react to rather than poll, because the window title
// carries it. Kept as a transition rather than an event per keystroke: setting
// the title is a round trip to the native side, and a user typing a paragraph
// would otherwise make several hundred of them to say the same thing.
const dirtyListeners = new Set();
let lastNotifiedDirty = false;

function notifyDirtyChanged() {
  const dirty = isDirty();
  if (dirty === lastNotifiedDirty) {
    return;
  }
  lastNotifiedDirty = dirty;
  for (const listener of dirtyListeners) {
    listener(dirty);
  }
}

/** Be told when the buffer starts or stops differing from disk. */
export function onDirtyChange(listener) {
  dirtyListeners.add(listener);
}

/** True when the buffer has edits that are not on disk. */
export function isDirty() {
  if (editor === null || savedVersionId === null) {
    return false;
  }
  return editor.getModel().getAlternativeVersionId() !== savedVersionId;
}

export function getCurrentFile() {
  return currentFile;
}

export function setCurrentFile(path) {
  currentFile = path;
}

export function focus() {
  editor.focus();
}

/** Caret and viewport, for remembering where the user was. */
export function getViewState() {
  const position = editor.getPosition();
  return {
    line: position.lineNumber,
    column: position.column,
    scrollTop: editor.getScrollTop(),
  };
}

/**
 * Focus the editor, at a remembered position when there is one.
 *
 * The stored position is never trusted as-is. Only the path is remembered
 * between sessions, so the file may have been edited elsewhere and be shorter
 * than it was - line 380 of a file that now has 120 lines has to land
 * somewhere sensible rather than throw or scroll into nothing. It is clamped to
 * the model, and if clamping actually moved it the stored scroll offset is
 * discarded too, because it described a document that no longer exists.
 *
 * @param {{line: number, column: number, scrollTop: number}|null} state
 */
export function focusAt(state = null) {
  const model = editor.getModel();
  let line = 1;
  let column = 1;
  let exact = false;

  if (state !== null && Number.isFinite(state.line)) {
    line = Math.min(Math.max(1, Math.trunc(state.line)), model.getLineCount());
    const maxColumn = model.getLineMaxColumn(line);
    column = Math.min(Math.max(1, Math.trunc(state.column ?? 1)), maxColumn);
    exact = line === Math.trunc(state.line);
  }

  editor.setPosition({ lineNumber: line, column });
  if (exact && Number.isFinite(state.scrollTop) && state.scrollTop >= 0) {
    editor.setScrollTop(state.scrollTop);
  } else {
    editor.revealLineInCenterIfOutsideViewport(line);
  }
  editor.focus();
}

export function initEditor() {
  editor = monaco.editor.create(document.getElementById("editor-host"), {
    // Empty: restoreLastFile decides what belongs here - the reopened file, the
    // sample on a first run, or nothing.
    value: "",
    language: "python",
    theme: resolvedTheme() === "light" ? "vs" : "vs-dark",
    automaticLayout: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    tabSize: 4,
    insertSpaces: true,
    rulers: [88],
  });

  // The sample the editor opens with counts as clean: quitting without having
  // touched it should not ask about saving something the user never wrote.
  markSaved();

  onThemeChange((theme) => monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark"));

  let decorations = decorateCells();
  editor.onDidChangeModelContent(() => {
    decorations.clear();
    decorations = decorateCells();
    notifyDirtyChanged();
  });

  registerRunActions(editor);
  return editor;
}

/**
 * Bind the run commands from the keymap rather than from literals here.
 *
 * The chords are Jupyter's where Jupyter has an opinion - Shift-Enter runs the
 * cell and advances, Ctrl-Enter runs it and stays - but which chord each command
 * answers to is settings.json's business, not this file's. See keys.js: the
 * modifier names do not mean what they look like, and getting that wrong is
 * silent, so it is decided in one tested place instead of at four call sites.
 *
 * Returns the disposables, so a later binding change can re-register rather than
 * leaving both the old and the new chord live. Group 4's dialog is what will
 * call it a second time.
 */
export function registerRunActions(target) {
  const actions = [
    { id: "run.cell", run: () => runCell() },
    { id: "run.cell.stay", run: () => runCell({ advance: false }) },
    { id: "run.selectionOrLine", run: () => runSelectionOrLine() },
    { id: "run.file", run: runFile },
  ];

  const registered = [];
  for (const { id, run } of actions) {
    const command = COMMANDS.find((candidate) => candidate.id === id);
    if (command === undefined) {
      // An id here that keys.js does not define is a bug, but losing one
      // shortcut is a great deal better than throwing out of editor creation
      // and taking the whole window with it.
      log.error(`No keymap entry for ${id}; that command will have no shortcut`);
      continue;
    }
    registered.push(target.addAction({
      id: `build123d-studio.${id}`,
      label: command.label,
      keybindings: bindingsFor(monaco, id),
      run,
    }));
  }
  return registered;
}
