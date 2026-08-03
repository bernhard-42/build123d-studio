// The application must never reload.
//
// It is a webview, so it inherits a browser's reload keys - F5 and Ctrl-R on
// Windows and Linux, Cmd-R on macOS - and a reload here is not a refresh. It
// discards the editor buffer with whatever was unsaved in it, drops the
// WebSocket to the sidecar, and re-runs the whole bootstrap against a kernel
// that is still running from the previous life. Nothing asks first, because a
// browser has no reason to think a reload is destructive.
//
// This is the same family as the Phase 2 work on edits being lost silently, and
// it is a prerequisite for binding F5 to Run File at all: without it, the
// shortcut for "run my file" is one keystroke away from throwing that file's
// unsaved changes away on two of the three platforms.
//
// ## preventDefault, never stopPropagation
//
// The guard listens on the window in the capture phase, so it runs before
// anything else, and it only calls preventDefault. That distinction is
// load-bearing. preventDefault tells the browser not to reload; stopPropagation
// would additionally stop the key reaching the application, and Ctrl-R is
// readline's reverse-i-search - the console pane needs it delivered to the pty
// exactly as typed. Monaco's own handling of F5 works for the same reason: the
// event still arrives, only the browser's response to it is cancelled.
//
// It is best-effort by nature. A webview may implement its accelerator keys
// below the page, where no listener can see them - WebView2 has a whole setting
// for it - so this is the layer that can be written here rather than a proof.
// What it is not is a guess: if a reload ever does get through on some platform,
// the fix is that platform's accelerator setting, and this file is still right.
//
// ## The other way in
//
// Keys were not the only route, which the first version of this file assumed.
// The webview also brings its own context menu, and on macOS right-clicking the
// empty area below the last line offers a "Reload" *item* - a labelled button
// for discarding the buffer, which is worse than a mis-typed chord because
// nothing about it looks like a mistake. Reported from a real build; no amount
// of reading would have found it.
//
// So the native menu is suppressed everywhere. That costs the browser's own
// Copy and Paste entries, which this application already provides on the Edit
// menu and on the usual chords, and it is the whole menu rather than a per-pane
// exception because every pane's version of it carries the same Reload.

/**
 * True for the chords a browser reloads on.
 *
 * A pure predicate so the table can be asserted without a window, which matters
 * because two of the three platforms are not the one this is written on.
 *
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean,
 *          altKey?: boolean}} event
 */
export function isReloadChord(event) {
  if (typeof event?.key !== "string") {
    return false;
  }
  const key = event.key.toLowerCase();

  // F5 in every dress: plain, and the Ctrl/Shift variants browsers treat as a
  // cache-bypassing reload.
  if (key === "f5") {
    return event.altKey !== true;
  }

  // Ctrl-R and Cmd-R, and their Shift forms. Alt-R is nobody's reload, and
  // excluding it keeps a legitimate Alt chord bindable later.
  if (key === "r") {
    return (event.ctrlKey === true || event.metaKey === true) && event.altKey !== true;
  }

  return false;
}

/**
 * Stop reload chords reaching the browser, without stopping them reaching us.
 *
 * @param {EventTarget} target defaults to the window; injectable for tests
 * @returns {() => void} removes the guard, for symmetry rather than because
 *   anything currently wants to
 */
export function guardAgainstReload(target = window) {
  const onKeyDown = (event) => {
    if (isReloadChord(event)) {
      event.preventDefault();
    }
  };
  // Capture, so this runs before Monaco or xterm.js can call stopPropagation on
  // the way past and leave the browser to reload behind our backs.
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}

/**
 * Stop the webview showing its own context menu, which offers a Reload.
 *
 * Bubble phase, which is the opposite of the keydown guard above and for a
 * reason worth stating. There, running first is the point: another handler may
 * stopPropagation and leave the browser to act on a key nobody cancelled. Here,
 * running *last* is the point: Monaco draws its own context menu in response to
 * this same event, and a pane that wants to show one must get the chance before
 * anything declares the event dealt with. preventDefault only ever cancels the
 * browser's menu - it does not stop Monaco drawing its own, which is HTML rather
 * than a native menu and does not depend on the default action.
 *
 * @param {EventTarget} target defaults to the window; injectable for tests
 * @returns {() => void} removes the guard
 */
export function suppressNativeContextMenu(target = window) {
  const onContextMenu = (event) => {
    event.preventDefault();
  };
  target.addEventListener("contextmenu", onContextMenu);
  return () => target.removeEventListener("contextmenu", onContextMenu);
}
