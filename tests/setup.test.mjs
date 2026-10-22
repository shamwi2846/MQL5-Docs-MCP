// Risky step: setup changes both clients' configuration and deletes app
// folders. Test plan (crosscheck): install then default uninstall keep the
// docs and other installations; a foreign entry stops setup before any
// change; a failed second registration, and a failed switch, put both old
// entries back exactly; a rollback that can't finish keeps what is still
// referenced, and setup again repairs it. Stand-in claude and codex programs
// keep their entries in a JSON file; downloads and hh.exe are stand-ins as
// in the update tests. The real clients are never touched.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { readCurrent, SCHEMA_VERSION, VERSION } from "../src/data.mjs";
import { appRoot, CLIENTS, setup, uninstall } from "../src/setup.mjs";
import { baseline, damageIndex, files, installIndex, makeBook, stubFetch, unpackOptions, withData } from "./update-helpers.mjs";

const FAKE_CLIENT = join(import.meta.dirname, "fake-client.mjs");
let BOOK;
before(() => {
  BOOK = makeBook();
});
after(() => rmSync(BOOK, { recursive: true, force: true }));

// <root>/data is the data folder, so app folders go to <root>/app. The
// sandbox root (from withData) has spaces in its path.
function sandbox(root) {
  const dir = join(root, "data");
  const registry = join(root, "clients.json");
  const clients = Object.fromEntries(["claude", "codex"].map((name) =>
    [name, (args) => spawnSync(process.execPath, [FAKE_CLIENT, registry, name, ...args], { encoding: "utf8" })]));
  const read = () => (existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")) : {});
  return {
    dir,
    clients,
    entry: (client) => read()[client]?.["mql5-docs"],
    registry: read,
    seed: (value) => writeFileSync(registry, JSON.stringify(value)),
    apps: () => (existsSync(appRoot(dir)) ? readdirSync(appRoot(dir)).sort() : []),
    run: (extra = {}) => setup({ dir, clients, log: () => {}, build: { fetchImpl: stubFetch(BOOK), unpackOptions, baseline }, ...extra }),
  };
}

// An existing v2 app folder with a server.mjs (its content doesn't matter here).
function oldApp(dir, name) {
  const server = join(appRoot(dir), name, "src", "server.mjs");
  mkdirSync(join(server, ".."), { recursive: true });
  writeFileSync(server, "// old version");
  return server;
}

// Two existing v2 entries with different settings, and an index built by an
// older version (so setup rebuilds it).
function seedOldInstall(box) {
  mkdirSync(box.dir, { recursive: true });
  const live = installIndex(box.dir, "index-a.sqlite", [{ source: "mql5", dir: BOOK }], { builder_version: "0.0.1" });
  const claude = { scope: "local", command: "C:\\Old Node\\node.exe", args: [oldApp(box.dir, "0.0.9-claude")], env: { DEBUG: "1" } };
  const codex = { scope: null, command: "C:\\Other Node\\node.exe", args: [oldApp(box.dir, "0.0.9-codex")], env: { MODE: "a b" } };
  return { live, claude, codex, current: readFileSync(join(box.dir, "current.json")), index: readFileSync(join(box.dir, live.index)) };
}

test("setup installs for both clients; uninstall keeps the docs and other installations", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const other = { scope: "user", command: "C:\\Old\\node.exe", args: ["C:\\MQL5-CHM-MCP\\1.3.18\\server.mjs"], env: {} };
    box.seed({ claude: { "mql5-chm": other }, codex: { "mql5-chm": other } });
    const oldInstall = join(root, "MQL5-CHM-MCP", "1.3.18");
    mkdirSync(oldInstall, { recursive: true });
    writeFileSync(join(oldInstall, "server.mjs"), "// 1.3.18");

    await box.run();
    const [app] = box.apps();
    const server = join(appRoot(box.dir), app, "src", "server.mjs");
    for (const client of ["claude", "codex"]) {
      assert.deepEqual(box.entry(client).args, [server], client);
      assert.equal(box.entry(client).command, process.execPath, client);
      assert.deepEqual(box.entry(client).env, { MQL5_DOCS_DATA: box.dir }, `${client}: the data folder is part of the registration`);
    }
    assert.equal(box.entry("claude").scope, "user");
    assert.ok(existsSync(server));

    // Start the server exactly as registered, without the caller's own data override.
    const { MQL5_DOCS_DATA, ...environment } = process.env;
    const { command, args, env } = box.entry("claude");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command, args, env: { ...environment, ...env }, stderr: "ignore" }));
    try {
      const reply = await client.callTool({ name: "mql5_find", arguments: { queries: ["OrderSend"] } });
      assert.match(reply.content[0].text, /\n\n= OrderSend · function · mql5\/ordersend\n/);
    } finally {
      await client.close();
    }
    const current = readCurrent(box.dir);
    assert.deepEqual(files(box.dir), ["current.json", current.index], "a checked index, no work folder, no lock");
    const data = Object.fromEntries(files(box.dir).map((name) => [name, readFileSync(join(box.dir, name))]));

    await uninstall({ dir: box.dir, clients: box.clients, log: () => {} });
    assert.equal(box.entry("claude"), undefined);
    assert.equal(box.entry("codex"), undefined);
    assert.deepEqual(box.apps(), []);
    for (const [name, bytes] of Object.entries(data)) assert.ok(readFileSync(join(box.dir, name)).equals(bytes), `${name} kept as it was`);
    assert.deepEqual(box.registry().claude["mql5-chm"], other, "other servers are untouched");
    assert.deepEqual(box.registry().codex["mql5-chm"], other);
    assert.equal(readFileSync(join(oldInstall, "server.mjs"), "utf8"), "// 1.3.18");

    await uninstall({ dir: box.dir, clients: box.clients, purge: true, log: () => {} });
    assert.equal(existsSync(box.dir), false, "--purge also deletes the data");
  });
});

test("setup stops before any change when an entry runs something that isn't v2", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    mkdirSync(box.dir, { recursive: true });
    // Next to the app folder, with a name starting the same way: not a v2 install.
    const neighbour = join(root, "app-neighbour", "0.1.0", "src", "server.mjs");
    const v2 = { scope: "user", command: process.execPath, args: [oldApp(box.dir, "0.0.9-x")], env: {} };
    const foreign = { scope: null, command: process.execPath, args: [neighbour], env: {} };
    box.seed({ claude: { "mql5-docs": v2 }, codex: { "mql5-docs": foreign } });
    const settings = () => JSON.stringify([box.registry().claude, box.registry().codex]);
    const before = settings();
    let downloads = 0;
    await assert.rejects(box.run({ build: { fetchImpl: async () => {
      downloads += 1;
      throw new Error("no download expected");
    } } }), /codex already has an mql5-docs entry that runs .*app-neighbour/);
    assert.equal(settings(), before, "no client setting changed");
    assert.deepEqual(box.apps(), ["0.0.9-x"], "nothing copied");
    assert.equal(downloads, 0);
    assert.deepEqual(files(box.dir), []);
  });
});

test("a failed second registration puts both old entries back exactly", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const old = seedOldInstall(box);
    box.seed({ claude: { "mql5-docs": old.claude }, codex: { "mql5-docs": old.codex }, fail: { "codex add": [1] } });
    await assert.rejects(box.run(), /codex mcp add failed/);
    assert.deepEqual(box.entry("claude"), old.claude, "scope, command, arguments and environment");
    assert.deepEqual(box.entry("codex"), old.codex);
    assert.ok(readFileSync(join(box.dir, "current.json")).equals(old.current));
    assert.ok(readFileSync(join(box.dir, old.live.index)).equals(old.index));
    assert.deepEqual(files(box.dir), ["current.json", old.live.index], "the unused new index, work folder and lock are gone");
    assert.deepEqual(box.apps(), ["0.0.9-claude", "0.0.9-codex"], "the new app folder is gone; the old ones stay");
  });
});

test("a failed switch puts both old entries back and leaves the open index as it was", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const old = seedOldInstall(box);
    box.seed({ claude: { "mql5-docs": old.claude }, codex: { "mql5-docs": old.codex } });
    const reader = new DatabaseSync(join(box.dir, old.live.index), { readOnly: true });
    const pages = () => reader.prepare("select count(*) as n from pages").get().n;
    const pagesBefore = pages();
    // Any open handle on current.json makes its replacement fail after the retries.
    const handle = openSync(join(box.dir, "current.json"), "r");
    try {
      await assert.rejects(box.run(), (error) => error.code === "EPERM");
    } finally {
      closeSync(handle);
    }
    try {
      assert.equal(pages(), pagesBefore, "the open reader still answers");
    } finally {
      reader.close();
    }
    assert.deepEqual(box.entry("claude"), old.claude);
    assert.deepEqual(box.entry("codex"), old.codex);
    assert.ok(readFileSync(join(box.dir, "current.json")).equals(old.current));
    assert.ok(readFileSync(join(box.dir, old.live.index)).equals(old.index));
    assert.deepEqual(files(box.dir), ["current.json", old.live.index], "no new index, temporary pointer, work folder or lock");
    assert.deepEqual(box.apps(), ["0.0.9-claude", "0.0.9-codex"]);
  });
});

test("a failed first install leaves no index, work folder, app folder or lock", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    box.seed({ fail: { "codex add": [1] } });
    await assert.rejects(box.run(), /codex mcp add failed/);
    assert.equal(box.entry("claude"), undefined, "claude's new entry is removed again");
    assert.deepEqual(files(box.dir), []);
    assert.deepEqual(box.apps(), []);
  });
});

test("setup and uninstall keep the app folder a client that couldn't be checked still uses", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const old = seedOldInstall(box);
    box.seed({ claude: { "mql5-docs": old.claude }, codex: { "mql5-docs": old.codex }, unavailable: ["claude"] });
    await box.run();
    assert.deepEqual(box.registry().claude["mql5-docs"], old.claude, "claude was skipped");
    assert.ok(existsSync(old.claude.args[0]), "the app claude uses is kept");
    assert.equal(box.apps().length, 3, "old claude and codex apps plus the new one");

    await uninstall({ dir: box.dir, clients: box.clients, log: () => {} });
    assert.equal(box.entry("codex"), undefined, "codex's v2 entry is removed");
    assert.ok(existsSync(old.claude.args[0]), "uninstall keeps app folders while a client can't be checked");
  });
});

test("setup and uninstall wait for no one: another holder of the docs lock stops them before any change", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const old = seedOldInstall(box);
    box.seed({ claude: { "mql5-docs": old.claude }, codex: { "mql5-docs": old.codex } });
    writeFileSync(join(box.dir, "update.lock"), JSON.stringify({ pid: 4242, started: "2026-10-22T10:00:00.000Z" }));
    await assert.rejects(box.run(), /Another docs update may be running \(process 4242/);
    await assert.rejects(uninstall({ dir: box.dir, clients: box.clients, log: () => {} }), /Another docs update may be running/);
    assert.equal(box.registry().calls, undefined, "no client was even asked for its entries");
    assert.deepEqual(box.apps(), ["0.0.9-claude", "0.0.9-codex"]);
    assert.deepEqual(files(box.dir), ["current.json", old.live.index, "update.lock"]);
  });
});

test("setup rebuilds an index of its own version that fails SQLite's integrity check", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    mkdirSync(box.dir, { recursive: true });
    const live = installIndex(box.dir, "index-a.sqlite", [{ source: "mql5", dir: BOOK }]);
    const damaged = damageIndex(join(box.dir, live.index));
    writeFileSync(join(box.dir, "current.json"), JSON.stringify({ ...live, sha256: createHash("sha256").update(damaged).digest("hex") }));
    assert.equal(readCurrent(box.dir).builder_version, VERSION);
    await box.run();
    const current = readCurrent(box.dir);
    assert.notEqual(current.index, live.index, "rebuilt instead of reused");
    assert.equal(current.schema_version, SCHEMA_VERSION);
    assert.deepEqual(files(box.dir), ["current.json", current.index]);
  });
});

test("codex runs without a shell, so every argument arrives exactly", async () => {
  await withData(async (root) => {
    // A stand-in npm install of codex: codex.cmd next to node_modules\@openai\codex\bin\codex.js.
    const bin = join(root, "npm bin");
    mkdirSync(join(bin, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(join(bin, "codex.cmd"), "@echo stand-in");
    writeFileSync(join(bin, "node_modules", "@openai", "codex", "bin", "codex.js"), "console.log(JSON.stringify(process.argv.slice(2)));");
    const args = ["mcp", "add", "mql5-docs", "--env", 'NODE_OPTIONS=--require "C:\\My Path\\preload.cjs" & echo x', "--", "C:\\Program Files\\node.exe", "a b"];
    const path = process.env.PATH;
    process.env.PATH = `"${bin}";${path}`; // quoted, as Windows allows
    try {
      const result = CLIENTS.codex(args);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), args);
    } finally {
      process.env.PATH = path;
    }
  });
});

test("a rollback that can't finish keeps what is referenced, and setup again repairs it", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const old = seedOldInstall(box);
    // The new codex entry fails; then removing claude's new entry fails too.
    box.seed({ claude: { "mql5-docs": old.claude }, codex: { "mql5-docs": old.codex }, fail: { "codex add": [1], "claude remove": [2] } });
    await assert.rejects(box.run(), /could not put back every client entry, so it kept [^]*claude: claude mcp remove failed[^]*Run `npm run setup` again/);
    const claudeServer = box.entry("claude").args[0];
    assert.ok(existsSync(claudeServer), "the new app claude still runs is kept");
    assert.deepEqual(box.entry("codex"), old.codex, "codex's old entry is back");
    assert.ok(existsSync(old.codex.args[0]) && existsSync(old.claude.args[0]), "old app folders are kept");
    assert.ok(readFileSync(join(box.dir, "current.json")).equals(old.current));
    assert.deepEqual(files(box.dir), ["current.json", old.live.index], "the index current.json names stays; the lock is released");

    const registry = box.registry();
    delete registry.fail;
    box.seed(registry);
    await box.run();
    const [app] = box.apps();
    const server = join(appRoot(box.dir), app, "src", "server.mjs");
    assert.deepEqual(box.entry("claude").args, [server]);
    assert.deepEqual(box.entry("codex").args, [server]);
    assert.equal(box.apps().length, 1, "app folders no entry uses are removed");
    const current = readCurrent(box.dir);
    assert.notEqual(current.index, old.live.index, "a newly built, checked index is live");
    assert.deepEqual(files(box.dir), ["current.json", current.index]);
  });
});
