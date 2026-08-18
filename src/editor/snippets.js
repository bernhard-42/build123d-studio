// User-defined snippets, in VS Code's `.code-snippets` shape.
//
// A file of them lives beside the settings - see snippetsPath - and each entry
// offers a prefix to type and a body to insert. It is read with jsonc-parser,
// the same library VS Code reads them with, so a `.code-snippets` file copied
// in unedited works: comments and trailing commas included. The body is snippet syntax, the
// same as the New File template: `$1` and `${1:like this}` are stops to tab
// between, `$0` ends the session. Monaco starts that session itself once an item
// is accepted; all this file does is decide which items to offer and what span
// each replaces.
//
// **The span is the whole of the difficulty**, and it is why this is a module
// rather than four lines in the provider. The prefixes people write for CAD
// snippets start with a punctuation mark - `?bdp`, `>ext` - deliberately, so
// they cannot collide with a real identifier that basedpyright would also
// suggest. But Monaco filters suggestions against the *word* under the caret,
// and its word separators include both characters (`wordHelper.js`:
// "`~!@#$%^&*()-=+[{]}\|;:'\",.<>/?"). So with `?bd` typed, Monaco's word is
// `bd`: an item labelled `?bdp` is filtered against text that does not contain
// the `?`, and accepting it would insert beside the mark rather than replacing
// it, leaving `?with BuildPart() as p:`.
//
// Both halves are fixed by one thing: the range. Saying that the item replaces
// the mark as well as the letters makes the insertion correct, and Monaco then
// filters against the text of that range rather than against its own word - so
// `?b` narrows to the `?` snippets. Measured, by taking the range back to the
// letters and watching both go at once; a filterText of the whole prefix was
// tried alongside and turned out to change nothing, so it is not here.
//
// Pure, and given its filesystem rather than importing one, for safewrite.js's
// reason: every decision here is arithmetic on a line of text or on a parsed
// document, and none of it needs a window to be exercised.

import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

/** Where a snippets file lives, beside the settings and the logs. */
export function snippetsPath(dataDir) {
  return `${dataDir}/snippets.json`;
}

/**
 * The marks a prefix may begin with.
 *
 * Not a general rule about punctuation: these two are what the CAD snippet sets
 * in circulation use, and every character added here is one that stops being
 * available to the language's own completions.
 */
const PREFIX_MARKS = "?>";

/**
 * Read a snippets document into entries this application can offer.
 *
 * VS Code's shape: an object of named entries, each with a `prefix` and a
 * `body` that is a string or an array of lines. `scope` is ignored - everything
 * edited here is Python - and so is `isFileTemplate`, which names a VS Code
 * command this application does not have.
 *
 * Entries that cannot be used are dropped rather than failing the file: one
 * malformed snippet out of twenty-five must not cost the other twenty-four.
 * What was dropped is returned alongside, so the caller can say so once.
 *
 * @returns {{snippets: object[], problems: string[]}}
 */
export function parseSnippets(text) {
  // JSONC, not JSON, because that is what a `.code-snippets` file is: the sets
  // in circulation are full of `//` notes about what each snippet is for, and
  // several end an array with a trailing comma. Reading them with JSON.parse
  // fails at the first comment, which makes "copy this file in" a step that
  // needs editing first. jsonc-parser is what VS Code itself reads them with.
  const failures = [];
  const document = parseJsonc(text, failures, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (failures.length > 0) {
    // Offsets rather than line numbers: that is what the parser reports, and
    // converting them would be arithmetic this does not otherwise need.
    return {
      snippets: [],
      problems: failures.map(
        (failure) => `${printParseErrorCode(failure.error)} at character ${failure.offset}.`,
      ),
    };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { snippets: [], problems: ["The file is not an object of named snippets."] };
  }

  const snippets = [];
  const problems = [];
  for (const [name, entry] of Object.entries(document)) {
    if (entry === null || typeof entry !== "object") {
      problems.push(`${name}: not an object.`);
      continue;
    }
    const prefix = entry.prefix;
    if (typeof prefix !== "string" || prefix.trim() === "") {
      problems.push(`${name}: no prefix to type.`);
      continue;
    }
    const body = Array.isArray(entry.body) ? entry.body.join("\n") : entry.body;
    if (typeof body !== "string" || body === "") {
      problems.push(`${name}: no body to insert.`);
      continue;
    }
    snippets.push({
      name,
      prefix: prefix.trim(),
      body,
      description: typeof entry.description === "string" ? entry.description : "",
    });
  }
  return { snippets, problems };
}

/**
 * What the caret is typing, when a snippet prefix is what it could be.
 *
 * Walks back over the word characters and then over one leading mark, so `?bd`
 * answers `?bd` where Monaco's own word would answer `bd`. Answers null where
 * there is nothing a prefix could be built on, which is every position that is
 * part of a longer identifier: `foo?bd` is not somebody typing `?bd`, and
 * offering there would put a snippet inside a name.
 *
 * @param {string} before the line's text up to the caret
 * @returns {{typed: string, startColumn: number}|null}
 */
export function prefixBeing(before, caretColumn) {
  let at = before.length;
  while (at > 0 && /[A-Za-z0-9_]/.test(before[at - 1])) {
    at -= 1;
  }
  if (at === 0 || !PREFIX_MARKS.includes(before[at - 1])) {
    return null;
  }
  at -= 1;
  // The mark has to start something. A mark with a name in front of it is an
  // operator or a comparison, not a prefix being typed.
  if (at > 0 && /[A-Za-z0-9_)\]}."']/.test(before[at - 1])) {
    return null;
  }
  return { typed: before.slice(at), startColumn: caretColumn - (before.length - at) };
}

/**
 * The items to offer for what is being typed.
 *
 * `kinds` and `rules` are monaco.languages.CompletionItemKind and
 * CompletionItemInsertTextRule, passed in rather than imported, so this can be
 * exercised without loading the editor - the same arrangement completion.js and
 * keys.js use.
 */
export function snippetCompletions(snippets, before, position, kinds, rules) {
  const being = prefixBeing(before, position.column);
  if (being === null) {
    return [];
  }
  const range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: being.startColumn,
    endColumn: position.column,
  };
  return snippets
    .filter((snippet) => snippet.prefix.startsWith(being.typed))
    .map((snippet) => ({
      label: snippet.prefix,
      kind: kinds.Snippet,
      detail: snippet.description === "" ? snippet.name : snippet.description,
      documentation: { value: `\`\`\`python\n${snippet.body}\n\`\`\`` },
      insertText: snippet.body,
      insertTextRules: rules.InsertAsSnippet,
      filterText: snippet.prefix,
      // What Monaco narrows the list against as more is typed. Without it the
      // word under the caret is used, which does not contain the leading mark -
      // so `?b` would match nothing and the list would not narrow at all.
      range,
    }));
}

/**
 * The shipped set, with the user's own on top.
 *
 * Matched by prefix, and theirs wins: a set can be extended without being
 * copied, and a single snippet replaced without the other twenty-four being
 * maintained by hand. Order is the shipped ones first, so the list a user sees
 * is stable as they add to it.
 */
export function mergeSnippets(shipped, mine) {
  const replaced = new Set(mine.map((snippet) => snippet.prefix));
  return [...shipped.filter((snippet) => !replaced.has(snippet.prefix)), ...mine];
}

/**
 * Read the user's snippets, and say once what could not be used.
 *
 * A missing file is the ordinary case - most people never write one - and is
 * not a problem to report. Anything else is: a file somebody wrote and this
 * cannot read is exactly the case where silence looks like the feature not
 * existing.
 *
 * @param {{filesystem: object, log: object}} services
 * @returns {Promise<object[]>}
 */
export async function loadSnippets({ filesystem, log }, dataDir, shippedText) {
  const shipped = parseSnippets(shippedText).snippets;
  const path = snippetsPath(dataDir);
  let text;
  try {
    text = await filesystem.readFile(path);
  } catch {
    // No file of their own, which is the ordinary case: what ships is what
    // there is.
    return shipped;
  }
  const { snippets, problems } = parseSnippets(text);
  for (const problem of problems) {
    log.warn(`${path}: ${problem}`);
  }
  const merged = mergeSnippets(shipped, snippets);
  log.info(`${merged.length} snippets: ${shipped.length} shipped, ${snippets.length} from ${path}`);
  return merged;
}
