import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitAnswers } from "../bench/run.mjs";
import { installIndex, makeBook, withData } from "./update-helpers.mjs";

const BENCH = join(import.meta.dirname, "..", "bench", "run.mjs");
const SERVER = join(import.meta.dirname, "..", "src", "server.mjs");
const bench = (dir, ...extra) => spawnSync(process.execPath, [BENCH, ...extra, "--server", process.execPath, SERVER],
  { env: { ...process.env, MQL5_DOCS_DATA: dir }, encoding: "utf8" });

test("bench: a card whose code has a blank line stays one answer", () => {
  const card = "= OrderSend · function · mql5/ordersend\nbool OrderSend(\n\n   MqlTradeRequest& request);";
  const reply = ["MQL5 docs downloaded 2026-10-01 · index abc1234", card,
    "~ price · no exact name; best match: SymbolInfoDouble · mql5/symbolinfodouble",
    "none · zzz · nothing matched; rephrase, or check mql5.com", "(2 more queries skipped: a, b)"].join("\n\n");
  const blocks = splitAnswers(reply);
  assert.equal(blocks[0], card);
  assert.deepEqual(blocks.slice(1).map((block) => block.split(" · ")[0]), ["~ price", "none", "(2 more queries skipped: a, b)"]);
});

test("bench: a server without an index stops the run instead of passing the absent cases", async () => {
  await withData(async (dir) => {
    const result = bench(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /the server did not answer: No MQL5 docs index is installed/);
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
    const json = join(dir, "runs.json");
    const result = bench(dir, "--json", json);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /: \d+\/103 complete, rank 1 \d+, top 3 \d+, \d+ calls in sequence/);
    const { cases } = JSON.parse(readFileSync(json, "utf8"));
    const ranked = cases.filter((c) => c.rank >= 1 && c.rank <= 3).length;
    assert.ok(cases.some((c) => c.rank === 0), "the run has absent or ambiguous cases");
    assert.match(result.stdout, new RegExp(`: \\d+/103 complete, rank 1 \\d+, top 3 ${ranked},`), "cases without a rank are not in the top 3");
    assert.match(result.stdout, /3 fresh starts: initialize \d+-\d+ ms/);
    // The fixture pages are not the real docs, so most facts are missing; the
    // run still names OrderSend first and passes an absent name.
    assert.match(result.stdout, /\n {2}exact-OrderSend: .* \d+ calls \d+ chars rank 1\n/);
    assert.match(result.stdout, /\nH absent-zzzz_nonexistent_7391: complete 1 calls/);
  });
});
