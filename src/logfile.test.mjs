// node --test src/logfile.test.mjs
//
// The bug these exist for was not a crash. initLog() read the whole log and
// wrote it back with its own new lines appended, so two instances starting near
// each other each held a copy and whichever wrote last silently discarded the
// other's lines. Measured on one machine: of fifteen launches, four looked
// broken in the log and only one actually was.
//
// A log that lies is worse than no log, and it lies exactly when two things are
// happening at once - which is when anybody reads it. So the property under
// test is not "appending works", it is "a second writer cannot remove the
// first's lines", and that needs real files and real concurrency rather than a
// fake filesystem agreeing with itself.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { test } from "node:test";

import { append, rotate } from "./logfile.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * Neutralino's filesystem API, backed by real files.
 *
 * The same four calls log.js passes in, so what is exercised below is the code
 * that ships rather than a rehearsal of it.
 */
function realFilesystem() {
  return {
    getStats: async (path) => ({ size: (await fs.stat(path)).size }),
    remove: (path) => fs.rm(path, { recursive: true }),
    move: (from, to) => fs.rename(from, to),
    appendFile: (path, data) => fs.appendFile(path, data),
  };
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "logfile-"));
}

test("append adds to the file and never removes what is there", async () => {
  const dir = scratch();
  const path = join(dir, "app.log");
  writeFileSync(path, "existing line\n");

  assert.equal(await append(realFilesystem(), path, "new line\n"), true);
  assert.equal(readFileSync(path, "utf8"), "existing line\nnew line\n");
  rmSync(dir, { recursive: true });
});

test("append reports failure rather than throwing", async () => {
  // A directory where a file should be: the write cannot succeed, and logging
  // must not be able to break its caller.
  const dir = scratch();
  assert.equal(await append(realFilesystem(), dir, "text\n"), false);
  rmSync(dir, { recursive: true });
});

test("an empty append does nothing at all", async () => {
  const dir = scratch();
  const path = join(dir, "app.log");
  writeFileSync(path, "kept\n");
  assert.equal(await append(realFilesystem(), path, ""), true);
  assert.equal(readFileSync(path, "utf8"), "kept\n");
  rmSync(dir, { recursive: true });
});

test("rotate leaves a small file alone", async () => {
  const dir = scratch();
  const path = join(dir, "app.log");
  writeFileSync(path, "x".repeat(100));

  assert.equal(await rotate(realFilesystem(), path, 1000), false);
  assert.equal(statSync(path).size, 100, "the live log must be untouched");
  rmSync(dir, { recursive: true });
});

test("rotate moves a large file aside instead of emptying it", async () => {
  const dir = scratch();
  const path = join(dir, "app.log");
  writeFileSync(path, "y".repeat(2000));

  assert.equal(await rotate(realFilesystem(), path, 1000), true);
  // The interesting session is kept, not deleted - which is the whole
  // difference from the truncation this replaced.
  assert.equal(readFileSync(`${path}.1`, "utf8").length, 2000);
  assert.throws(() => statSync(path), "the live log starts fresh");
  rmSync(dir, { recursive: true });
});

test("rotate replaces an older rotation rather than accumulating", async () => {
  const dir = scratch();
  const path = join(dir, "app.log");
  writeFileSync(`${path}.1`, "older");
  writeFileSync(path, "z".repeat(2000));

  await rotate(realFilesystem(), path, 1000);
  assert.equal(readFileSync(`${path}.1`, "utf8"), "z".repeat(2000));
  rmSync(dir, { recursive: true });
});

test("rotate on a missing file is not an error", async () => {
  const dir = scratch();
  assert.equal(await rotate(realFilesystem(), join(dir, "absent.log"), 10), false);
  rmSync(dir, { recursive: true });
});

test("two processes appending keep every line", async () => {
  // The actual bug, reproduced the only way it can be: two real processes, one
  // real file. The previous implementation read the file and wrote it back, so
  // whichever finished last replaced the other's work entirely.
  const dir = scratch();
  const path = join(dir, "app.log");
  const LINES = 200;

  const writer = (id) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import { append } from ${JSON.stringify(join(HERE, "logfile.js"))};
          import * as fs from "node:fs/promises";
          const filesystem = { appendFile: (p, d) => fs.appendFile(p, d) };
          for (let i = 0; i < ${LINES}; i += 1) {
            await append(filesystem, ${JSON.stringify(path)}, "${id} line " + i + "\\n");
          }
          `,
        ],
        { stdio: "ignore" },
      );
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      child.on("error", reject);
    });

  await Promise.all([writer("A"), writer("B")]);

  const written = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  const fromA = written.filter((l) => l.startsWith("A ")).length;
  const fromB = written.filter((l) => l.startsWith("B ")).length;

  assert.equal(fromA, LINES, `A lost ${LINES - fromA} lines to B`);
  assert.equal(fromB, LINES, `B lost ${LINES - fromB} lines to A`);
  // And no line was mangled by an interleaved write.
  for (const line of written) {
    assert.match(line, /^[AB] line \d+$/, `a line was torn: ${JSON.stringify(line)}`);
  }
  rmSync(dir, { recursive: true });
});
