// Import the editor core and just the Python grammar, not the "monaco-editor"
// barrel. The barrel registers every bundled language, which drags in the
// TypeScript, CSS, HTML and JSON language services and their web workers -
// about 9 MB of assets for an editor that only ever shows Python.
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/python/register.js";
// The context menu, and the Cut/Copy/Paste entries that fill it.
//
// editor.api.js is the API and nothing else: every *contribution* - the menu,
// the find widget, folding - is a separate import, and editor.main.js is what
// pulls all of them in along with the languages this editor cannot use. Taking
// the two that are wanted costs none of that.
//
// Without them the editor had no context menu of its own, so a right-click fell
// through to the webview's - which selects the word under the pointer, discards
// the selection the user had made, and offers a Reload that discards the buffer.
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
// The suggestion widget, and the Ctrl-Space that opens it.
//
// registerCompletionItemProvider is part of editor.api.js and registering one
// without this succeeds silently - the provider is simply never asked, because
// nothing is asking. That is worth stating plainly: before this import the
// editor had no completion of any kind, not even the word-based suggestions the
// worker has always computed, because the only thing that displays them was
// never bundled. Same trap as the context menu, which is why that one is here.
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
// The parameter hints popup, which is a separate contribution again -
// registerSignatureHelpProvider is in the API and the widget that shows what it
// returns is not.
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
// Not the "monaco-editor/esm/vs/editor/editor.worker" path that most guides
// still show: as of 0.56 the exports map is {"./*": "./esm/vs/*.js"}, so the
// esm/vs prefix is added for us and spelling it out resolves to esm/vs/esm/vs.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

import { cellAt, findCells, nextCell } from "./cells.js";
import { completionItems, completionQuery, isIncomplete } from "./completion.js";
import { signatureHelp } from "./signature.js";
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
export function openBuffer({ path = null, text = "", caret = null }) {
  const key = buffers.open({ path, text, caret });
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
    buffers.setCaret(outgoing, getViewState());
  }
  clearCellDecorations();

  const buffer = buffers.get(key);
  buffers.activate(key);
  editor.setModel(buffer.model);
  const state = buffers.viewState(key);
  if (state !== null) {
    editor.restoreViewState(state);
  } else {
    // Never shown in this session, so there is no Monaco view state - only the
    // line and column carried over from the last one, if this tab was restored.
    placeCaret(buffers.caret(key));
  }
  refreshCellDecorations();
  notifyDirtyChanged();
}

/**
 * Show no buffer at all, which is what closing the last tab leaves behind.
 *
 * A decided behaviour rather than a fallback: an editor with no tab shows
 * nothing, instead of a phantom empty buffer that can be typed into, asks to be
 * saved, and belongs to no file. Everything that reads the buffer already
 * handles the model being null, because the editor starts that way too.
 */
export function showNoBuffer() {
  const outgoing = buffers.activeKeyOf();
  if (outgoing !== null && currentModel() !== null) {
    buffers.setViewState(outgoing, editor.saveViewState());
    buffers.setCaret(outgoing, getViewState());
  }
  clearCellDecorations();
  buffers.deactivate();
  editor.setModel(null);
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

/** Which buffer the editor is showing, or null. */
export function activeBufferKey() {
  return buffers.activeKeyOf();
}

/** The path of any buffer, not only the one on screen. */
export function bufferPath(key) {
  const buffer = buffers.get(key);
  return buffer === null ? null : buffer.path;
}

/** Whether any buffer differs from disk, not only the one on screen. */
export function isBufferDirty(key) {
  return buffers.isDirty(key);
}

/** Where a tab was left, for writing into the workspace at quit. */
export function bufferCaret(key) {
  return buffers.caret(key);
}

/**
 * Bring the buffer on screen's caret up to date.
 *
 * Every other tab recorded its position when it was switched away from; the one
 * being looked at has not been switched away from yet, and at quit there is no
 * later moment to do it in.
 */
export function captureActiveCaret() {
  const key = buffers.activeKeyOf();
  if (key !== null) {
    buffers.setCaret(key, getViewState());
  }
}

/** The buffer already showing a path, so opening it again focuses its tab. */
export function bufferForPath(path) {
  return buffers.findByPath(path);
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

// Whether a deferred check is already booked, so a burst of typing costs one.
let dirtyCheckPending = false;

/**
 * Ask again on the next tick whether the buffer differs from disk.
 *
 * Deferred, and that is the whole point. Asked from inside the content-change
 * event, an undo that lands exactly back on the saved version still reported
 * itself dirty: the alternative version id the answer depends on had not
 * settled while the event was being delivered, so the transition from dirty to
 * clean was never seen and both the tab's dot and the title's bullet stayed on
 * a buffer that matched disk. Closing it then asked nothing, which is what
 * proved the id itself was right and the timing was not.
 *
 * Waiting a tick rather than reading Monaco's internals to find out exactly
 * when it is assigned: the id is certainly settled by the time anything else
 * runs, and that is all this needs to be true.
 *
 * Coalesced, so holding a key down schedules one check rather than one per
 * character - which is cheaper than what it replaces, not merely as cheap.
 */
function scheduleDirtyCheck() {
  if (dirtyCheckPending) {
    return;
  }
  dirtyCheckPending = true;
  setTimeout(() => {
    dirtyCheckPending = false;
    notifyDirtyChanged();
  }, 0);
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
function placeCaret(state) {
  const model = currentModel();
  if (model === null) {
    return;
  }
  let line = 1;
  let column = 1;
  let exact = false;

  if (state !== null && state !== undefined && Number.isFinite(state.line)) {
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
}

export function focusAt(state = null) {
  if (currentModel() === null) {
    // No file open, so there is no caret to place. Focus still belongs here:
    // the editor pane is where typing should go the moment one is opened.
    editor.focus();
    return;
  }
  placeCaret(state);
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

  // Give Cut, Copy and Paste their chords back, so the context menu shows them
  // beside the items the way it shows Shift-Enter beside Run Cell.
  //
  // Monaco registers those three actions with no keybinding unless it believes
  // it is running natively, on the reasoning that in a browser the chords belong
  // to the browser - true, and it means the menu has nothing to display. The
  // action still exists and still works; only the label was missing. CtrlCmd is
  // Cmd on macOS and Ctrl elsewhere, which is exactly right for the clipboard
  // and is the one place that mapping needs no thought - see keys.js for the
  // places it does.
  monaco.editor.addKeybindingRules([
    { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, command: "editor.action.clipboardCutAction" },
    { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, command: "editor.action.clipboardCopyAction" },
    { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, command: "editor.action.clipboardPasteAction" },
  ]);

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
    scheduleDirtyCheck();
  });

  registerRunActions(editor);
  registerLanguageFeatures();
  return editor;
}

// How long the frontend waits for an answer. Longer than anything the sidecar
// will take, so this is a backstop against a reply that never comes at all
// rather than a second opinion about how long is too long - that judgement is
// made once, where the work happens.
const LANGUAGE_TIMEOUT = 6000;

/**
 * Route Monaco's completion and signature requests to the sidecar.
 *
 * Registered against the language rather than the editor, so both cover every
 * buffer - each model is created as Python - and need no re-registration when
 * tabs change.
 *
 * The whole buffer is sent, and its path when it has one. jedi needs the
 * imports and the assignments above the cursor to infer anything; the sidecar
 * takes the single line out of it for the kernel. Sending the file is what this
 * costs, and it is a local socket - a 400-line file measured the same as a
 * six-line one end to end.
 *
 * The cancellation token is honoured on the way back rather than on the way
 * out. The request has gone by then and the sidecar answers it either way; what
 * this avoids is handing Monaco a list for a cursor position it has already
 * left behind.
 */
function registerLanguageFeatures() {
  monaco.languages.registerCompletionItemProvider("python", {
    // Monaco asks on word characters by itself; the dot is the case that has to
    // be declared, because "part." is not a word and without it the most useful
    // completion in this application needs Ctrl-Space every time.
    triggerCharacters: ["."],
    provideCompletionItems: async (model, position, _context, token) => {
      const reply = await ipc.request(
        "editor.complete",
        completionQuery(model.getValue(), position, bufferPath(buffers.activeKeyOf())),
        { timeout: LANGUAGE_TIMEOUT },
      );
      if (token.isCancellationRequested) {
        return { suggestions: [] };
      }
      // The word under the cursor is carried along as the fallback span, for an
      // entry that arrives without one. Monaco is the only thing that can say
      // where it begins, and it can only be asked here.
      const word = model.getWordUntilPosition(position);
      const where = { ...position, wordStartColumn: word.startColumn };
      return {
        suggestions: completionItems(reply, where, monaco.languages.CompletionItemKind),
        incomplete: isIncomplete(reply),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider("python", {
    // "(" opens the popup and "," moves it on to the next parameter. Both are
    // retriggers rather than one, because Monaco asks again on the comma only
    // if it is listed.
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    provideSignatureHelp: async (model, position, token) => {
      const reply = await ipc.request(
        "editor.signature",
        completionQuery(model.getValue(), position, bufferPath(buffers.activeKeyOf())),
        { timeout: LANGUAGE_TIMEOUT },
      );
      const help = token.isCancellationRequested ? null : signatureHelp(reply);
      if (help === null) {
        return null;
      }
      // Monaco disposes the help when the popup closes, and a provider that
      // returns none is a leak in its bookkeeping rather than in ours.
      return { value: help, dispose: () => {} };
    },
  });
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
 * leaving both the old and the new chord live. Group 5's dialog is what will
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
  for (const [index, { id, run }] of actions.entries()) {
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
      // In the context menu too, above Cut/Copy/Paste - Monaco's clipboard
      // group is "9_cutcopypaste", and groups sort by name. Running code is
      // what this editor is for, and the menu that only offers to copy it
      // would be a menu for some other application.
      contextMenuGroupId: "1_run",
      contextMenuOrder: index,
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
