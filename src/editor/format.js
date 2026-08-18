// What "format this file" means, decided without a window.
//
// Pure, for the usual reason: the line length is a number a user types, and a
// number a user types is a decision that can be wrong. Sending a nonsense one
// to ruff means an error on the sidecar's lane instead of an answer, and
// storing one means the field cannot be corrected from the dialog it was typed
// into - the same shape of trap as the custom packages field, which is why that
// one is a pure module too.
//
// The formatter itself is ruff, in the sidecar. This half only says how wide
// the result should be and what to do with what comes back.

/**
 * ruff's own default, and the editor's ruler.
 *
 * 88 is not arbitrary on either side: it is what ruff chooses when nothing
 * says otherwise, and `rulers: [88]` was already in the editor's options before
 * there was a formatter. Those two agreeing by accident is worth making
 * deliberate - the ruler now follows this setting, so the line the user is
 * looking at is the line the formatter will wrap at.
 */
export const DEFAULT_LINE_LENGTH = 88;

// Narrow enough that nothing fits, and wide enough that nothing wraps. Neither
// bound is a matter of taste - they are there so the stored value is always a
// number ruff can be given.
const MIN_LINE_LENGTH = 20;
const MAX_LINE_LENGTH = 1000;

/**
 * The line length to actually use, given whatever is stored.
 *
 * settings.json is a file people edit by hand, so this has to survive a string,
 * a float, a negative, a null and a missing key - and answer with something
 * ruff can be handed in every case. It falls back rather than refusing:
 * a broken setting must not stop the formatter working, it must stop being
 * broken.
 */
export function usableLineLength(stored) {
  const value = typeof stored === "string" ? Number(stored.trim()) : stored;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LINE_LENGTH;
  }
  const whole = Math.round(value);
  if (whole < MIN_LINE_LENGTH || whole > MAX_LINE_LENGTH) {
    return DEFAULT_LINE_LENGTH;
  }
  return whole;
}

/**
 * Why this typed value cannot be stored, or null when it can.
 *
 * Separate from usableLineLength because the two answer different questions.
 * This one is the dialog telling somebody their input is wrong while they can
 * still see it; that one is every later read coping with whatever ended up in
 * the file. Silently rounding 87.5 in the dialog would be answering a question
 * the user is still in the middle of asking.
 */
export function lineLengthProblem(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") {
    return "Enter a line length, or restore the default of 88.";
  }
  if (!/^\d+$/.test(trimmed)) {
    return "A line length is a whole number of characters.";
  }
  const value = Number(trimmed);
  if (value < MIN_LINE_LENGTH || value > MAX_LINE_LENGTH) {
    return `A line length between ${MIN_LINE_LENGTH} and ${MAX_LINE_LENGTH} characters.`;
  }
  return null;
}

/**
 * The edits that turn the buffer into the formatted text.
 *
 * One edit over the whole document, which is what every formatter of a
 * whole-file tool does - ruff rewrites the file, so there is no smaller true
 * statement to make about what changed.
 *
 * Empty when nothing changed, and that is not an optimisation. An edit that
 * replaces the text with itself still moves the cursor to the end, still marks
 * the buffer dirty and still pushes an undo stop, so formatting an
 * already-formatted file would look like it had done something.
 */
export function formatEdits(original, formatted, range) {
  if (typeof formatted !== "string" || formatted === original) {
    return [];
  }
  return [{ range, text: formatted }];
}
