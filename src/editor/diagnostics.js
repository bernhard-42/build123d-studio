// Squiggles: what the language server thinks is wrong with the buffer.
//
// Pushed rather than asked for. The server analyses a document whenever it is
// told the text changed and publishes what it found, so this arrives on its own
// schedule - which is why the editor sends the buffer on a timer after an edit
// as well as when it wants a completion. Without that, diagnostics would only
// refresh when somebody happened to open the suggestion list.
//
// The value is telling you before you run it. "AttributeError: 'Cube' object
// has no attribute 'part'" is a true and useless sentence once the file has
// already run for thirty seconds and tessellated something; the same fact
// underlined as you type costs nothing.

/**
 * Turn the sidecar's diagnostics into Monaco markers.
 *
 * `severities` is monaco.MarkerSeverity, passed in rather than imported so this
 * can be exercised without loading the editor - the same arrangement keys.js
 * uses for KeyMod and completion.js for CompletionItemKind.
 *
 * LSP counts lines and characters from zero and Monaco counts both from one,
 * which is the whole of the conversion and the reason a squiggle can end up
 * underlining the line above the mistake.
 *
 * @param {object|null} frame the editor.diagnostics frame
 * @param {object} severities monaco.MarkerSeverity
 */
export function markersFor(frame, severities) {
  const diagnostics = frame === null || frame === undefined ? null : frame.diagnostics;
  if (!Array.isArray(diagnostics)) {
    return [];
  }

  return diagnostics.flatMap((diagnostic) => {
    const range = rangeOf(diagnostic);
    if (range === null) {
      return [];
    }
    return [{
      ...range,
      message: typeof diagnostic.message === "string" ? diagnostic.message : "",
      severity: severityOf(diagnostic.severity, severities),
      // Both shown in the hover over the squiggle: "basedpyright" says who is
      // making the claim, and the rule name is what somebody would search for
      // or switch off.
      source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
      code: codeOf(diagnostic.code),
    }];
  });
}

/**
 * The span to underline, in Monaco's one-based coordinates.
 *
 * Null for a diagnostic with no usable range rather than a marker at 1:1: a
 * squiggle in the wrong place is worse than none, because it sends the reader
 * to a line that has nothing wrong with it.
 */
function rangeOf(diagnostic) {
  const range = diagnostic.range;
  if (range === null || range === undefined) {
    return null;
  }
  const start = position(range.start);
  const end = position(range.end);
  if (start === null || end === null) {
    return null;
  }
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

function position(point) {
  if (point === null || point === undefined) {
    return null;
  }
  if (!Number.isInteger(point.line) || !Number.isInteger(point.character)) {
    return null;
  }
  return { lineNumber: point.line + 1, column: point.character + 1 };
}

// LSP severities, in order: 1 Error, 2 Warning, 3 Information, 4 Hint.
const SEVERITY_NAMES = { 1: "Error", 2: "Warning", 3: "Info", 4: "Hint" };

/**
 * How loudly to draw it.
 *
 * Anything unrecognised becomes a warning rather than an error. The severity is
 * the server's opinion and a missing one is not licence to shout: an error mark
 * puts a red square in the overview ruler and reads as "this will not run".
 */
function severityOf(severity, severities) {
  const name = SEVERITY_NAMES[severity];
  return severities[name ?? "Warning"];
}

/** The rule that fired, where there is one worth showing. */
function codeOf(code) {
  if (typeof code === "string" || typeof code === "number") {
    return code;
  }
  // LSP also allows {value, target} for a code with a documentation link.
  if (code !== null && code !== undefined && typeof code === "object") {
    const value = code.value;
    if (typeof value === "string" || typeof value === "number") {
      return value;
    }
  }
  return undefined;
}
