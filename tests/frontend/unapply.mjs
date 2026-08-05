// Prove each frontend test by taking its fix out.
//
// Run one at a time: `node tests/frontend/unapply.mjs <name>`. It prints which
// tests failed, and the only acceptable answer is "exactly the ones written for
// this fix". A test that passes here had no way to be red and is worth less
// than nothing, because it will be believed.
//
// Patches the working tree in place and restores it with git checkout, which is
// safe here because both files are committed and unmodified on this branch. The
// Python version copies to a scratch tree instead; that is not worth it here,
// because the build reaches node_modules and Monaco and a copy would be gigabytes.
//
// Fails loudly if the text has moved, because a substitution that matched
// nothing would report a clean run and prove the opposite of what it looks like.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const UNFIXES = {
  "splitter-has-no-width": {
    file: "src/styles.css",
    head: `#splitter-tree {
  flex: 0 0 var(--splitter);
}`,
    before: `#splitter-tree {
  /* flex removed: grid-column, which means nothing in a flex row */
}`,
    expect: "the tree splitter has a width",
  },
  "chevron-is-a-triangle-character": {
    file: "src/editor/sidebar.js",
    head: `    const chevron = document.createElement("span");
    chevron.className = expanded.has(row.path)
      ? "icon icon-chevron tree-open"
      : "icon icon-chevron";
    twisty.appendChild(chevron);`,
    before: `    twisty.textContent = expanded.has(row.path) ? "\\u25be" : "\\u25b8";`,
    expect: "a folder row's chevron",
  },
  "no-remeasure-when-the-tree-appears": {
    file: "src/editor/sidebar.js",
    head: `  if (visible === away) {
    visible = !away;
    refreshLayout();
  }`,
    before: `  visible = !away;`,
    expect: "starting with a folder open / hiding the tree gives its width back",
  },
  "layout-fractions-not-clamped": {
    file: "src/layout/splitter.js",
    head: `function clamp(value) {
  return Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, value));
}`,
    before: `function clamp(value) {
  return value;
}`,
    expect: "an absurd stored fraction is clamped",
  },
  "drag-not-persisted": {
    file: "src/layout/splitter.js",
    head: `  notifyResize();
  persist();
}`,
    before: `  notifyResize();
}`,
    expect: "moves it, and is remembered",
  },
  "dirty-check-not-deferred": {
    file: "src/editor/monaco.js",
    head: `  dirtyCheckPending = true;
  setTimeout(() => {
    dirtyCheckPending = false;
    notifyDirtyChanged();
  }, 0);`,
    before: `  dirtyCheckPending = false;
  notifyDirtyChanged();`,
    expect: "the dirty mark goes away again / title agrees",
  },
  // One model for every buffer, with the text poured into it - which is what
  // the application did before group 2 replaced four module-level values with a
  // Map. Undo history belongs to the model, so it follows the user from file to
  // file.
  "one-shared-model": {
    file: "src/editor/monaco.js",
    head: `    create: (text) => monaco.editor.createModel(text, "python"),`,
    before: `    create: (text) => {
      if (globalThis.__ONE_MODEL__ === undefined) {
        globalThis.__ONE_MODEL__ = monaco.editor.createModel(text, "python");
      } else {
        globalThis.__ONE_MODEL__.setValue(text);
      }
      return globalThis.__ONE_MODEL__;
    },`,
    expect: "each tab shows its own file / the dirty mark / a clean tab closes",
  },
  // A close that never asks - the state before group 2's piece 4, and the shape
  // of the Phase 2 defect where quitting after a failed save discarded the
  // buffer the user had just asked to keep.
  "close-never-asks": {
    file: "src/editor/files.js",
    head: `  if (!(await confirmDiscardAll())) {
    return false;
  }
  showNoBuffer();`,
    before: `  showNoBuffer();`,
    expect: "asks once and lists them / Cancel cancels / Save writes",
  },
  // Shift-Enter and Ctrl-Enter swapped: the one thing the pure tests explicitly
  // cannot catch, because keys.js checks that a chord exists and starters.mjs
  // checks that the prose names it - neither checks what it is attached to. It
  // has shipped wrong once.
  "run-chords-swapped": {
    file: "src/keys.js",
    head: `    id: "run.cell",
    label: "Run Cell",
    chords: ["shift+enter"],`,
    before: `    id: "run.cell",
    label: "Run Cell",
    chords: ["ctrl+enter", "mod+enter"],`,
    expect: "Shift-Enter runs the cell / Ctrl-Enter stays",
  },
  // Whitespace sent to the kernel, advancing In[n] for nothing.
  "blank-code-still-sent": {
    file: "src/editor/monaco.js",
    head: `  if (code.trim() === "") {
    return;
  }`,
    before: `  if (false) {
    return;
  }`,
    expect: "a buffer with nothing but blank lines sends nothing",
  },
  // The working directory following the active tab instead of the project root.
  // Plausible, and wrong: relative paths would resolve somewhere different for
  // every file in the same project.
  "cwd-follows-the-tab": {
    file: "src/editor/files.js",
    head: `  ipc.send("kernel.cwd", { path: folder ?? directoryOf(getCurrentFile()) });`,
    before: `  ipc.send("kernel.cwd", { path: directoryOf(getCurrentFile()) });`,
    expect: "the cwd is the project root however deep the file sits",
  },
  // Open Folder keeping whatever tabs it felt like, instead of being a reset.
  "open-folder-keeps-tabs": {
    file: "src/editor/files.js",
    head: `  if (!(await closeEveryTab())) {
    return false;
  }
  await showFolderAt(chosen);`,
    before: `  await showFolderAt(chosen);`,
    expect: "Open Folder closes every tab / asks about unsaved work",
  },
  // A dismissed chooser treated as a choice. os.showFolderDialog's cancel return
  // is undocumented, which is exactly why the guard is written this way.
  "folder-dialog-cancel-ignored": {
    file: "src/editor/files.js",
    head: `  if (typeof chosen !== "string" || chosen === "") {
    return false;
  }`,
    before: `  if (false) {
    return false;
  }`,
    expect: "cancelling the chooser changes nothing at all",
  },
  // The explorer offering a chevron on everything, expandable or not - a
  // promise the row cannot keep.
  "twisty-on-every-row": {
    file: "src/vars/explorer.js",
    head: `  if (row.expandable !== false) {
    const chevron = document.createElement("span");`,
    before: `  if (true) {
    const chevron = document.createElement("span");`,
    expect: "only a row that leads somewhere offers to open",
  },
  // The explorer back to drawing its marker as a character, which is what it
  // did until the frontend suite noticed the two panes disagreeing. WKWebView
  // has no glyph for U+25B8 and renders it as a dot.
  "explorer-twisty-is-a-character": {
    file: "src/vars/explorer.js",
    head: `  if (row.expandable !== false) {
    const chevron = document.createElement("span");
    chevron.className = isOpen ? "icon icon-chevron var-open" : "icon icon-chevron";
    twisty.append(chevron);
  }`,
    before: `  twisty.textContent = row.expandable === false ? "" : isOpen ? "\u25be" : "\u25b8";`,
    expect: "the chevron uses the icon font / the two panes draw it the same way",
  },
  // Console keystrokes going nowhere, which turns the pane into a transcript.
  "console-input-dropped": {
    file: "src/console/terminal.js",
    head: `  terminal.onData((data) => {
    ipc.sendBinary(ipc.KIND_CONSOLE, encoder.encode(data));
  });`,
    before: `  terminal.onData(() => {});`,
    expect: "a keystroke in the console is sent back as input",
  },
  // The contribution trap itself, one import at a time. editor.api.js is the
  // API only: the provider stays registered and is simply never asked, and the
  // only symptom is that nothing appears. Before dev42 the editor had no
  // completion of any kind for exactly this reason and nothing said so.
  "no-suggest-widget": {
    file: "src/editor/monaco.js",
    head: `import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";`,
    before: `// suggestController import removed`,
    expect: "the suggestion widget shows what the sidecar offered",
  },
  "no-parameter-hints-widget": {
    file: "src/editor/monaco.js",
    head: `import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";`,
    before: `// parameterHints import removed`,
    expect: "the parameter hints popup shows the signature",
  },
  "no-hover-widget": {
    file: "src/editor/monaco.js",
    head: `import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";`,
    before: `// hoverContribution import removed`,
    expect: "hovering a name shows what it holds",
  },
  // Apply learning to run the environment, which is the rule eroding by one
  // handler: Apply saves and closes and touches nothing else.
  "apply-also-installs": {
    file: "src/settings.js",
    head: `  document.getElementById("settings-apply").addEventListener("click", async () => {`,
    before: `  document.getElementById("settings-apply").addEventListener("click", async () => {
    await installPackages();`,
    expect: "Apply saves and closes, and touches nothing else",
  },
  // A bare letter accepted as a chord, which would swallow that key while typing.
  "any-chord-accepted": {
    file: "src/keys.js",
    head: `export function chordProblem(chord) {
  const descriptor = parseChord(chord);`,
    before: `export function chordProblem(chord) {
  if (chord !== undefined) {
    return null;
  }
  const descriptor = parseChord(chord);`,
    expect: "a bare letter is refused with a reason",
  },
  // The step controls left enabled between stops - a control that does nothing
  // when pressed is worse than one that says so.
  "step-controls-always-enabled": {
    file: "src/debug/start.js",
    head: `const NEEDS_PAUSE = new Set(["debug-continue", "debug-step-over", "debug-step-into",
                             "debug-step-out"]);`,
    before: `const NEEDS_PAUSE = new Set();`,
    expect: "stepping is disabled between stops",
  },
  // The viewer drawing a model with no geometry, which is the force-quit.
  "viewer-draws-empty-model": {
    file: "src/viewer/viewer.js",
    head: `    if (payload.byteLength === 0) {
      log.warn("Ignored a model with no geometry in it");
      return;
    }`,
    before: `    if (false) {
      return;
    }`,
    expect: "a model with no geometry is refused rather than hanging",
  },
};

const which = process.argv[2];
const unfix = UNFIXES[which];
if (unfix === undefined) {
  console.error(
    which === undefined
      ? `Usage: node tests/frontend/unapply.mjs <name>\n\n${Object.entries(UNFIXES)
          .map(([name, entry]) => `  ${name.padEnd(34)} should fail: ${entry.expect}`)
          .join("\n")}`
      : `unknown un-fix: ${which}`,
  );
  process.exit(2);
}

const path = `${ROOT}/${unfix.file}`;
const original = readFileSync(path, "utf8");
const count = original.split(unfix.head).length - 1;
if (count !== 1) {
  console.error(`${which}: the text at HEAD appears ${count} times in ${unfix.file}; it has moved`);
  process.exit(2);
}

writeFileSync(path, original.replace(unfix.head, unfix.before));
let output = "";
try {
  const result = spawnSync("yarn", ["test:frontend"], { cwd: ROOT, encoding: "utf8" });
  output = `${result.stdout}${result.stderr}`;
} finally {
  // The bytes that were here, not `git checkout` - which restores HEAD and so
  // silently destroys any uncommitted work in the file. That is not
  // hypothetical: it ate a fix to explorer.js that had not been committed yet,
  // and the only reason it was noticed is that the very next command read the
  // file back. A tool that runs a suite must not be able to lose the change the
  // suite is about.
  writeFileSync(path, original);
}

const lines = output
  .split("\n")
  .filter((line) => /✓|✘|passed|failed|✕|×/.test(line) && !line.includes("modules transformed"));
console.log(`--- ${which} ---`);
console.log(lines.join("\n"));
