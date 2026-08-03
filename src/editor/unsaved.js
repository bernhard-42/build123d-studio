// What the "you have unsaved work" question says.
//
// Pure, and separated because the wording is the safety feature. Phase 2 exists
// partly because work could be lost silently, and this dialog is the last thing
// standing between a quit and somebody's afternoon - so what it says, and
// whether it says how many files it means, is worth a test rather than a
// read-through.
//
// One prompt for all of them rather than one per file. Being asked five times
// in a row is how people learn to dismiss a dialog without reading it, and the
// fifth question looks exactly like the first.

// How many files are named before the list is summarised. Ten is about what
// fits without the dialog growing past the window; past that, the count is the
// useful information and the names are not.
const NAMED = 10;

/**
 * Compose the question.
 *
 * @param {string[]} names one per unsaved buffer, in tab order
 * @returns {{title: string, detail: string, save: string, discard: string,
 *            cancel: string}}
 */
export function unsavedPrompt(names) {
  if (names.length === 1) {
    return {
      title: "Unsaved changes",
      detail: `${names[0]} has unsaved changes.`,
      save: "Save",
      discard: "Discard",
      cancel: "Cancel",
    };
  }

  const listed = names.slice(0, NAMED).map((name) => `    ${name}`);
  const hidden = names.length - listed.length;
  if (hidden > 0) {
    listed.push(`    …and ${hidden} more`);
  }

  return {
    title: "Unsaved changes",
    // The count first, because it is the part that decides what to do: three
    // files is a moment's thought and thirty is a mistake worth cancelling.
    detail: `${names.length} files have unsaved changes:\n\n${listed.join("\n")}`,
    // "All" on both, so neither button can be read as applying to one of them.
    save: "Save All",
    discard: "Discard All",
    cancel: "Cancel",
  };
}
