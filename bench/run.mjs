// npm run bench: scores MCP servers on bench/cases.json with one fixed client
// script (DESIGN.md section 13). It looks a case up, then reads the top three
// candidates in order, following their next pages, until the case is complete
// or 6 calls were made, counting calls and the characters of plain text.
//   npm run bench                         v2 (this checkout) and the installed 1.3.18
//   npm run bench -- --server <cmd> [args...]   one server
//   add --json <file> to save every case's result
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isEntry } from "../src/data.mjs";

const MAX_CALLS = 6;
const CASES = JSON.parse(readFileSync(join(import.meta.dirname, "cases.json"), "utf8")).cases;
const OLD_ROOT = join(process.env.LOCALAPPDATA ?? "", "MQL5-CHM-MCP", "1.3.18", "mql5-chm-mcp-windows-x64");
const normalize = (text) => text.replace(/\s+/g, " ");
const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

// The answer blocks of an mql5_find reply, in query order. Answers are joined
// by blank lines, but a card's code can hold blank lines too, so a block
// starts only where the next line is an outcome line (or the skipped-query
// notice ends the reply).
export function splitAnswers(reply) {
  return reply.split(/\n\n(?=(?:= |~ |none · |\(\d+ more queries skipped))/).slice(1);
}

// v2: one mql5_find call answers every query. A block's candidates are the
// pages its outcome line and its "Also named" or "Other pages" line name (not
// See also links inside a card); its text belongs to the first one.
function v2Player(call) {
  const ids = (text) => [...new Set(text.match(/\b(?:mql5|book|nn)\/[a-z0-9_.-]+/g) ?? [])];
  return {
    async lookup(queries) {
      const reply = await call("mql5_find", { queries });
      // An error (no index, a damaged one) must not pass as "nothing found".
      if (!reply.startsWith("MQL5 docs downloaded ")) throw new Error(`v2 did not answer: ${reply.split("\n")[0]}`);
      const blocks = splitAnswers(reply);
      return queries.map((_, i) => {
        const block = blocks[i] ?? "";
        const [outcome, ...lines] = block.split("\n");
        const candidates = ids([outcome, ...lines.filter((line) => /^(Also named|Other pages)/.test(line))].join("\n"));
        return { exact: block.startsWith("="), candidates, texts: candidates.length ? { [candidates[0]]: block } : {} };
      });
    },
    async *read(page) {
      for (let number = 1; ; number++) {
        const text = await call("mql5_read", { id: page, page: number });
        yield text;
        if (!/\nnext: mql5_read /.test(text)) return;
      }
    },
  };
}

// 1.3.18's active index (data/active.json names it), read-only: its topic
// ids map to page ids through it, and its CHM hashes say which docs it holds.
const OLD_SOURCES = { mql5: "mql5", mql5book: "book", neuronetworksbook: "nn" };
function oldIndex() {
  const { active_revision: revision } = JSON.parse(readFileSync(join(OLD_ROOT, "data", "active.json"), "utf8"));
  return new DatabaseSync(join(OLD_ROOT, "revisions", revision, "mql5-docs.sqlite"), { readOnly: true });
}

// 1.3.18 (deleted after the switch): names through lookup_identifiers, other
// queries through search (with its default expansion), reads through
// mql5_chm_read and its next_cursor. It is given the benefit of the doubt:
// its cursor (in structured data only) is followed, but only its plain text
// is counted.
function oldPlayer(call, callRaw) {
  const db = oldIndex();
  const pages = new Map(db.prepare("select topic_id, source, internal_path from topics").all()
    .map((row) => [row.topic_id, `${OLD_SOURCES[row.source]}/${row.internal_path.replace(/\.html?$/i, "").toLowerCase()}`]));
  db.close();
  const topicsIn = (text) => [...new Set(text.match(/\b(?:mql5|mql5book|neuronetworksbook):[0-9a-f]{24}/g) ?? [])];
  const toPages = (topics) => [...new Set(topics.map((topic) => pages.get(topic)).filter(Boolean))];
  const NAME = /^[A-Za-z_][\w:.()]*$/;
  return {
    async lookup(queries) {
      if (queries.every((query) => NAME.test(query))) {
        // Its lookup searches only the Reference unless asked for all books.
        const sections = (await call("mql5_chm_lookup_identifiers", { identifiers: queries, source: "all", limit: 3 })).split(/\n(?=\d+\. )/).slice(1);
        return queries.map((_, i) => {
          const section = sections[i] ?? "";
          return { exact: /^\d+\. \S.*\[exact\]/.test(section), candidates: toPages(topicsIn(section)), texts: {} };
        });
      }
      return Promise.all(queries.map(async (query) => {
        const results = (await call("mql5_chm_search", { query, limit: 3 })).split(/\n(?=\d+\. )/);
        const texts = {};
        for (const result of results) for (const page of toPages(topicsIn(result))) texts[page] = (texts[page] ?? "") + result;
        return { exact: /\[exact\]/.test(results[0] ?? ""), candidates: toPages(results.flatMap(topicsIn)), texts };
      }));
    },
    async *read(page) {
      const topic = [...pages].find(([, id]) => id === page)?.[0];
      let cursor;
      do {
        const result = await callRaw("mql5_chm_read", { topic_id: topic, include_related: false, include_images: false, ...(cursor ? { cursor } : {}) });
        yield textOf(result);
        cursor = result.structuredContent?.next_cursor;
      } while (cursor);
    },
  };
}

async function runCase(player, entry) {
  let calls = 0;
  const seen = {};
  const remember = (page, text) => {
    seen[page] = (seen[page] ?? "") + normalize(text);
  };
  const results = await player.lookup(entry.queries);
  calls += 1;
  results.forEach((result) => Object.entries(result.texts).forEach(([page, text]) => remember(page, text)));
  if (entry.kind === "absent") return { complete: !results[0].exact, calls, rank: 0 };
  // A name many classes share ("Create"): no single page is right; complete
  // when at least two of the pages with that title are named.
  if (entry.kind === "ambiguous") {
    return { complete: results[0].candidates.filter((page) => entry.pages.includes(page)).length >= 2, calls, rank: 0 };
  }
  const done = (expect, result) => result.candidates.includes(expect.page) && expect.facts.every((fact) => seen[expect.page]?.includes(normalize(fact)));
  for (const [i, expect] of entry.expect.entries()) {
    for (const page of results[i].candidates.slice(0, 3)) {
      if (done(expect, results[i]) || calls >= MAX_CALLS) break;
      for await (const text of player.read(page)) {
        calls += 1;
        remember(page, text);
        if (done(expect, results[i]) || calls >= MAX_CALLS) break;
      }
    }
  }
  const ranks = entry.expect.map((expect, i) => results[i].candidates.indexOf(expect.page) + 1);
  return { complete: entry.expect.every((expect, i) => done(expect, results[i])), calls, rank: Math.max(...ranks.map((rank) => rank || 99)) };
}

// Starts a server and returns the connected client with its start times.
async function start(command, args) {
  const started = performance.now();
  const client = new Client({ name: "mql5-docs-bench", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command, args, env: process.env, stderr: "ignore" }));
  const initialize = performance.now() - started;
  const { tools } = await client.listTools();
  return { client, tools, started, initialize, toolsList: performance.now() - started };
}

async function score(label, command, args) {
  const { client, tools, started, initialize, toolsList } = await start(command, args);
  let chars = 0;
  let firstComplete = 0;
  const times = { find: [], read: [] };
  const callRaw = async (name, args) => {
    const t0 = performance.now();
    // A tool error (1.3.18 rejects "OrderSend()" or "CTrade.Buy") is that
    // server's answer for the case: it names nothing.
    const result = await client.callTool({ name, arguments: args });
    times[/read/.test(name) ? "read" : "find"].push(performance.now() - t0);
    chars += textOf(result).length;
    return result;
  };
  const call = async (name, args) => textOf(await callRaw(name, args));
  const player = tools.some((tool) => tool.name === "mql5_find") ? v2Player(call) : oldPlayer(call, callRaw);
  const cases = [];
  for (const entry of CASES) {
    const before = chars;
    const result = await runCase(player, entry);
    if (result.complete) firstComplete ||= performance.now() - started;
    cases.push({ id: entry.id, held_out: entry.held_out, ...result, chars: chars - before });
  }
  await client.close();
  return { label, cases, timing: { initialize, toolsList, firstComplete, find: median(times.find), read: median(times.read) } };
}

// Fresh starts of a server, each to its first answer, for the spread of start times.
async function startSpread(command, args, runs = 3) {
  const spread = { initialize: [], toolsList: [], firstAnswer: [] };
  for (let i = 0; i < runs; i++) {
    const { client, tools, started, initialize, toolsList } = await start(command, args);
    const v2 = tools.some((tool) => tool.name === "mql5_find");
    const result = await client.callTool({ name: v2 ? "mql5_find" : "mql5_chm_lookup_identifiers",
      arguments: v2 ? { queries: ["OrderSend"] } : { identifiers: ["OrderSend"], limit: 3 } });
    // A server that can't look up OrderSend is not usable for the benchmark.
    if (result.isError || !/OrderSend/.test(textOf(result))) throw new Error(`the server did not answer OrderSend: ${textOf(result).slice(0, 200)}`);
    spread.firstAnswer.push(performance.now() - started);
    spread.initialize.push(initialize);
    spread.toolsList.push(toolsList);
    await client.close();
  }
  return spread;
}

function summary({ label, cases, timing, spread }) {
  const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);
  const range = (values) => `${Math.min(...values).toFixed(0)}-${Math.max(...values).toFixed(0)} ms`;
  // Each call waits for the one before it, so the rounds equal the calls.
  // Absent and ambiguous cases have rank 0: they count in neither rank total.
  const line = (list) => `${list.filter((c) => c.complete).length}/${list.length} complete, rank 1 ${list.filter((c) => c.rank === 1).length},`
    + ` top 3 ${list.filter((c) => c.rank >= 1 && c.rank <= 3).length}, ${sum(list, "calls")} calls in sequence, ${sum(list, "chars")} characters`
    + ` (about ${Math.round(sum(list, "chars") / 4)} tokens)`;
  return [`${label}: ${line(cases)}`, `  held out: ${line(cases.filter((c) => c.held_out))}`,
    `  ${spread.initialize.length} fresh starts: initialize ${range(spread.initialize)}, tools/list ${range(spread.toolsList)},`
    + ` first answer ${range(spread.firstAnswer)}`,
    `  scoring run: first complete case ${timing.firstComplete.toFixed(0)} ms after start; typical lookup ${timing.find.toFixed(0)} ms,`
    + ` read ${timing.read.toFixed(0)} ms`].join("\n");
}

// Both servers must hold the same docs, or the comparison would measure the docs.
function sameDocs() {
  const current = JSON.parse(readFileSync(join(process.env.MQL5_DOCS_DATA ?? join(process.env.LOCALAPPDATA ?? "", "mql5-docs-mcp", "data"),
    "current.json"), "utf8"));
  const db = oldIndex();
  const old = db.prepare("select source, chm_sha256 from sources").all();
  db.close();
  const different = old.filter((row) => current.chm?.[OLD_SOURCES[row.source]] !== row.chm_sha256).map((row) => row.source);
  if (different.length) throw new Error(`v2 and 1.3.18 hold different docs (${different.join(", ")}); run both on the same CHM files`);
}

async function main(args) {
  const jsonAt = args.indexOf("--json");
  const jsonFile = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
  const serverAt = args.indexOf("--server");
  const servers = serverAt >= 0
    ? [{ label: args[serverAt + 1], command: args[serverAt + 1], args: args.slice(serverAt + 2) }]
    : [{ label: "v2", command: process.execPath, args: [join(import.meta.dirname, "..", "src", "server.mjs")] },
      ...(existsSync(OLD_ROOT) ? [{ label: "1.3.18", command: join(OLD_ROOT, "runtime", "node.exe"), args: [join(OLD_ROOT, "app", "server.mjs")] }] : [])];
  if (servers.length === 2) sameDocs();
  const runs = [];
  for (const server of servers) {
    const run = await score(server.label, server.command, server.args);
    run.spread = await startSpread(server.command, server.args);
    runs.push(run);
    console.log(summary(run));
  }
  const mark = (c) => `${c.complete ? "complete" : "INCOMPLETE"} ${c.calls} calls ${c.chars} chars${c.rank && c.rank < 99 ? ` rank ${c.rank}` : ""}`;
  console.log("\nEvery case:");
  for (const [i, entry] of CASES.entries()) {
    console.log(`${entry.held_out ? "H " : "  "}${entry.id}: ${runs.map((run) => `${run.label} ${mark(run.cases[i])}`).join(" | ")}`);
  }
  if (runs.length === 2) {
    const [v2, old] = runs;
    const worse = v2.cases.filter((c, i) => old.cases[i].complete && !c.complete).map((c) => c.id);
    const better = v2.cases.filter((c, i) => !old.cases[i].complete && c.complete).map((c) => c.id);
    console.log(`\ncomplete in 1.3.18 but not in v2 (${worse.length}): ${worse.join(", ") || "none"}`);
    console.log(`complete in v2 but not in 1.3.18 (${better.length}): ${better.join(", ") || "none"}`);
  }
  if (jsonFile) writeFileSync(jsonFile, JSON.stringify(runs, null, 1));
}

if (isEntry(import.meta)) await main(process.argv.slice(2));
