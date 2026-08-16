import { clipboard, filesystem } from "@neutralinojs/lib";
import { version as threeCadViewerVersion } from "three-cad-viewer";

import { appVersion, monacoVersion, xtermVersion } from "./versions.js";
import { escapeHtml } from "./escape.js";
import { closeOnBackdropClick } from "./backdrop.js";
import { resolveEnvRoot } from "./bootstrap/envroot.js";
import { ensureUv } from "./bootstrap/uv.js";
import { run, quote } from "./proc.js";
import * as ipc from "./ipc.js";
import * as log from "./log.js";

// The About dialog.
//
// Two audiences: someone wondering which build123d they are on, and someone
// writing a bug report - hence Copy, which yields the whole thing as plain
// text. Everything is gathered when the dialog opens rather than at startup, so
// it costs nothing until asked for.

let uvVersionCache = null;

/**
 * The log files, current and rotated, and what else writes into them.
 *
 * The rotated one is only named when it is actually there. A path to a file
 * that does not exist reads as "here is your other log" and sends someone
 * looking for something that was never written.
 */
async function logRows() {
  const current = log.logPath();
  if (current === null) {
    return [row("Log", "not started")];
  }

  // Three files, three subjects, and a support request usually wants more than
  // the first: this application's own account, what the browser and the
  // libraries inside it printed, and what the measurement backend said. Each is
  // named only when it exists, for the same reason the rotated one is - a path
  // to a file nobody wrote sends the reader looking for it.
  const rows = [row("Log", current)];
  for (const [label, path] of [
    ["Browser console", log.consolePath()],
    ["Measurement backend", log.backendPath()],
  ]) {
    if (path === null) {
      continue;
    }
    try {
      await filesystem.getStats(path);
      rows.push(row(label, path));
    } catch {
      // Nothing has been written to it in this installation.
    }
  }

  const previous = `${current}.1`;
  try {
    await filesystem.getStats(previous);
    rows.push(row("Previous log", previous));
  } catch {
    // Never rotated, which is the common case.
  }
  return rows;
}

async function uvVersion() {
  if (uvVersionCache !== null) {
    return uvVersionCache;
  }
  let output = "";
  try {
    const { path: envRoot } = await resolveEnvRoot();
    await run(`${quote(await ensureUv(envRoot))} --version`, {
      onLine: (line) => {
        output = output === "" ? line.trim() : output;
      },
    });
  } catch (error) {
    log.warn("Could not read the uv version:", error);
  }
  uvVersionCache = output === "" ? "unknown" : output.replace(/^uv\s+/, "");
  return uvVersionCache;
}

function row(label, value) {
  return {
    label,
    value: value === undefined || value === null ? "unknown" : String(value),
  };
}

// How long the About dialog waits for the sidecar's answer. Long enough for a
// backend that is merely busy, short enough that the dialog opens promptly when
// there is no backend at all.
const INFO_TIMEOUT = 4000;

async function gather() {
  const sections = [];

  // The wait is bounded where the subscription lives, so a sidecar that never
  // answers releases the listener rather than only the waiting. See ipc.once.
  const pending = ipc.isConnected()
    ? ipc.once("app.info", { timeout: INFO_TIMEOUT })
    : null;
  if (pending !== null) {
    try {
      ipc.send("app.info");
    } catch {
      // Fall through; the Python section is simply omitted.
    }
  }

  sections.push({
    title: "Application",
    rows: [
      row("build123d_studio", appVersion),
      row(
        "Platform",
        `${NL_OS} ${typeof NL_ARCH === "string" ? NL_ARCH : ""}`.trim(),
      ),
      row(
        "Neutralino",
        `${typeof NL_VERSION === "string" ? NL_VERSION : "?"} (client ${
          typeof NL_CVERSION === "string" ? NL_CVERSION : "?"
        })`,
      ),
      row("Monaco editor", monacoVersion),
      row("three-cad-viewer", threeCadViewerVersion),
      row("xterm.js", xtermVersion),
      row("uv", await uvVersion()),
    ],
  });

  const { path: envRoot } = await resolveEnvRoot();

  // The sidecar may still be starting; the dialog does not hang on it, and the
  // rows below say "starting…" when it did not answer.
  const info = pending === null ? null : await pending;

  sections.push({
    title: "Python environment",
    note:
      "Delete this folder to force a clean rebuild on the next start. " +
      "It is not removed when the application is deleted.",
    rows: [
      row("Location", envRoot),
      row(
        "Python",
        info?.info
          ? `${info.info.python} (${info.info.implementation})`
          : "starting…",
      ),
      row("Kernel connection file", info?.info?.connectionFile ?? "starting…"),
      // Beside the environment rather than inside it, so they survive the clean
      // rebuild the note above describes - the log of the run that went wrong is
      // exactly what is wanted after deleting the environment.
      //
      // Both of them, because a bug report usually wants the one from *before*
      // the restart that made the problem obvious, and until now the dialog
      // named only the current file. The sidecar and the kernel do not have
      // logs of their own: their stderr is timestamped into this same file,
      // which is said out loud so nobody goes looking for a third one.
      ...(await logRows()),
    ],
  });

  if (info?.info?.packages) {
    // The short list first, under the names people actually say out loud. It
    // repeats a dozen rows from the full list below, which is the point: the
    // versions that matter for a bug report should not have to be hunted for in
    // ninety alphabetised lines, and OCP is not filed under "O".
    sections.push({
      title: "Key packages",
      rows: info.info.packages.map((p) => row(p.name, p.version)),
    });
  } else {
    sections.push({
      title: "Key packages",
      rows: [row("", "The Python sidecar is not ready yet.")],
    });
  }

  if (info?.info?.allPackages) {
    const all = info.info.allPackages;
    sections.push({
      title: `All installed packages (${all.length})`,
      rows: all.map((p) => row(p.name, p.version)),
    });
  }

  return sections;
}

function asPlainText(sections) {
  const width = Math.max(
    ...sections.flatMap((s) => s.rows.map((r) => r.label.length)),
  );
  return sections
    .map((section) => {
      const rows = section.rows
        .map((r) => `  ${r.label.padEnd(width)}  ${r.value}`)
        .join("\n");
      return `${section.title}\n${rows}`;
    })
    .join("\n\n");
}

function render(sections) {
  return sections
    .map((section) => {
      const rows = section.rows
        .map(
          (r) =>
            `<tr><td class="info-label">${escapeHtml(r.label)}</td>` +
            `<td class="info-value">${escapeHtml(r.value)}</td></tr>`,
        )
        .join("");
      const note =
        section.note === undefined
          ? ""
          : `<p class="info-note">${escapeHtml(section.note)}</p>`;
      return `<h2 class="info-heading">${escapeHtml(section.title)}</h2>${note}<table class="info-table">${rows}</table>`;
    })
    .join("");
}

function close() {
  document.getElementById("info-dialog")?.remove();
  document.removeEventListener("keydown", onKeyDown);
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    close();
  }
}

export async function showInfo() {
  close();

  const overlay = document.createElement("div");
  overlay.id = "info-dialog";
  overlay.className = "info-overlay";
  overlay.innerHTML = `
    <div class="info-panel" role="dialog" aria-label="About build123d Studio">
      <div class="info-header">
        <span class="info-title">About build123d Studio</span>
        <button class="btn" id="info-copy" title="Copy to clipboard">
          <span class="icon icon-copy"></span>
        </button>
        <button class="btn" id="info-close" title="Close">
          <span class="icon icon-close"></span>
        </button>
      </div>
      <div class="info-body" id="info-body">Collecting…</div>
    </div>`;
  document.body.appendChild(overlay);

  // Clicking the backdrop closes; clicking inside must not - and neither must
  // dragging a selection across the two, which is what this pane is for.
  closeOnBackdropClick(overlay, close);
  document.getElementById("info-close").addEventListener("click", close);
  document.addEventListener("keydown", onKeyDown);

  const sections = await gather();
  document.getElementById("info-body").innerHTML = render(sections);

  document.getElementById("info-copy").addEventListener("click", async () => {
    try {
      await clipboard.writeText(asPlainText(sections));
      const button = document.getElementById("info-copy");
      button.classList.add("copied");
      setTimeout(() => button.classList.remove("copied"), 1200);
    } catch (error) {
      log.warn("Could not copy to the clipboard:", error);
    }
  });
}
