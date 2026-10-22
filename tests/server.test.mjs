import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openIndex, SCHEMA_VERSION } from "../src/data.mjs";
import { buildIndex } from "../src/indexer.mjs";

const SRC = join(import.meta.dirname, "..", "src");
const FIXTURES = join(import.meta.dirname, "fixtures", "mql5");

// Leaves a data folder the way a docs update does: an index file and
// current.json naming it with its hash.
function installIndex(dir, name = "index-20261021T120000000Z.sqlite") {
  buildIndex(join(dir, name), [{ source: "mql5", dir: FIXTURES }]);
  const sha256 = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  writeCurrent(dir, { index: name, sha256, schema_version: SCHEMA_VERSION, downloaded: "2026-10-21" });
  return sha256;
}
const writeCurrent = (dir, current) => writeFileSync(join(dir, "current.json"), JSON.stringify(current));

async function withDataDir(check) {
  const dir = mkdtempSync(join(tmpdir(), "mql5 docs data "));
  try {
    await check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withServer(dir, check) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(SRC, "server.mjs")], env: { ...process.env, MQL5_DOCS_DATA: dir }, stderr: "pipe",
  }));
  try {
    await check(client);
  } finally {
    await client.close();
  }
}

const textOf = (result) => {
  assert.equal(result.structuredContent, undefined, "plain text only");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
};

test("server: never loads the HTML parser, not even through shared code", () => {
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s+|\bimport\()\s*"([^"]+)"/g)) {
      if (specifier.startsWith("./")) visit(join(dirname(file), specifier));
      else reached.add(specifier);
    }
  };
  visit(join(SRC, "server.mjs"));
  assert.ok(reached.has(join(SRC, "find.mjs")), "the walk follows dynamic imports");
  assert.ok(!reached.has("cheerio") && !reached.has(join(SRC, "indexer.mjs")), [...reached].join(", "));
});

test("server: two read-only plain-text tools within the size limits", async () => {
  await withDataDir(async (dir) => withServer(dir, async (client) => {
    const list = await client.listTools();
    assert.deepEqual(list.tools.map((tool) => tool.name).sort(), ["mql5_find", "mql5_read"]);
    for (const tool of list.tools) {
      assert.equal(tool.outputSchema, undefined, tool.name);
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations.openWorldHint, false, tool.name);
    }
    const listSize = JSON.stringify(list).length;
    assert.ok(listSize <= 3000, `tools/list is ${listSize} characters`);
    const instructions = client.getInstructions();
    assert.ok(instructions.length <= 800, `instructions are ${instructions.length} characters`);
    assert.equal(client.getServerVersion().name, "mql5-docs");
  }));
});

test("server: both tools answer from the live index", async () => {
  await withDataDir(async (dir) => {
    const sha256 = installIndex(dir);
    await withServer(dir, async (client) => {
      const found = textOf(await client.callTool({ name: "mql5_find", arguments: { queries: ["OrderSend", "ordersend"] } }));
      assert.match(found, new RegExp(`^MQL5 docs downloaded 2026-10-21 · index ${sha256.slice(0, 7)}\n\n= OrderSend · function · mql5/ordersend\n`));
      assert.match(found, /\n\n= ordersend → spelling corrected to OrderSend · function · mql5\/ordersend \(shown above\)$/);
      const single = textOf(await client.callTool({ name: "mql5_find", arguments: { queries: "CopyRates" } }));
      assert.match(single, /\n\n= CopyRates · page · mql5\/copyrates\n/);
      const note = textOf(await client.callTool({ name: "mql5_read", arguments: { id: "mql5/ordersend", focus: "Note" } }));
      assert.deepEqual(note.split("\n").slice(1, 3), ["Note:", "Check the result structure after every call."]);
    });
  });
});

test("server: lists its tools without an index and answers once one is installed", async () => {
  await withDataDir(async (dir) => withServer(dir, async (client) => {
    assert.equal((await client.listTools()).tools.length, 2);
    const missing = textOf(await client.callTool({ name: "mql5_find", arguments: { queries: ["OrderSend"] } }));
    assert.equal(missing, "No MQL5 docs index is installed (data/current.json is missing, unreadable or damaged); run `npm run setup`.");
    installIndex(dir);
    const found = textOf(await client.callTool({ name: "mql5_find", arguments: { queries: ["OrderSend"] } }));
    assert.match(found, /^MQL5 docs downloaded 2026-10-21 · index [0-9a-f]{7}\n\n= OrderSend · function/, "the next call checks again");
  }));
});

test("server: refuses an index whose bytes changed, then answers once it is repaired", async () => {
  await withDataDir(async (dir) => {
    const damaged = "index-20261021T120000000Z.sqlite";
    installIndex(dir, damaged);
    const bytes = readFileSync(join(dir, damaged));
    bytes[bytes.length - 100] ^= 0xff;
    writeFileSync(join(dir, damaged), bytes);
    await withServer(dir, async (client) => {
      const refused = textOf(await client.callTool({ name: "mql5_find", arguments: { queries: ["OrderSend"] } }));
      assert.equal(refused, `The MQL5 docs index ${damaged} is damaged (its hash differs from data/current.json); run \`npm run docs:update\`.`);
      const sha256 = installIndex(dir, "index-20261021T130000000Z.sqlite");
      const found = textOf(await client.callTool({ name: "mql5_find", arguments: { queries: ["OrderSend"] } }));
      assert.match(found, new RegExp(`^MQL5 docs downloaded 2026-10-21 · index ${sha256.slice(0, 7)}\n\n= OrderSend · function`));
    });
  });
});

test("openIndex: a damaged, missing or other-format index says what to run", async () => {
  await withDataDir(async (dir) => {
    const sha256 = installIndex(dir, "index-a.sqlite");
    const current = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
    const index = await openIndex(dir);
    assert.equal(index.tag, sha256.slice(0, 7));
    assert.deepEqual(index.current, current, "the pointer the index was opened from, for docs:status");
    index.db.close();

    writeCurrent(dir, { ...current, sha256: "0".repeat(64) });
    assert.match((await openIndex(dir)).error, /index-a\.sqlite is damaged .*; run `npm run docs:update`\.$/);
    writeCurrent(dir, { ...current, index: "index-gone.sqlite" });
    assert.match((await openIndex(dir)).error, /index-gone\.sqlite is missing or unreadable; run `npm run docs:update`\.$/);
    writeCurrent(dir, { ...current, schema_version: 99 });
    assert.match((await openIndex(dir)).error, /has format 99; this server reads format 1; run `npm run setup`\.$/);
    writeCurrent(dir, { ...current, index: "../outside.sqlite" });
    assert.match((await openIndex(dir)).error, /names no valid index file; run `npm run setup`\.$/);
    // Damaged by hand: still one line with what to run, never a crash.
    writeCurrent(dir, { ...current, index: ["index-a.sqlite"] });
    assert.match((await openIndex(dir)).error, /names no valid index file; run `npm run setup`\.$/);
    writeCurrent(dir, null);
    assert.match((await openIndex(dir)).error, /^No MQL5 docs index is installed \(data\/current\.json is missing, unreadable or damaged\)/);
  });
});

test("npm run find prints what mql5_find returns", async () => {
  await withDataDir(async (dir) => {
    installIndex(dir);
    const output = execFileSync(process.execPath, [join(SRC, "cli.mjs"), "find", "OrderSnd", "CTrade.Buy"],
      { env: { ...process.env, MQL5_DOCS_DATA: dir }, encoding: "utf8" });
    const blocks = output.trimEnd().split("\n\n");
    assert.match(blocks[0], /^MQL5 docs downloaded 2026-10-21 · index [0-9a-f]{7}$/);
    assert.equal(blocks[1], "none · OrderSnd · did you mean: OrderSend (mql5/ordersend)?");
    assert.match(blocks[2], /^= CTrade\.Buy → read as CTrade::Buy · Buy · mql5\/ctradebuy/);
  });
});
