// Reading the remembered session out of settings.json.
//
// Separated from files.js because it is the part that can be wrong without
// anybody noticing: it runs once at startup, against a file written by an older
// version of the application, and if it returns nonsense the symptom is "my
// tabs are gone" on the morning after an upgrade. Nothing here touches
// Neutralino or the filesystem, so it can be tested against every shape the
// file has ever had.
//
// What it does not do is decide anything about files. Whether a path still
// exists is the filesystem's answer and belongs where the reading happens; this
// only turns what was stored into what the application expects, or into null.

/** A caret is three numbers or nothing at all. */
function readCaret(caret) {
  if (typeof caret !== "object" || caret === null) {
    return null;
  }
  if (!Number.isFinite(caret.line)) {
    return null;
  }
  return {
    line: caret.line,
    column: Number.isFinite(caret.column) ? caret.column : 1,
    // A missing scroll offset is not a broken caret: placeCaret reveals the
    // line instead, which is the better answer anyway when the file has changed.
    scrollTop: Number.isFinite(caret.scrollTop) ? caret.scrollTop : null,
  };
}

/**
 * The workspace as this version writes it.
 *
 * An empty tab list is a real answer and not a missing one - somebody closed
 * every tab and quit - so it comes back as an empty workspace rather than null.
 * Returning null there would fall through to the migration below and reopen a
 * file they had deliberately closed, possibly several versions ago.
 */
function readCurrent(workspace) {
  if (typeof workspace !== "object" || workspace === null || !Array.isArray(workspace.tabs)) {
    return null;
  }
  const tabs = [];
  for (const tab of workspace.tabs) {
    if (typeof tab !== "object" || tab === null) {
      continue;
    }
    if (typeof tab.path !== "string" || tab.path === "") {
      continue;
    }
    tabs.push({ path: tab.path, caret: readCaret(tab.caret) });
  }
  const active = typeof workspace.active === "string" && workspace.active !== ""
    ? workspace.active
    : null;
  return { tabs, active };
}

/**
 * An installation from before tabs existed: one file, one caret, three keys.
 *
 * Read on exactly one start per installation, because the first save writes the
 * new key and this is only consulted when that key is absent. Without it,
 * upgrading loses the file you had open, which is a poor reward for upgrading.
 */
function readLegacy({ lastFile, lastPosition, lastScrollTop }) {
  if (typeof lastFile !== "string" || lastFile === "") {
    return null;
  }
  const caret = readCaret(
    typeof lastPosition === "object" && lastPosition !== null
      ? { ...lastPosition, scrollTop: lastScrollTop }
      : null,
  );
  return { tabs: [{ path: lastFile, caret }], active: lastFile };
}

/**
 * What to reopen, from whatever the settings file happens to contain.
 *
 * @param {{workspace: *, lastFile: *, lastPosition: *, lastScrollTop: *}} settings
 * @returns {{tabs: Array<{path: string, caret: object|null}>, active: string|null}|null}
 */
export function readWorkspace(settings) {
  return readCurrent(settings.workspace) ?? readLegacy(settings);
}

/**
 * Which of the tabs that actually opened should be the one on screen.
 *
 * By path rather than by position, because a file that has been deleted since
 * is simply not reopened and every index after it would have shifted. A
 * remembered active file that is one of the casualties falls back to the first
 * tab rather than to none.
 */
export function chooseActive(openPaths, wanted) {
  if (openPaths.length === 0) {
    return null;
  }
  return openPaths.includes(wanted) ? wanted : openPaths[0];
}
