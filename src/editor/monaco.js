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
// The hover tooltip. Same rule again: registerHoverProvider is in the API and
// the thing that draws what it returns is not.
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
// The command palette, on F1, which is the chord this contribution binds for
// itself. Nothing here registers it and nothing here needs to: every action
// added below through addAction carries a label, so the five run chords and the
// seven debug ones are all findable by name the moment the palette exists.
//
// It is the same trap one more time - there is no palette API to call and no
// error to see, only an import that was missing - and the answer to "why does
// nothing open" was that this line was not here. 6 kB gzipped, measured.
import "monaco-editor/features/quickCommand/register.js";
// And everything below is the rest of what an editor is expected to do.
//
// The palette is what made their absence obvious - it lists every registered
// action, and there were almost none, because a contribution that is not
// imported registers nothing. There was no Find, no Replace, no comment toggle
// and no way to move a line, in an editor people write Python in all day.
//
// Named one at a time rather than through "monaco-editor/features/register.all
// .js", for three reasons. That bundle also brings the diff editor, the iPad
// keyboard and the experimental GPU renderer, none of which this application
// has any use for. It does *not* bring the suggestion widget - it registers
// suggestInlineCompletions and not suggestController - so it would silently
// undo the fix above. And a list read one line at a time is a list somebody can
// argue with, which is the point of writing down what is deliberately absent:
// toggleHighContrast, because this application chooses the editor's theme in
// theme.js and a command that swaps it underneath would leave the two
// disagreeing; and inspectTokens, which is a developer tool and would sit in a
// user's palette offering to explain their own file's tokens to them.
//
// Find and replace, and moving around what is found.
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js";
// Editing text, which is most of what the list above was missing.
import "monaco-editor/editor/contrib/comment/browser/comment.js";
// The buttons above each "# %%" marker. Without this the code lens provider
// registers happily and is never called - the same trap this file's header
// names, and the reason every contribution here is imported explicitly.
import "monaco-editor/editor/contrib/codelens/browser/codelensController.js";
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js";
import "monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
// Choosing what to edit.
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
// Reading a long file. Folding also earns back the sixteen pixels the gutter
// has been reserving for it all along - the layout allows for a folding column
// whether or not anything can draw one, so until now that space was blank.
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js";
// Things that only ever speak up when something is wrong with the file itself.
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
// Not the "monaco-editor/esm/vs/editor/editor.worker" path that most guides
// still show: as of 0.56 the exports map is {"./*": "./esm/vs/*.js"}, so the
// esm/vs prefix is added for us and spelling it out resolves to esm/vs/esm/vs.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

import {
  cellAt,
  cellStartingAt,
  codeAbove,
  codeFrom,
  findCells,
  nextCell,
  previousCell,
} from "./cells.js";
import { completionItems, completionQuery, isIncomplete } from "./completion.js";
import { snippetCompletions } from "./snippets.js";
import { markersFor } from "./diagnostics.js";
import { formatEdits } from "./format.js";
import { showConsolePanel } from "../debug/console.js";
import { cellActionsShown } from "./cellactions.js";
import { formatLineLength } from "./formatting.js";
import { hoverContents } from "./hover.js";
import { signatureHelp } from "./signature.js";
import * as breakpoints from "../debug/breakpoints.js";
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

// What Shift-F5 calls. Injected rather than imported: the handler saves the
// buffer and starts a session, and both of those reach back into this module -
// so importing it here would be a cycle. Same arrangement as buffers.js, which
// is handed its model operations for the same reason.
let debugRequested = () => {};

let debugStep = () => {};

// And what Ctrl-F5 calls, injected for exactly the same reason: running the
// file saves the buffer first, which reaches back into this module.
let runFileOnDisk = () => {};

/** Tell the editor what its debug chords should do. Called once, at startup. */
export function setDebugHandler(handler, step) {
  debugRequested = handler;
  debugStep = step;
}

/** Tell the editor what Ctrl-F5 should do. Called once, at startup. */
export function setRunFileHandler(handler) {
  runFileOnDisk = handler;
}

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
  // Whatever this prints lands in the console, so the console is what to look
  // at. Without this a run after a debug session would put its output behind
  // whichever tab happened to be showing, which is the same disappearing act
  // the tabs were introduced to end.
  showConsolePanel("console");
  ipc.send("kernel.execute", { code });
}

/**
 * Every cell, on the kernel, from the buffer on screen.
 *
 * Named "all" rather than "file" because it never touches a file: the text goes
 * to the kernel as one execute, its names stay in the namespace the console
 * shares, and an unsaved buffer runs exactly as it reads. Run File - Ctrl-F5 -
 * is the other thing, and the two were one word for far too long.
 */
export function runAll() {
  if (currentModel() === null) {
    return;
  }
  execute(editor.getValue());
}

/**
 * The cell a marker-line command is about.
 *
 * A line when a button above a marker was clicked, and the caret's cell when
 * the command came from the menu or a chord. Taking the line rather than always
 * reading the caret is what makes the buttons correct: clicking "All Above" on
 * the third marker while typing in the first must act on the third, and by the
 * time the click arrives the caret has not moved.
 */
function cellFor(source, line) {
  if (typeof line === "number") {
    return cellStartingAt(source, line);
  }
  const position = editor.getPosition();
  return position === null ? null : cellAt(source, position.lineNumber);
}

/**
 * Run the cell above this one, and put the caret in this one.
 *
 * The caret moves because the button's whole purpose is "I have just written
 * this cell, run what it needs first" - leaving the caret behind in the cell
 * that was run would put the next Shift-Enter in the wrong place.
 */
export function runCellAbove(line) {
  if (currentModel() === null) {
    return;
  }
  const source = editor.getValue();
  const cell = cellFor(source, line);
  if (cell === null) {
    return;
  }
  const above = previousCell(source, cell);
  if (above === null) {
    return;
  }
  execute(above.code);
  const target = Math.min(cell.startLine + 1, cell.endLine);
  editor.setPosition({ lineNumber: target, column: 1 });
}

/** Everything from the top of the file down to this marker, exclusive. */
export function runAllAbove(line) {
  if (currentModel() === null) {
    return;
  }
  const source = editor.getValue();
  const cell = cellFor(source, line);
  if (cell === null) {
    return;
  }
  execute(codeAbove(source, cell.startLine));
}

/** This marker and everything after it, to the end of the file. */
export function runAllBelow(line) {
  if (currentModel() === null) {
    return;
  }
  const source = editor.getValue();
  const cell = cellFor(source, line);
  if (cell === null) {
    return;
  }
  execute(codeFrom(source, cell.startLine));
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

// The breakpoint marks for whichever model is attached, and the line execution
// is stopped on. Both belong to a model rather than to the editor, so both are
// cleared before the editor is pointed at another one - see clearCellDecorations
// for what a collection left across a setModel is holding.
let breakpointDecorations = null;
let stoppedDecorations = null;

/**
 * Draw the marks for the buffer on screen.
 *
 * Read from breakpoints.js rather than from the collection, because this is
 * also what runs after a tab switch, when the collection belongs to the model
 * that has just gone.
 */
function refreshBreakpointDecorations() {
  if (breakpointDecorations !== null) {
    breakpointDecorations.clear();
    breakpointDecorations = null;
  }
  const key = buffers.activeKeyOf();
  if (key === null || currentModel() === null) {
    return;
  }
  breakpointDecorations = editor.createDecorationsCollection(
    breakpoints.linesOf(key).map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: "breakpoint-glyph",
        // Kept when text is inserted at the mark's own position, so typing at
        // the start of a marked line moves the mark with the line rather than
        // leaving it behind on what is now a different statement.
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })),
  );
}

/**
 * Write back where the marks ended up after an edit.
 *
 * Monaco moves a decoration when text is inserted above it; the line numbers in
 * breakpoints.js cannot move themselves. Without this, adding a line at the top
 * of a file leaves every breakpoint pointing one line short of where it is
 * drawn - and the session would stop somewhere the user never marked.
 *
 * Two marks can be pushed onto one line by deleting the lines between them, so
 * what goes back is deduplicated; see breakpoints.replace.
 */
function adoptBreakpointPositions() {
  const key = buffers.activeKeyOf();
  if (key === null || breakpointDecorations === null) {
    return;
  }
  const before = breakpoints.linesOf(key).join(",");
  const after = breakpoints.replace(
    key,
    breakpointDecorations.getRanges().map((range) => range.startLineNumber),
  );
  // Only when they actually moved. This runs on every keystroke, and a
  // setBreakpoints request per character typed would be a request per character
  // typed.
  if (after.join(",") !== before) {
    breakpointsChanged(bufferPath(key), after);
  }
}

/** The lines marked in the buffer on screen. */
export function breakpointLines() {
  const key = buffers.activeKeyOf();
  return key === null ? [] : breakpoints.linesOf(key);
}

/**
 * Every marked file, with its lines. What a session has to be told about.
 *
 * Not just the file being debugged: a breakpoint in a module that file imports
 * is how somebody follows execution out of the script they started. Buffers
 * with no path are skipped, because there is nothing on disk for the adapter to
 * match them against.
 */
export function allBreakpoints() {
  const files = [];
  for (const key of buffers.keys()) {
    const path = bufferPath(key);
    const lines = breakpoints.linesOf(key);
    if (path !== null && lines.length > 0) {
      files.push({ path, lines });
    }
  }
  return files;
}

// Told when a mark moves, so a live session can be updated. Injected for the
// same reason the debug chord is: session.js reaches back into this module.
let breakpointsChanged = () => {};

export function setBreakpointListener(listener) {
  breakpointsChanged = listener;
}

/**
 * Show where execution is stopped, or clear it.
 *
 * Only for the file on screen: a session can stop inside a library the user has
 * no tab for, and there is nothing to highlight then. The path is compared
 * against the buffer's own, which is the same string the debugger was given.
 */
export function showStoppedLine(path, line) {
  if (stoppedDecorations !== null) {
    stoppedDecorations.clear();
    stoppedDecorations = null;
  }
  const key = buffers.activeKeyOf();
  if (key === null || currentModel() === null || path === null || line === undefined) {
    return;
  }
  if (bufferPath(key) !== path) {
    return;
  }
  stoppedDecorations = editor.createDecorationsCollection([{
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: "stopped-line",
      // No glyph. The gutter is the breakpoints' column, and a marker for the
      // stopped line covered the dot on it - which is exactly the dot somebody
      // wants to take off while going round a loop. The highlight already says
      // where execution is.
    },
  }]);
  editor.revealLineInCenterIfOutsideViewport(line);
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
export function openBuffer({ path = null, text = "", caret = null, matchesDisk = true }) {
  const key = buffers.open({ path, text, caret, matchesDisk });
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
  refreshBreakpointDecorations();
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
  // Before the model goes, because the path is read off the buffer and there is
  // nothing left to read it from afterwards.
  forgetBuffer(key, bufferPath(key));
  breakpoints.forget(key);
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

/** Whether the file a buffer names has gone from disk. */
export function isBufferMissing(key) {
  return buffers.isMissing(key);
}

/** Either edits that are not written, or no file left to have written them to. */
export function bufferNeedsSaving(key) {
  return buffers.needsSaving(key);
}

/**
 * Note which open files are no longer on disk.
 *
 * Given the paths that were checked and the ones found missing, so the caller
 * does the filesystem work and this stays a decision about buffers.
 */
export function markMissingFiles(missingPaths) {
  const gone = new Set(missingPaths);
  for (const key of buffers.keys()) {
    const path = buffers.get(key)?.path ?? null;
    if (path !== null) {
      buffers.setMissing(key, gone.has(path));
    }
  }
  notifyDirtyChanged();
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

/**
 * Put a snippet into the buffer on screen, with its tab stops live.
 *
 * The template a new file starts from is VS Code's snippet syntax: `$1` and
 * `${1:like this}` are stops the user tabs between, `${1|a,b|}` offers a choice,
 * `$0` is where the caret ends, and the `CURRENT_*`, `RANDOM` and `CLIPBOARD`
 * variables are resolved as they are there. A literal dollar is `\$`.
 *
 * SnippetController2 is a contribution rather than public API - it is not in
 * monaco's .d.ts - which is the same footing as the fifteen other contributions
 * this file imports by path. It is already imported for the suggestion widget's
 * own snippet completions.
 *
 * The editor is focused first, and that is load-bearing rather than tidiness:
 * the stops are a live selection, and a snippet inserted into an editor that
 * does not have the keyboard leaves them nowhere to be typed into.
 *
 * @returns {number|null} the version the model is on afterwards, or null if
 *   there was nothing to insert into.
 */
export function insertSnippet(text) {
  const model = currentModel();
  if (editor === null || model === null) {
    return null;
  }
  editor.focus();
  const controller = editor.getContribution("snippetController2");
  if (controller === null || controller === undefined) {
    // No contribution: put the text in as text rather than losing it.
    model.setValue(text);
    return model.getAlternativeVersionId();
  }
  controller.insert(text);

  // A template that declares no stops opens at the top, as it did when it was
  // simply the buffer's text. Inserting leaves the caret after what was
  // inserted, which for a twelve-line template scrolls the first line out of
  // sight - so the file appears to start in the middle of its own comment.
  //
  // A template that does declare one has said where the caret goes, and that
  // answer wins.
  if (!/\$\d|\$\{\d/.test(text)) {
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.revealLine(1);
  }
  return model.getAlternativeVersionId();
}

/**
 * Record a buffer as matching disk, at the version that was written.
 *
 * Keyed, and given the version, because the buffer being saved is not reliably
 * the one on screen by the time a save finishes - see saveFile.
 */
export function markSaved(key, versionId) {
  buffers.markSaved(key, versionId);
  notifyDirtyChanged();
}

/** What the file looked like when this buffer last agreed with it. */
export function setBufferStamp(key, stamp) {
  buffers.setDiskStamp(key, stamp);
}

/** The stamp recorded for a buffer. */
export function bufferStamp(key) {
  return buffers.diskStamp(key);
}

/** Replace a buffer with what is on disk; returns the version that produced. */
export function reloadBufferText(key, text) {
  const versionId = buffers.replaceText(key, text);
  notifyDirtyChanged();
  return versionId;
}

/** A buffer's text and version, read as one instant. */
export function bufferContents(key) {
  return buffers.contentsOf(key);
}

/** Whether a buffer is still open. */
export function bufferExists(key) {
  return buffers.exists(key);
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

// Told on every content change, unlike onDirtyChange, which is a transition.
// The recovery journal needs each keystroke burst rather than the moment a
// buffer first became dirty, so this fires far more often - and every listener
// is therefore required to do no work of its own beyond booking some.
const contentListeners = new Set();

function notifyContentChanged() {
  const key = buffers.activeKeyOf();
  if (key === null) {
    return;
  }
  for (const listener of contentListeners) {
    listener(key);
  }
}

/** Be told which buffer was typed into, on every change. */
export function onContentChange(listener) {
  contentListeners.add(listener);
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

/**
 * After a Save As: that buffer, under a new name.
 *
 * Keyed for the same reason markSaved is. Answers whether it took: a path
 * another buffer already holds is refused rather than duplicated.
 */
export function setCurrentFile(key, path) {
  return buffers.setPath(key, path);
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
    textOf: (model) => model.getValue(),
    // An edit, not setValue. setValue replaces the text *and throws away the
    // undo stack*, so a reload the user did not mean would be unrecoverable -
    // and a reload is offered exactly when they have unsaved work to lose.
    // pushEditOperations over the whole range is the same replacement with the
    // history kept, so Cmd-Z puts their version back.
    replaceText: (model, text) => {
      model.pushStackElement();
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text }],
        () => null,
      );
      model.pushStackElement();
    },
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
    // The strip left of the line numbers, where breakpoints live. Off by
    // default in Monaco, and a decoration asking to be drawn there is simply
    // not drawn without it - no error, no mark.
    glyphMargin: true,
    minimap: { enabled: true },
    // Flag characters that are invisible or that can be mistaken for another,
    // and say nothing about the rest. The default for nonBasicASCII is
    // "inUntrustedWorkspace", which has no meaning outside VS Code, so what it
    // resolves to here is not something to guess at - and if it resolved to
    // true, every umlaut in a German comment would be marked as a problem in a
    // file that has nothing wrong with it. The two checks worth having are the
    // ones about characters a person cannot see.
    unicodeHighlight: { nonBasicASCII: false, invisibleCharacters: true, ambiguousCharacters: true },
    scrollBeyondLastLine: false,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    // 12 rather than 13, and the gutter is why. Monaco makes the glyph margin -
    // the breakpoint strip - exactly one line height wide, and the line height
    // is fontSize x 1.5 on macOS, so the only lever on that strip is the font.
    // The digits narrow with it, so the line-number column comes in as well.
    fontSize: 12,
    // Three, not the default five. A five-character column right-aligns a
    // three-digit number and leaves two digits' worth of blank to its left -
    // which lands exactly between the breakpoint dot and the number, and reads
    // as the breakpoint strip being enormous. It grows on its own for a file
    // that needs more.
    lineNumbersMinChars: 3,
    // Ten pixels of lane between the fold controls and the text, holding
    // nothing: this is the width for *inline* decorations, and this editor
    // draws none. The breakpoint is a glyph, the cell and stopped-line
    // highlights are whole-line backgrounds, and the cell separator above a
    // marker is a margin border.
    lineDecorationsWidth: 0,
    tabSize: 4,
    insertSpaces: true,
    // The ruler is the formatter's own line length, so the line somebody is
    // looking at is the line ruff will wrap at. The setting feeds both, so the
    // agreement is caused rather than coincidental.
    rulers: [formatLineLength()],
    // The buttons above each "# %%" marker, which are a code lens.
    codeLens: cellActionsShown(),
  });

  onThemeChange((theme) => monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark"));

  // Bound to the editor rather than to a model, so it follows whichever buffer
  // is on screen and survives every switch between them.
  editor.onDidChangeModelContent(() => {
    refreshCellDecorations();
    scheduleDirtyCheck();
    // Told on every keystroke rather than on a transition, because what
    // listens is the recovery journal and it has to know the buffer moved even
    // when it was already dirty. Every listener here is on the typing path, so
    // each is required to be O(1) - see journal.js.
    notifyContentChanged();
    scheduleSync();
    // Monaco has already moved the marks; this writes back where they ended up.
    adoptBreakpointPositions();
  });

  // The glyph margin is only a strip until something listens to it.
  editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      return;
    }
    const key = buffers.activeKeyOf();
    if (key === null) {
      return;
    }
    breakpoints.toggle(key, event.target.position.lineNumber);
    refreshBreakpointDecorations();
    breakpointsChanged(bufferPath(key), breakpoints.linesOf(key));
  });

  // A buffer that has just been shown is analysed too, and this is the only
  // hook that fires for it: switching tabs changes no content, so the change
  // handler above never runs, and a file opened and never edited would have no
  // squiggles at all.
  editor.onDidChangeModel(() => scheduleSync());

  runActions = registerRunActions(editor);
  registerLanguageFeatures();
  registerCellActions();
  return editor;
}

// How long the frontend waits for an answer. Longer than anything the sidecar
// will take, so this is a backstop against a reply that never comes at all
// rather than a second opinion about how long is too long - that judgement is
// made once, where the work happens.
const LANGUAGE_TIMEOUT = 6000;

// Long enough for the formatter to finish a file nobody should be editing by
// hand: ruff measures 17 ms on six thousand lines, so this covers any file that
// will ever arrive. It is a backstop against the sidecar having gone, not a
// judgement about how long formatting ought to take.
const FORMAT_TIMEOUT = 30000;

// The user's snippets, read once at startup and whenever they say they have
// changed the file. Held here rather than read per keystroke: the provider is
// asked on every character typed, and a file read per character would put the
// filesystem in front of the suggestion list.
let userSnippets = [];

/** Replace what the snippet provider offers. */
export function setUserSnippets(snippets) {
  userSnippets = snippets;
}

/** What to ask about, for a position in whichever buffer is on screen. */
function queryFor(model, position) {
  const key = buffers.activeKeyOf();
  return completionQuery(model.getValue(), position, bufferPath(key), key);
}

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
// --- the buttons above a "# %%" marker --------------------------------------
//
// Five, in the order somebody reads them: run this cell, run the one before it,
// then the two that run everything on one side of the marker, then stop. The
// same set the Jupyter console extension for VS Code draws, because the point
// is that the reflex carries across.
//
// The commands are registered by name and referenced by name, rather than being
// closures the lens carries: a lens is data that crosses into Monaco's own
// command service, and a name is what that service understands.

const CELL_LENSES = [
  { title: "\u25b6 Cell", command: "build123dStudio.runCellHere",
    tooltip: "Run this cell and move to the next" },
  { title: "\u25b6 Cell Above", command: "build123dStudio.runCellAbove",
    tooltip: "Run the cell above and put the caret in this one" },
  { title: "\u25b6 All Below", command: "build123dStudio.runAllBelow",
    tooltip: "Run this marker and everything after it" },
  { title: "\u25b6 All Above", command: "build123dStudio.runAllAbove",
    tooltip: "Run everything above this marker" },
  { title: "\u23f9 Interrupt", command: "build123dStudio.interrupt",
    tooltip: "Interrupt what the kernel is running" },
];

// What the Interrupt lens does, handed in rather than imported: the toolbar owns
// interrupting - it is the half that offers a restart when the interrupt does
// not land - and toolbar.js already imports this file.
let interrupt = () => {};

/** Told what "interrupt" means, once, at startup. */
export function setInterrupt(handler) {
  interrupt = handler;
}

/**
 * Run the cell whose marker was clicked, and move on to the next.
 *
 * The same thing Shift-Enter does, from a marker rather than from the caret.
 */
function runCellHere(line) {
  if (currentModel() === null) {
    return;
  }
  const source = editor.getValue();
  const cell = cellFor(source, line);
  if (cell === null) {
    return;
  }
  execute(cell.code);
  const next = nextCell(source, cell);
  if (next !== null) {
    const target = Math.min(next.startLine + 1, next.endLine);
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(target);
  }
}

/**
 * Draw the buttons, and answer what they invoke.
 *
 * Only on markers the author wrote: findCells reports the text ahead of the
 * first "# %%" as a cell of its own, and putting five buttons above line 1 of
 * every plain script would be the editor inventing a boundary that is not
 * there.
 */
function registerCellActions() {
  monaco.editor.registerCommand("build123dStudio.runCellHere", (_a, line) => runCellHere(line));
  monaco.editor.registerCommand("build123dStudio.runCellAbove", (_a, line) => runCellAbove(line));
  monaco.editor.registerCommand("build123dStudio.runAllBelow", (_a, line) => runAllBelow(line));
  monaco.editor.registerCommand("build123dStudio.runAllAbove", (_a, line) => runAllAbove(line));
  monaco.editor.registerCommand("build123dStudio.interrupt", () => interrupt());

  monaco.languages.registerCodeLensProvider("python", {
    provideCodeLenses: (model) => {
      const lenses = [];
      for (const cell of findCells(model.getValue())) {
        if (!cell.marked) {
          continue;
        }
        const range = {
          startLineNumber: cell.startLine,
          startColumn: 1,
          endLineNumber: cell.startLine,
          endColumn: 1,
        };
        for (const lens of CELL_LENSES) {
          lenses.push({
            range,
            command: {
              id: lens.command,
              title: lens.title,
              tooltip: lens.tooltip,
              arguments: [cell.startLine],
            },
          });
        }
      }
      // Monaco disposes what it is given; there is nothing here to release.
      return { lenses, dispose: () => {} };
    },
    resolveCodeLens: (_model, lens) => lens,
  });
}

/** Show or hide them, which is a setting rather than a rebuild. */
export function applyCellActions() {
  if (editor === null || editor === undefined) {
    return;
  }
  editor.updateOptions({ codeLens: cellActionsShown() });
}

function registerLanguageFeatures() {
  monaco.languages.registerCompletionItemProvider("python", {
    // Monaco asks on word characters by itself; the dot is the case that has to
    // be declared, because "part." is not a word and without it the most useful
    // completion in this application needs Ctrl-Space every time.
    triggerCharacters: ["."],
    provideCompletionItems: async (model, position, _context, token) => {
      const reply = await ipc.request(
        "editor.complete",
        queryFor(model, position),
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

  // The user's own snippets, as a provider of their own rather than folded into
  // the one above. Two reasons: it answers from memory while that one waits on
  // the sidecar, so a snippet appears whether or not the language server is up;
  // and a fault in one cannot take the other down with it.
  //
  // The marks are declared as trigger characters because Monaco asks on word
  // characters by itself and neither `?` nor `>` is one - without this the list
  // opens only once a letter follows, which is a beat late for a prefix whose
  // whole point is the mark.
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["?", ">"],
    provideCompletionItems: (model, position) => ({
      suggestions: snippetCompletions(
        userSnippets,
        model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        }),
        position,
        monaco.languages.CompletionItemKind,
        monaco.languages.CompletionItemInsertTextRule,
      ),
    }),
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
        queryFor(model, position),
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

  monaco.languages.registerHoverProvider("python", {
    provideHover: async (model, position, token) => {
      const reply = await ipc.request("editor.hover", queryFor(model, position), {
        timeout: LANGUAGE_TIMEOUT,
      });
      return token.isCancellationRequested ? null : hoverContents(reply);
    },
  });

  // Shift-Alt-F, and Format Document in the palette and the context menu, all
  // of which come with the formatActions contribution rather than being
  // registered here.
  //
  // A longer timeout than the others on purpose: completion and hover are
  // answers that are worthless late, so they give up quickly and the user types
  // on. A format is asked for once and waited for, and it is the one request
  // whose cost grows with the file. Giving up on it at the language timeout
  // would leave the one request the user is actually watching as the only one
  // that fails.
  monaco.languages.registerDocumentFormattingEditProvider("python", {
    displayName: "ruff",
    provideDocumentFormattingEdits: async (model, options, token) => {
      const source = model.getValue();
      const reply = await ipc.request(
        "editor.format",
        { source, lineLength: formatLineLength() },
        { timeout: FORMAT_TIMEOUT },
      );
      if (token.isCancellationRequested) {
        return [];
      }
      return formatEdits(source, reply?.source, model.getFullModelRange());
    },
  });

  // Diagnostics are pushed, so this is a subscription rather than a provider.
  //
  // Markers belong to a model, and the frame names which buffer it is about -
  // by key, because two unsaved buffers have the same path, which is none. A
  // diagnostic for a buffer that has since been closed is dropped: its model is
  // disposed and setModelMarkers on a disposed model throws.
  ipc.on("editor.diagnostics", (frame) => {
    const buffer = buffers.get(frame.key);
    if (buffer === null) {
      return;
    }
    monaco.editor.setModelMarkers(
      buffer.model,
      // The owner string is what lets these be replaced wholesale on the next
      // publish without touching anyone else's marks - there are none today,
      // and there will be when a linter or the debugger adds theirs.
      "basedpyright",
      markersFor(frame, monaco.MarkerSeverity),
    );
  });
}

// How long to wait after the last keystroke before telling the server the
// buffer changed. Long enough that a burst of typing is one analysis rather
// than thirty, short enough that a squiggle appears while the mistake is still
// what the eye is on. The suggestion list does not wait for this - a completion
// request syncs the document itself, because a suggestion is asked for and a
// diagnostic is not.
const SYNC_DELAY = 400;

let syncTimer = null;

/**
 * Tell the server the buffer changed, once the typing stops.
 *
 * Nothing is asked for and nothing comes back directly: the server publishes
 * diagnostics when it has analysed what it was told about, and those arrive on
 * the subscription above. Without this the squiggles would only ever refresh
 * when somebody happened to open the suggestion list, which is precisely when
 * they are not looking at them.
 */
function scheduleSync() {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const model = currentModel();
    const key = buffers.activeKeyOf();
    if (model === null || key === null || !ipc.isConnected()) {
      return;
    }
    try {
      ipc.send("editor.sync", {
        source: model.getValue(),
        path: bufferPath(key),
        key,
      });
    } catch (error) {
      log.warn("Could not send the buffer for analysis:", error);
    }
  }, SYNC_DELAY);
}

/**
 * Tell the server a document is gone, and take its squiggles with it.
 *
 * Called when a tab closes. Without it the server holds an analysis of every
 * file opened this session and goes on publishing diagnostics for buffers
 * nothing is showing.
 */
export function forgetBuffer(key, path) {
  if (!ipc.isConnected()) {
    return;
  }
  try {
    ipc.send("editor.close", { path: path ?? null, key });
  } catch (error) {
    log.warn("Could not close the analysed document:", error);
  }
}

// What registerRunActions handed back last time, so a binding change can undo
// the old chords instead of leaving both live.
let runActions = [];

/**
 * Re-register the run and debug actions after their chords changed.
 *
 * Monaco has no way to alter an action's keybinding in place, so the old
 * registration is disposed and a new one made. Without the dispose the previous
 * chord keeps working alongside the new one, which looks like the dialog did
 * nothing when a shortcut is *moved* rather than added.
 */
export function rebindRunActions() {
  if (editor === null || editor === undefined) {
    return;
  }
  for (const action of runActions) {
    action.dispose();
  }
  runActions = registerRunActions(editor);
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
    { id: "run.all", run: runAll },
    // The three the buttons above a marker introduced. No default chord, so
    // these register nothing until somebody binds one in Settings - but they
    // have to be here, or a chord bound there would land on nothing.
    { id: "run.cellAbove", run: () => runCellAbove() },
    { id: "run.allAbove", run: () => runAllAbove() },
    { id: "run.allBelow", run: () => runAllBelow() },
    // Not the kernel: the file on disk, in a process of its own. Registered
    // here with the rest because to a user it is the same kind of thing -
    // "make this file happen" - and differs only in where it happens.
    { id: "run.file", run: () => void runFileOnDisk() },
    // Registered here with the run actions because it is the same kind of
    // thing to a user - "make this file happen" - and because an editor action
    // is what gets the chord delivered while the editor has focus.
    { id: "debug.start", run: () => void debugRequested() },
    { id: "debug.continue", run: () => void debugStep("continue") },
    { id: "debug.stepOver", run: () => void debugStep("stepOver") },
    { id: "debug.stepInto", run: () => void debugStep("stepInto") },
    { id: "debug.stepOut", run: () => void debugStep("stepOut") },
    { id: "debug.restart", run: () => void debugStep("restart") },
    { id: "debug.stop", run: () => void debugStep("stop") },
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

/**
 * Format the buffer on screen, as Shift-Alt-F does.
 *
 * Through Monaco's own action rather than by calling the provider directly, so
 * that the keystroke and Format on Save are the same code path - including the
 * progress indication and the single undo stop the action wraps the edit in.
 * Two routes to one behaviour is how they come to differ.
 */
export async function formatBuffer() {
  if (editor === null || editor === undefined || currentModel() === null) {
    return;
  }
  const action = editor.getAction("editor.action.formatDocument");
  if (action === null || action === undefined) {
    // The contribution is imported, so this cannot happen - and if an upgrade
    // ever makes it happen, a save must not fail because of it.
    log.warn("No format action registered; the buffer was not formatted");
    return;
  }
  await action.run();
}

/**
 * Open the command palette, as F1 does.
 *
 * Focus first, because the palette is an editor action and an action with no
 * editor focused is an action nobody asked. That is also why the button exists:
 * F1 only works while the caret is in the editor, and somebody who has just
 * clicked in the console has no way in.
 */
export function openCommandPalette() {
  if (editor === null || editor === undefined) {
    return;
  }
  editor.focus();
  const action = editor.getAction("editor.action.quickCommand");
  if (action === null || action === undefined) {
    log.warn("No command palette registered");
    return;
  }
  void action.run();
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
