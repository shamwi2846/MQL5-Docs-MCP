import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { installIndex, makeBook, withData } from "./update-helpers.mjs";

const BENCH = join(import.meta.dirname, "..", "bench", "run.mjs");
const SERVER = join(import.meta.dirname, "..", "src", "server.mjs");
const bench = (dir) => spawnSync(process.execPath, [BENCH, "--server", process.execPath, SERVER],
  { env: { ...process.env, MQL5_DOCS_DATA: dir }, encoding: "utf8" });

test("bench: a server without an index stops the run instead of passing the absent cases", async () => {
  await withData(async (dir) => {
    const result = bench(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /v2 did not answer: No MQL5 docs index is installed/);
    assert.doesNotMatch(result.stdout, /complete/);
  });
});

test("bench: scores every case of a working server", async () => {
  await withData(async (dir) => {
    const book = makeBook();
    try {
      installIndex(dir, "index-a.sqlite", [{ source: "mql5", dir: book }]);
    } finally {
      // The index holds what it needs; the pages folder can go.
      await import("node:fs").then(({ rmSync }) => rmSync(book, { recursive: true, force: true }));
    }
    const result = bench(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /: \d+\/99 complete, rank 1 \d+, top 3 \d+, \d+ calls in sequence/);
    assert.match(result.stdout, /3 fresh starts: initialize \d+-\d+ ms/);
    // The fixture pages are not the real docs, so most facts are missing; the
    // run still names OrderSend first and passes an absent name.
    assert.match(result.stdout, /\n {2}exact-OrderSend: .* \d+ calls \d+ chars rank 1\n/);
    assert.match(result.stdout, /\nH absent-zzzz_nonexistent_7391: .* complete 1 calls/);
  });
});
