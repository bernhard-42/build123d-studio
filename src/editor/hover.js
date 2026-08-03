// What the thing under the pointer is: its type, and the first of its docs.
//
// The cheapest of the three language features to add, because the transport,
// the document sync and the server are already there for completion - a hover
// is one more request over the same connection. It answers the question a CAD
// script raises constantly, which is what a name actually holds: build123d's
// operations return Part, Sketch, Curve and Compound almost
// interchangeably-looking, and the difference decides what the next line can do.

/**
 * Turn the sidecar's answer into Monaco's Hover.
 *
 * LSP allows three shapes for the contents - a MarkupContent, a marked string,
 * or a list of either - and a server may pick any of them. All three arrive
 * here as one already-flattened string from the sidecar, because deciding what
 * a hover says is not a job for the frontend.
 *
 * @param {object|null} frame the editor.hover reply
 * @returns {object|null} a Monaco Hover, or null when there is nothing to say
 */
export function hoverContents(frame) {
  const hover = frame === null || frame === undefined ? null : frame.hover;
  if (hover === null || hover === undefined) {
    return null;
  }
  const value = hover.value;
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const contents = [{ value, isTrusted: false }];
  const range = rangeOf(hover.range);
  return range === null ? { contents } : { contents, range };
}

/**
 * The span the hover describes, if the server said.
 *
 * Optional in the protocol, and Monaco highlights the word itself when it is
 * absent - so a missing range costs the highlight and nothing else. LSP counts
 * from zero and Monaco from one.
 */
function rangeOf(range) {
  if (range === null || range === undefined) {
    return null;
  }
  const { start, end } = range;
  if (start === undefined || end === undefined) {
    return null;
  }
  if (![start.line, start.character, end.line, end.character].every(Number.isInteger)) {
    return null;
  }
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
  };
}
