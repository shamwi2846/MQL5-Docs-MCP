// The commands people run (test plan for src/cli.mjs): an update then status
// and find from the new index; and docs:update's exit code and untouched
// data when the update must not happen.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/cli.mjs";
import { openIndex, SCHEMA_VERSION } from "../src/data.mjs";
import { findText } from "../src/find.mjs";
import { baseline, files, installIndex, installWithExtras, makeBook, stubFetch, unpackOptions, withData } from "./update-helpers.mjs";

const CLI = join(import.meta.dirname, "..", "src", "cli.mjs");
let BOOK;
before(() => {
  BOOK = makeBook();
});
after(() => rmSync(BOOK, { recursive: true, force: true }));

// Runs a command in this process, collecting what it prints.
async function run(dir, args, update = {}) {
  const out = [];
  const err = [];
  const code = await runCommand(args[0], args.slice(1), {
    dir, log: (line) => out.push(line), warn: (line) => err.push(line),
    update: { fetchImpl: stubFetch(BOOK), unpackOptions, baseline, ...update },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// Runs the real command line as a separate process with its own folders.
function runProcess(dir, args) {
  const home = mkdtempSync(join(tmpdir(), "mql5-docs-home-"));
  try {
    return execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, MQL5_DOCS_DATA: dir, LOCALAPPDATA: home }, encoding: "utf8" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("cli: after docs:update, status and find use the new index", async () => {
  await withData(async (dir) => {
    installIndex(dir, "index-a.sqlite", [{ source: "mql5", dir: BOOK }]);
    const updated = await run(dir, ["docs:update"]);
    assert.equal(updated.code, 0, updated.err);
    const current = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
    assert.notEqual(current.index, "index-a.sqlite");

    const index = await openIndex(dir);
    const count = (sql) => index.db.prepare(sql).get().n;
    const status = runProcess(dir, ["docs:status"]).trimEnd().split("\n");
    assert.equal(status[0], `MQL5 docs downloaded ${current.downloaded} · index ${current.sha256.slice(0, 7)} (${current.index})`
      + ` · format ${SCHEMA_VERSION} · built by ${current.builder_version}`);
    assert.match(status[1], new RegExp(`mql5 ${count("select count(*) as n from pages where source = 'mql5'")}`));
    assert.equal(status[3], `names: ${count("select count(*) as n from names")}`);
    const queries = ["OrderSend", "how to send a trade request"];
    assert.equal(runProcess(dir, ["find", ...queries]), `${findText(index.db, queries, index)}\n`, "the same text as mql5_find");
    index.db.close();
  });
});

test("cli: docs:update exits 1 and changes nothing when the update must not happen", async () => {
  await withData(async (dir) => {
    installWithExtras(dir, BOOK, Array.from({ length: 6 }, (_, i) => `ExtraPage${i}`));
    const currentBefore = readFileSync(join(dir, "current.json"), "utf8");
    const unchanged = (label) => {
      assert.equal(readFileSync(join(dir, "current.json"), "utf8"), currentBefore, label);
      assert.deepEqual(files(dir), ["current.json", "index-a.sqlite"], label);
    };

    const loss = await run(dir, ["docs:update"]);
    assert.equal(loss.code, 1);
    assert.match(loss.err, /more than 2%\); run again with --accept-loss/);
    unchanged("unaccepted loss");

    const warning = { names: [{ name: "OrderSend", page: "mql5/ordersend", phrases: ["not a sign of successful execution"] }] };
    const required = await run(dir, ["docs:update", "--accept-loss"], { baseline: warning });
    assert.equal(required.code, 1);
    assert.match(required.err, /OrderSend: card lacks "not a sign of successful execution"/, "--accept-loss can't waive a required warning");
    unchanged("missing warning");

    const requested = [];
    const offHost = async (url) => {
      requested.push(String(url));
      if (String(url).includes("mql5book")) return new Response(null, { status: 302, headers: { location: "https://attacker.example/docs.chm" } });
      return stubFetch(BOOK)(url);
    };
    const redirected = await run(dir, ["docs:update", "--accept-loss"], { fetchImpl: offHost });
    assert.equal(redirected.code, 1);
    assert.match(redirected.err, /Refused download from https:\/\/attacker\.example\/docs\.chm/);
    assert.ok(!requested.some((url) => url.includes("attacker.example")));
    unchanged("off-host redirect");

    const current = JSON.parse(currentBefore);
    writeFileSync(join(dir, "current.json"), JSON.stringify({ ...current, schema_version: SCHEMA_VERSION + 1 }));
    let contacted = false;
    const other = await run(dir, ["docs:update", "--accept-loss"], { fetchImpl: async () => {
      contacted = true;
      throw new Error("no download expected");
    } });
    assert.equal(other.code, 1);
    assert.match(other.err, /run `npm run setup`/);
    assert.equal(contacted, false, "another format stops before downloading");
    assert.deepEqual(files(dir), ["current.json", "index-a.sqlite"]);

    const usage = await run(dir, ["docs:remove"]);
    assert.equal(usage.code, 2);
    assert.match(usage.err, /^Usage:/);
  });
});
