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
import * as buffers from "./buffers.js";
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
# Shift+Enter runs the cell at the cursor and moves on, Ctrl+Enter runs it and
# stays, Ctrl+Shift+Enter runs the selection or the current line, and F5 runs
# the whole file. Output appears in the console below as In [n]:, and the
# kernel is shared with it - so you can poke at "part" down there straight
# after running this.
part.bounding_box()
`;

let editor = null;

/**
 * The model the editor is showing, or null when it is showing none.
 *
 * There genuinely is such a moment: the editor is created before startup knows
 * what to put in it, and once tabs can be closed there is no file open after the
 * last one goes. Everything that reads the buffer goes through here rather than
 * assuming, because Monaco's getValue, getPosition and getSelection all reach
 * through the model and throw or return null when there is not one.
 */
function currentModel() {
  return editor === null ? null : editor.getModel();
}

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
  if (currentModel() === null) {
    return;
  }
  execute(editor.getValue());
}

export function runCell({ advance = true } = {}) {
  if (currentModel() === null) {
    return;
  }
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
  const model = currentModel();
  if (model === null) {
    return;
  }
  const selection = editor.getSelection();

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

// The cell-boundary highlights for whichever model is attached. Decorations
// belong to a model, so this is cleared before the editor is pointed at another
// one and rebuilt afterwards rather than carried across.
let decorations = null;

/**
 * Drop the highlights, which must happen while their own model is still attached.
 *
 * A decoration belongs to a model rather than to the editor, so a collection
 * left standing across a setModel is holding ids that mean nothing in the new
 * document - and the old model is about to be disposed with them still on it.
 */
function clearCellDecorations() {
  if (decorations !== null) {
    decorations.clear();
    decorations = null;
  }
}

/** Highlight cell boundaries so the run-cell target is obvious. */
function refreshCellDecorations() {
  clearCellDecorations();
  if (currentModel() === null) {
    return;
  }
  const cells = findCells(editor.getValue());
  decorations = editor.createDecorationsCollection(
    cells
      // Every line the author actually wrote "# %%" on, including the first line
      // of the file. This used to be `startLine > 1`, which meant a file opening
      // with a marker had no highlight on it - and the test could not tell that
      // apart from a plain script, whose first line findCells also reports as a
      // cell start and which must *not* be decorated. See cells.js: `marked` is
      // the distinction that line number cannot make.
      .filter((cell) => cell.marked)
      .map((cell) => {
        const options = { isWholeLine: true, className: "cell-marker-line" };
        // The margin rule is a top border, and its job is to divide this cell
        // from the one above. Line 1 has nothing above it to divide.
        if (cell.startLine > 1) {
          options.marginClassName = "cell-marker-margin";
        }
        return {
          range: new monaco.Range(cell.startLine, 1, cell.startLine, 1),
          options,
        };
      }),
  );
}

export function getValue() {
  return currentModel() === null ? "" : editor.getValue();
}

/**
 * Open text as a buffer of its own and show it.
 *
 * One model per file rather than one model reused for all of them, which is what
 * setValue used to do. That was not only a step towards tabs: pouring a second
 * file into the first one's model carried the first one's *undo history* with
 * it, so Cmd-Z in a freshly opened file could put back a line belonging to a
 * file that was no longer on screen.
 */
export function openBuffer({ path = null, text = "" }) {
  const key = buffers.open({ path, text });
  showBuffer(key);
  return key;
}

/**
 * Point the editor at a buffer, putting the caret back where it was left.
 *
 * The outgoing buffer's view state is saved first, because the whole reason to
 * keep one per buffer is that coming back to a file lands where it was left
 * rather than at line 1.
 */
export function showBuffer(key) {
  const outgoing = buffers.activeKeyOf();
  if (outgoing !== null && currentModel() !== null) {
    buffers.setViewState(outgoing, editor.saveViewState());
  }
  clearCellDecorations();

  const buffer = buffers.get(key);
  buffers.activate(key);
  editor.setModel(buffer.model);
  const state = buffers.viewState(key);
  if (state !== null) {
    editor.restoreViewState(state);
  }
  refreshCellDecorations();
  notifyDirtyChanged();
}

/** Close a buffer. The caller must show another one first, or none. */
export function closeBuffer(key) {
  return buffers.close(key);
}

/** The keys of every open buffer, in the order they were opened. */
export function bufferKeys() {
  return buffers.keys();
}

/** Record the buffer as matching disk - after a load or a successful save. */
export function markSaved() {
  const key = buffers.activeKeyOf();
  if (key === null) {
    return;
  }
  buffers.markSaved(key);
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

/** True when the buffer on screen has edits that are not on disk. */
export function isDirty() {
  const key = buffers.activeKeyOf();
  return key === null ? false : buffers.isDirty(key);
}

/** The path of the buffer on screen: null for one that has never been saved. */
export function getCurrentFile() {
  const buffer = buffers.active();
  return buffer === null ? null : buffer.path;
}

/** After a Save As: the same buffer, under a new name. */
export function setCurrentFile(path) {
  const key = buffers.activeKeyOf();
  if (key === null) {
    return;
  }
  buffers.setPath(key, path);
}

export function focus() {
  editor.focus();
}

/** Caret and viewport, for remembering where the user was, or null with no file open. */
export function getViewState() {
  if (currentModel() === null) {
    // Null rather than line 1: there is no caret, and a made-up one would be
    // written to settings and restored next time as though it meant something.
    return null;
  }
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
  const model = currentModel();
  if (model === null) {
    // No file open, so there is no caret to place. Focus still belongs here:
    // the editor pane is where typing should go the moment one is opened.
    editor.focus();
    return;
  }
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
  // Every buffer's model is made here, so that buffers.js can stay free of
  // monaco and be tested without a window.
  buffers.initBuffers({
    create: (text) => monaco.editor.createModel(text, "python"),
    dispose: (model) => model.dispose(),
    versionOf: (model) => model.getAlternativeVersionId(),
  });

  editor = monaco.editor.create(document.getElementById("editor-host"), {
    // No model, rather than an empty one Monaco would create for us and nothing
    // would ever own: restoreLastFile decides what the first buffer is - the
    // reopened file, the sample on a first run, or an empty one - and opening it
    // is what gives the editor a model.
    model: null,
    // No "language" here: that option only ever described the model Monaco
    // creates when it is not given one, and it is not given one. Every buffer's
    // model is created as Python above.
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

  onThemeChange((theme) => monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark"));

  // Bound to the editor rather than to a model, so it follows whichever buffer
  // is on screen and survives every switch between them.
  editor.onDidChangeModelContent(() => {
    refreshCellDecorations();
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

/** Whether the caret is in the editor, for routing clipboard commands. */
export function hasTextFocus() {
  return editor !== null && editor !== undefined && editor.hasTextFocus();
}

/** The selected text, or "" when nothing is selected. */
export function selectedText() {
  const selection = editor.getSelection();
  if (selection === null || selection.isEmpty()) {
    return "";
  }
  return editor.getModel().getValueInRange(selection);
}

/**
 * Replace the selection, or insert at the caret when there is none.
 *
 * Through executeEdits rather than setValue, so that undo, the dirty flag and
 * the cell decorations all behave exactly as they do for typing - a paste that
 * could not be undone would be a surprise nobody asked for.
 */
export function replaceSelection(text) {
  const selection = editor.getSelection();
  if (selection === null) {
    // No file open: there is nowhere for a paste to land.
    return;
  }
  editor.executeEdits("clipboard", [{ range: selection, text, forceMoveMarkers: true }]);
  editor.focus();
}
