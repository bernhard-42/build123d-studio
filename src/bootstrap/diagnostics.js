import { computer, os } from "@neutralinojs/lib";

import { formatBytes, selectEnvironment } from "./startupfacts.js";
import { appendLog } from "./splash.js";
import { run } from "../proc.js";
import { appVersion } from "../versions.js";
import * as log from "../log.js";

// What the machine is, written to the log at every start.
//
// A failure on somebody else's computer arrives as a screenshot of the splash
// and, with luck, the log file. Everything a diagnosis then needs to ask -
// which Windows, which webview, how much memory, is there a proxy, where is
// AppData, is an x64 build running under emulation - is answered here before
// the bootstrap runs, so the answer is in the file whether or not the person
// reporting knew to look.
//
// Every call is fenced on its own: a machine where one of them fails is exactly
// the machine the rest of the report is for.

async function report(label, gather) {
  try {
    log.info(`${label}:`, await gather());
  } catch (error) {
    log.warn(`${label}: unavailable -`, error?.message ?? error);
  }
}

export async function logStartupFacts() {
  const started = performance.now();

  await report("app", () => ({
    version: appVersion,
    neutralino: typeof NL_VERSION === "string" ? NL_VERSION : "?",
    client: typeof NL_CVERSION === "string" ? NL_CVERSION : "?",
    os: NL_OS,
    arch: typeof NL_ARCH === "string" ? NL_ARCH : "?",
    // Names the webview and its version - WebView2, WebKitGTK or WKWebView.
    userAgent: navigator.userAgent,
    language: navigator.language,
  }));
  await report("os", () => computer.getOSInfo());
  await report("kernel", () => computer.getKernelInfo());
  await report("cpu", async () => {
    const info = await computer.getCPUInfo();
    return {
      model: info.model,
      architecture: info.architecture,
      logicalThreads: info.logicalThreads,
    };
  });
  await report("memory", async () => {
    const { physical } = await computer.getMemoryInfo();
    return { total: formatBytes(physical.total), available: formatBytes(physical.available) };
  });
  await report("disks", async () => {
    const disks = await computer.getDisks();
    return disks.map((disk) => ({
      mountPoint: disk.mountPoint,
      free: formatBytes(disk.free),
      total: formatBytes(disk.total),
    }));
  });

  // One line per variable rather than one object: the Backend pane shows an
  // entry per line and PATH alone would make the line unreadable.
  try {
    const selected = selectEnvironment(await os.getEnvs());
    for (const [name, value] of selected) {
      log.info(`env: ${name}=${value}`);
    }
  } catch (error) {
    log.warn("env: unavailable -", error?.message ?? error);
  }

  if (NL_OS === "Windows") {
    await describeShell();
  }

  log.info(`startup facts took ${Math.round(performance.now() - started)} ms`);
}

/**
 * Whether cmd.exe runs a command without saying anything of its own.
 *
 * Neutralino hands every command to `cmd.exe /c`, and cmd runs its AutoRun
 * value first, every time. One naming a script that no longer exists makes cmd
 * print "The system cannot find the path specified" before every command this
 * application runs - and, without the suffix shellCommandFor adds, report the
 * command as failed. The application works regardless now; this says why the
 * line is there, in words for somebody who has never opened the registry, and
 * then where it comes from for somebody who has.
 */
async function describeShell() {
  const said = [];
  const code = await run("echo cmd-probe", { onLine: (line) => said.push(line) });
  const noise = said.filter((line) => line.trim() !== "cmd-probe");
  if (code === 0 && noise.length === 0) {
    log.info("cmd.exe: runs a command cleanly");
    return;
  }
  const detail = noise.length === 0 ? `exit ${code}` : noise.join(" | ");
  log.warn(`cmd.exe says something of its own before every command: ${detail}`);
  appendLog("");
  appendLog("Note: the Windows command prompt (cmd.exe) on this computer reports an error whenever it starts:");
  appendLog(`    ${detail}`);
  appendLog(
    "build123d Studio works around it, so you can ignore this. The cause is a leftover from a " +
      "program that was removed or moved (often Anaconda): a registry value named AutoRun under " +
      "HKCU\\Software\\Microsoft\\Command Processor (or HKLM) still points at its script. " +
      "Deleting that value removes the error for every program.",
  );
}
