/**
 * HTML-escape a string for interpolation into markup.
 *
 * One implementation, because there were three: info.js, settings.js and the
 * variable explorer each had their own copy, none of which escaped `'`. That is
 * safe only for as long as every attribute in every template stays
 * double-quoted - an invariant spread across three files and enforced by
 * nobody. The apostrophe is escaped here so the invariant is not needed.
 *
 * This is defence in depth rather than the defence. The strings that reach
 * these templates include repr() output from the kernel and error text from
 * package resolution, and the webview can reach os.* and filesystem.* through
 * Neutralino, so one missed interpolation is arbitrary command execution rather
 * than a broken layout. Where the data is genuinely untrusted, build nodes and
 * set textContent instead of escaping into innerHTML - see vars/explorer.js.
 */
export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
