import { clipboard } from "@neutralinojs/lib";
import { version as threeCadViewerVersion } from "three-cad-viewer";

import { appVersion, monacoVersion, xtermVersion } from "./versions.js";
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
  return { label, value: value === undefined || value === null ? "unknown" : String(value) };
}

async function gather() {
  const sections = [];

  const pending = ipc.isConnected() ? ipc.once("app.info") : null;
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
      row("Platform", `${NL_OS} ${typeof NL_ARCH === "string" ? NL_ARCH : ""}`.trim()),
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

  let info = null;
  if (pending !== null) {
    // The sidecar may still be starting; do not hang the dialog on it.
    info = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
  }

  sections.push({
    title: "Python environment",
    note:
      "Delete this folder to force a clean rebuild on the next start. " +
      "It is not removed when the application is deleted.",
    rows: [
      row("Location", envRoot),
      row("Python", info?.info ? `${info.info.python} (${info.info.implementation})` : "starting…"),
      row("Kernel connection file", info?.info?.connectionFile ?? "starting…"),
      // Beside the environment rather than inside it, so it survives the clean
      // rebuild the note above describes - the log of the run that went wrong is
      // exactly what is wanted after deleting the environment.
      row("Log", log.logPath() ?? "not started"),
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

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

  // Clicking the backdrop closes; clicking inside must not.
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });
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
