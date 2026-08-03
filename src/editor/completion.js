// Python completion, as data. The wiring to Monaco and to the sidecar is in
// monaco.js; everything decidable without either is here, and is tested.
//
// ## Two sources, because neither is enough
//
// monaco-editor ships language services for TypeScript, JSON, CSS and HTML and
// for nothing else, and this editor deliberately registers only the Python
// *grammar* - tokens and colour - to avoid dragging in some nine megabytes of
// services it cannot use. So the completions come from the sidecar, which asks
// two things and merges what they say.
//
// The kernel answers complete_request - it is what gives IPython its Tab
// completion - against the *live namespace*. It knows the methods of the part
// the user built two cells ago, which no reading of the file can: that object
// does not exist in the file, it exists in a kernel that has run it. What it
// does not know is anything that has not been run, and an editor is where
// people write a whole file before running any of it: on a cold kernel, a file
// beginning "from build123d import *" offered nothing at all for "b = Bo".
//
// jedi reads the buffer and infers without executing, which is exactly the
// other half: it resolves the star import to Box, follows "b = Box(...)" to
// b.center, and knows Box's keyword arguments before Box exists anywhere. It
// runs in the sidecar rather than the kernel, so it also answers while a cell
// is running.
//
// The merge and the ranking happen in the sidecar, which is the only place that
// has both lists. What arrives here is one list in one vocabulary, live entries
// first, and this file does not know or care which source a row came from.
//
// Word-based suggestions stay switched on alongside. They cost nothing, and
// they cover a word being typed twice in a file that neither source has any
// reason to know about. Everything here sorts above them; see sortText below.

/**
 * What to ask about, for a cursor at `position` in a buffer.
 *
 * The whole file, because jedi needs the imports and the assignments above the
 * cursor to infer anything - a line on its own resolves to nothing. The sidecar
 * takes the one line out of it for the kernel, which completes against a
 * namespace rather than a syntax tree and does not want the rest.
 *
 * Monaco counts columns from one and both jedi and cursor_pos count from zero,
 * which is the whole of the conversion and exactly the sort of thing that is
 * wrong by one for a week before anybody notices. Lines are 1-based in both.
 *
 * The buffer key travels with it because the path does not identify a buffer:
 * File > New twice gives two unsaved buffers with no path at all, and the
 * language server needs a distinct document for each or the diagnostics for one
 * are published against the other.
 *
 * @param {string} source the whole buffer
 * @param {{lineNumber: number, column: number}} position Monaco's cursor
 * @param {string|null} path the file on disk, or null for an unsaved buffer
 * @param {string|null} key which buffer this is
 */
export function completionQuery(source, position, path, key) {
  return {
    source,
    line: position.lineNumber,
    column: Math.max(0, position.column - 1),
    path: path ?? null,
    key: key ?? null,
  };
}

// The completion types the sidecar sends - IPython's vocabulary, which jedi's
// is translated into - against the Monaco kinds that carry the right icon.
//
// Nothing depends on a type arriving. An unknown or missing one falls back to
// Variable, which is what a name in a namespace is.
const KINDS = {
  function: "Function",
  method: "Method",
  class: "Class",
  module: "Module",
  keyword: "Keyword",
  statement: "Keyword",
  instance: "Variable",
  param: "Variable",
  path: "File",
  "dict key": "Property",
  magic: "Function",
};

/**
 * Pair a match with the entry that describes it, if there is one.
 *
 * By index *and* by text. The sidecar builds both lists from the same entries
 * so they are parallel by construction, and checking anyway costs one
 * comparison against attaching every icon, signature and - which matters far
 * more - every replacement span to the wrong row.
 */
function typeOf(types, index, match) {
  if (!Array.isArray(types)) {
    return null;
  }
  const entry = types[index];
  if (entry === undefined || entry === null || entry.text !== match) {
    return null;
  }
  return entry;
}

/**
 * Where a match should be inserted, as a Monaco range.
 *
 * Each source says which slice of the line its matches replace, and it is not
 * always the word Monaco would guess: for "time.sl" the kernel replaces "sl"
 * and not "time.sl", and for "part." it is the empty span after the dot -
 * while what it returns for that span is ".center", dot included. Guessing
 * instead would produce "sleep" where the user meant "time.sleep".
 *
 * The fallback, for an entry that carries no span at all, is the word Monaco
 * has under the cursor. Nothing sent by this application's sidecar reaches it -
 * every entry leaves there with integers - and it is a conservative answer
 * rather than a good one, which is the right shape for a branch whose job is to
 * not corrupt the line.
 *
 * Offsets are into the line, so a column is the offset plus one.
 */
function rangeFor(position, start, end) {
  const startColumn = Number.isInteger(start)
    ? start + 1
    : position.wordStartColumn ?? position.column;
  const endColumn = Number.isInteger(end) ? end + 1 : position.column;
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn,
    endColumn,
  };
}

/**
 * Turn one kernel reply into Monaco completion items.
 *
 * `kinds` is monaco.languages.CompletionItemKind, passed in rather than
 * imported, so this can be exercised without loading the editor - the same
 * arrangement keys.js uses for KeyMod, and for the same reason.
 *
 * Items are built from `matches`, which is the documented field, and only
 * decorated from the experimental type list. A reply with no metadata at all
 * still produces a complete, usable list.
 *
 * @param {object|null} reply the editor.complete frame, or null
 * @param {{lineNumber: number, column: number, wordStartColumn?: number}} position
 *   where the cursor was, and where Monaco thinks the word under it begins
 * @param {object} kinds monaco.languages.CompletionItemKind
 */
export function completionItems(reply, position, kinds) {
  if (reply === null || reply === undefined || !Array.isArray(reply.matches)) {
    return [];
  }

  return reply.matches.map((match, index) => {
    const entry = typeOf(reply.types, index, match);
    const kindName = entry === null ? null : KINDS[entry.type];
    const item = {
      // IPython returns an attribute with its dot on - ".center" for "part.ce"
      // - because the span it replaces starts at the dot. Inserting that is
      // right and showing it is not: a list of names each preceded by a dot
      // reads as noise. So the label loses it and filterText keeps it, because
      // what Monaco filters against is the text in the replacement range, and
      // that text begins with the dot too.
      label: match.startsWith(".") ? match.slice(1) : match,
      filterText: match,
      insertText: match,
      kind: kinds[kindName ?? "Variable"],
      // The order the sidecar merged them in, preserved, and ahead of Monaco's
      // word-based suggestions - which have no sortText and therefore sort by
      // label. A name one of the two sources knows is worth more than a word
      // that happens to appear in the buffer, live names come before inferred
      // ones, and IPython puts dunders last for the same reason nobody wants
      // __class__ first.
      sortText: String(index).padStart(4, "0"),
      range: rangeFor(position, entry?.start, entry?.end),
    };
    // The signature, where IPython supplies one: "(x)" beside my_helper is the
    // difference between knowing the name and knowing how to call it.
    if (entry !== null && typeof entry.signature === "string" && entry.signature !== "") {
      item.detail = entry.signature;
    }
    return item;
  });
}

/**
 * Whether Monaco should ask again as the word grows.
 *
 * True when the sidecar capped the list. Monaco re-queries an incomplete list
 * on the next keystroke instead of filtering the one it has, which is what
 * makes a cap honest rather than a silently short answer: "import " offers 394
 * modules, the user sees the first two hundred, and typing "n" fetches the ones
 * that start with n.
 */
export function isIncomplete(reply) {
  return reply !== null && reply !== undefined && reply.truncated === true;
}
