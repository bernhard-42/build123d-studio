import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import * as ipc from "../ipc.js";
import { onPaneResize } from "../layout/splitter.js";
import { onThemeChange } from "../theme.js";

// The console pane is a real terminal attached to a real `jupyter console`.
// Nothing is interpreted here - keystrokes go to the pty, bytes come back and
// are written verbatim. That is what makes it feel like IPython rather than a
// REPL widget: line editing, history search, completion menus and magics are
// all handled by prompt_toolkit on the other side.
//
// Both directions are binary WebSocket frames, so the hottest path in the UI
// carries no base64 and no JSON escaping.

let terminal = null;
let fitAddon = null;

const encoder = new TextEncoder();

function sendSize() {
  if (terminal === null || !ipc.isConnected()) {
    return;
  }
  try {
    ipc.send("console.resize", { columns: terminal.cols, rows: terminal.rows });
  } catch {
    // Sidecar not up yet; the next resize will carry the size.
  }
}

export function initConsole() {
  terminal = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    // The transcript is the session history, so keep plenty of it.
    scrollback: 10000,
  });

  // xterm keeps its palette in options, so the theme is pushed rather than
  // inherited from CSS. Only the base colours change - the ANSI palette the
  // kernel's tracebacks use stays legible on both backgrounds.
  onThemeChange((theme) => {
    terminal.options.theme =
      theme === "light"
        ? { background: "#ffffff", foreground: "#1f1f1f", cursor: "#1f1f1f",
            selectionBackground: "#c8dcf0" }
        : { background: "#252526", foreground: "#d4d4d4", cursor: "#d4d4d4",
            selectionBackground: "#264f78" };
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(document.getElementById("pane-console"));
  fitAddon.fit();

  // Starting `jupyter console` takes a couple of seconds - IPython's own import
  // plus connecting to the kernel - during which the pty produces nothing at
  // all. An empty black pane in a window where everything else is already alive
  // reads as broken, so say what is happening.
  terminal.write("\x1b[2mInitializing console…\x1b[0m\r\n");

  terminal.onData((data) => {
    ipc.sendBinary(ipc.KIND_CONSOLE, encoder.encode(data));
  });

  // xterm.js takes a Uint8Array directly and decodes UTF-8 itself, including
  // sequences split across frames.
  let firstOutput = true;
  ipc.onBinary(ipc.KIND_CONSOLE, (payload) => {
    if (firstOutput) {
      firstOutput = false;
      // Drop the placeholder so the transcript starts at the real banner
      // rather than below a stale status line.
      terminal.reset();
    }
    terminal.write(payload);
  });

  // A restart replaces the console process, so the pane is brought up the same
  // way it is at startup: cleared, then sized, then given the new banner. The
  // old transcript goes because its In[n] numbering is about to restart at 1
  // and the namespace behind it is gone.
  //
  // Clearing here rather than when the replacement first speaks keeps it
  // deterministic - the pane is empty for exactly as long as there is no
  // console, and the modal is over it for that whole time.
  ipc.on("kernel.restarting", () => {
    terminal.reset();
  });

  // A replacement backend brings a new console with its own In[n] counting from
  // one. Keeping the old transcript above it would read as one session; and
  // firstOutput has long since been consumed, so without this the new banner
  // would simply be appended to a dead conversation.
  ipc.on("sidecar.restarting", () => {
    terminal.reset();
    terminal.write("\x1b[2mRestarting the Python backend…\x1b[0m\r\n");
    firstOutput = true;
  });

  ipc.on("kernel.restarted", () => {
    // Same two steps as startup: the pty has to know the pane's size before the
    // new banner is drawn, or the first prompt wraps at the wrong column.
    sendSize();
    terminal.focus();
  });

  ipc.on("console.exit", () => {
    terminal.write("\r\n\x1b[31m[console exited]\x1b[0m\r\n");
  });

  onPaneResize(() => {
    fitAddon.fit();
    sendSize();
  });

  return {
    focus: () => terminal.focus(),
    // The initial size has to reach the pty before the banner is drawn, or the
    // first prompt wraps at the wrong column.
    syncSize: sendSize,
  };
}
