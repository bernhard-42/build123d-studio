// Take the activation, then give it straight back.
//
// Loaded only by reactivate.html, which is a second process of this same
// binary. Exiting is the entire point: the window this one steals the
// foreground from is the application's, and Windows hands the foreground back
// when this process goes, which is the WM_ACTIVATE the WebView needs.
//
// Nothing here may touch the application's state. It shares the binary, not the
// session - no settings, no journal, no snippets.

Neutralino.init();
Neutralino.events.on("ready", () => Neutralino.app.exit());

// A window that failed to reach "ready" would otherwise sit off-screen for
// ever, holding a process nobody can see.
setTimeout(() => Neutralino.app.exit(), 4000);
