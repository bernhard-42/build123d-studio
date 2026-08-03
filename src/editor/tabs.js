// What each tab is called.
//
// The label is the filename and the tooltip is the full path, which is enough
// until two open files are called the same thing - and in a CAD project they
// routinely are. `parts/bracket.py` and `fixtures/bracket.py` both read as
// "bracket.py", and a strip of identical tabs is worse than no strip.
//
// So a tab that would be ambiguous carries a hint: the shortest run of parent
// directories that tells it apart from the others sharing its name, and no more
// than that. Two files differing in their immediate parent get one segment;
// deeper trees get as many as they need. Everything unambiguous stays bare,
// because a hint on every tab is noise that makes the ambiguous ones harder to
// spot rather than easier.
//
// Pure, and it is the part of the tab strip worth testing: the DOM around it is
// a row of buttons, while this is the bit with an algorithm in it.

/** The last segment of a path, whichever separator it was written with. */
function basename(path) {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1];
}

/** Everything above the filename, outermost first. */
function parentSegments(path) {
  return path.split(/[/\\]/).slice(0, -1).filter((segment) => segment !== "");
}

/**
 * Name the unsaved buffers.
 *
 * Numbered only when there is more than one, so the common case - a single new
 * file - is "Untitled" rather than "Untitled-1", which invites the question of
 * where Untitled-2 is.
 */
function untitledLabel(index, total) {
  return total === 1 ? "Untitled" : `Untitled-${index + 1}`;
}

/**
 * Work out what to show on each tab.
 *
 * @param {Array<{key: number, path: string|null}>} buffers in tab order
 * @returns {Array<{key: number, label: string, hint: string, title: string}>}
 */
export function labelsFor(buffers) {
  const untitled = buffers.filter((buffer) => buffer.path === null);

  // Which names are shared, so only those pay for a hint.
  const sharing = new Map();
  for (const buffer of buffers) {
    if (buffer.path === null) {
      continue;
    }
    const name = basename(buffer.path);
    const group = sharing.get(name) ?? [];
    group.push(buffer.path);
    sharing.set(name, group);
  }

  return buffers.map((buffer) => {
    if (buffer.path === null) {
      return {
        key: buffer.key,
        label: untitledLabel(untitled.indexOf(buffer), untitled.length),
        hint: "",
        title: "Not saved to a file yet",
      };
    }
    const name = basename(buffer.path);
    return {
      key: buffer.key,
      label: name,
      hint: hintFor(buffer.path, sharing.get(name)),
      title: buffer.path,
    };
  });
}

/**
 * The shortest tail of parent directories that separates this path from the
 * others sharing its filename, or "" when nothing shares it.
 *
 * Grown a segment at a time rather than jumping to the full path: the point is
 * to say the least that answers "which bracket.py is this", and on a deep tree
 * the full path is both unreadable in a tab and mostly identical anyway.
 *
 * Two buffers on the same path is not something the tab strip creates - opening
 * an open file focuses its tab - but it is reachable through Save As, and the
 * loop below simply runs out of segments and returns the whole parent path for
 * both. Identical hints on identical paths is the honest answer.
 */
function hintFor(path, sameName) {
  if (sameName === undefined || sameName.length < 2) {
    return "";
  }
  const mine = parentSegments(path);
  const others = sameName
    .filter((other) => other !== path)
    .map((other) => parentSegments(other));

  for (let depth = 1; depth <= mine.length; depth += 1) {
    const tail = mine.slice(-depth).join("/");
    const clashes = others.some((other) => other.slice(-depth).join("/") === tail);
    if (!clashes) {
      return tail;
    }
  }
  return mine.join("/");
}
