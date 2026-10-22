// `npm run setup` as people run it (test plans for package.json and this
// file), from a copy of the checkout whose path has spaces. npm runs with a PATH that
// hides the real claude and codex and puts stand-ins first: a copy of
// node.exe named claude.exe (npm-preload.mjs makes it act as the claude CLI)
// and a codex install whose codex.js runs fake-client.mjs. LOCALAPPDATA and
// MQL5_DOCS_DATA point into a sandbox, and network access is blocked in every
// Node process, so the real clients, folders and mql5.com are never touched.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appRoot } from "../src/setup.mjs";
import { files, installIndex, makeBook, withData } from "./update-helpers.mjs";

const REPO = join(import.meta.dirname, "..");
const NPM = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
let BOOK;
let CHECKOUT;
before(() => {
  BOOK = makeBook();
  // A checkout whose path has spaces wherever the tests run (CI's has none).
  CHECKOUT = mkdtempSync(join(tmpdir(), "mql5 docs checkout "));
  for (const item of ["src", "config", "package.json", "node_modules"]) cpSync(join(REPO, item), join(CHECKOUT, item), { recursive: true });
});
after(() => {
  rmSync(BOOK, { recursive: true, force: true });
  rmSync(CHECKOUT, { recursive: true, force: true });
});

function sandbox(root) {
  const dir = join(root, "local app data", "mql5-docs-mcp", "data");
  const registry = join(root, "clients.json");
  const bin = join(root, "stand-in bin");
  const script = join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(process.execPath, join(bin, "claude.exe"));
  writeFileSync(join(bin, "codex.cmd"), "@echo stand-in");
  writeFileSync(script, `process.argv.splice(2, 0, ${JSON.stringify(registry)}, "codex");\n`
    + `await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "fake-client.mjs")).href)});\n`);

  // Every PATH folder holding a real claude or codex is left out (entries may be quoted).
  const holdsClient = (folder) => ["claude.exe", "claude.com", "claude.cmd", "codex.cmd", "codex.exe"].some((name) => existsSync(join(folder, name)));
  const folders = (process.env.PATH ?? "").split(delimiter).map((entry) => entry.replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const env = {
    ...process.env,
    PATH: [bin, ...folders.filter((folder) => !holdsClient(folder))].join(delimiter),
    LOCALAPPDATA: join(root, "local app data"),
    MQL5_DOCS_DATA: dir,
    MQL5_DOCS_TEST_REGISTRY: registry,
    NODE_OPTIONS: `--import=${pathToFileURL(join(import.meta.dirname, "npm-preload.mjs")).href}`,
  };
  // Refuse to run if Windows can still find a real client with this PATH.
  for (const name of ["claude", "codex"]) {
    const found = spawnSync("where.exe", [name], { env, encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
    const outside = found.filter((file) => !file.toLowerCase().startsWith(bin.toLowerCase()));
    if (outside.length) throw new Error(`a real ${name} is still reachable: ${outside.join(", ")}`);
  }
  const read = () => (existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")) : {});
  return {
    dir,
    entry: (client) => read()[client]?.["mql5-docs"],
    clients: () => ({ claude: read().claude, codex: read().codex }),
    seed: (value) => writeFileSync(registry, JSON.stringify(value)),
    apps: () => (existsSync(appRoot(dir)) ? readdirSync(appRoot(dir)).sort() : []),
    npm: (...args) => spawnSync(process.execPath, [NPM, "run", "setup", "--", ...args], { cwd: CHECKOUT, env, encoding: "utf8" }),
  };
}

// Protected things that must stay as they are: the 1.3.18 install and its
// registrations, the two other repositories, and an unrelated data folder.
function protectedFiles(root) {
  const sentinels = ["MQL5-CHM-MCP/1.3.18/server.mjs", "repos/MQL5-CHM-MCP/README.md", "repos/MQL5-Coding-Skill/SKILL.md",
    "local app data/other-tool/data.txt"].map((path) => join(root, path));
  for (const file of sentinels) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `sentinel ${file}`);
  }
  const other = { scope: "user", command: "C:\\Old Node\\node.exe", args: [sentinels[0]], env: {} };
  return {
    registrations: { claude: { "mql5-chm": other }, codex: { "mql5-chm": other } },
    intact: (box) => {
      for (const file of sentinels) assert.equal(readFileSync(file, "utf8"), `sentinel ${file}`, file);
      assert.deepEqual(box.clients().claude["mql5-chm"], other, "claude's other server is untouched");
      assert.deepEqual(box.clients().codex["mql5-chm"], other, "codex's other server is untouched");
    },
  };
}

// A healthy index of this version, so setup has nothing to download.
function seedIndex(box) {
  mkdirSync(box.dir, { recursive: true });
  const live = installIndex(box.dir, "index-a.sqlite", [{ source: "mql5", dir: BOOK }]);
  const data = () => Object.fromEntries(files(box.dir).map((name) => [name, readFileSync(join(box.dir, name))]));
  return { live, data };
}

async function serverAnswers(entry) {
  const { MQL5_DOCS_DATA, NODE_OPTIONS, ...environment } = process.env;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...environment, ...entry.env }, stderr: "ignore" }));
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["mql5_find", "mql5_read"]);
    const found = await client.callTool({ name: "mql5_find", arguments: { queries: ["OrderSend"] } });
    assert.equal(found.structuredContent, undefined, "plain text only");
    assert.match(found.content[0].text, /\n\n= OrderSend · function · mql5\/ordersend\n[^]*This does not mean it was executed\./);
    const read = await client.callTool({ name: "mql5_read", arguments: { id: "mql5/ordersend", focus: "Note" } });
    assert.match(read.content[0].text, /\nNote:\nCheck the result structure after every call\./);
  } finally {
    await client.close();
  }
}

test("npm run setup installs a working server for both clients", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const guard = protectedFiles(root);
    const { live, data } = seedIndex(box);
    box.seed(guard.registrations);
    const before = data();
    const result = box.npm();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed mql5-docs [\d.]+ for claude and codex\./);
    const [app] = box.apps();
    for (const client of ["claude", "codex"]) {
      const entry = box.entry(client);
      assert.equal(entry.command, process.execPath, `${client}: the absolute path of the Node that ran setup`);
      assert.deepEqual(entry.args, [join(appRoot(box.dir), app, "src", "server.mjs")], `${client}: the copied server as one argument`);
      assert.deepEqual(entry.env, { MQL5_DOCS_DATA: box.dir }, client);
      await serverAnswers(entry);
    }
    assert.deepEqual(data(), before, `${live.index} reused as it was; nothing downloaded, no lock left`);
    guard.intact(box);
  });
});

test("npm run setup -- --uninstall removes v2 and keeps the docs data", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const guard = protectedFiles(root);
    const { data } = seedIndex(box);
    box.seed(guard.registrations);
    assert.equal(box.npm().status, 0);
    const before = data();
    const result = box.npm("--uninstall");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(box.entry("claude"), undefined);
    assert.equal(box.entry("codex"), undefined);
    assert.deepEqual(box.apps(), [], "the v2 app folders are removed");
    assert.deepEqual(data(), before, "every docs file stays byte for byte; nothing installed again, no lock left");
    guard.intact(box);
  });
});

test("npm run setup -- --uninstall --purge removes v2 and its data only", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const guard = protectedFiles(root);
    seedIndex(box);
    box.seed(guard.registrations);
    assert.equal(box.npm().status, 0);
    const result = box.npm("--uninstall", "--purge");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(box.entry("claude"), undefined);
    assert.equal(box.entry("codex"), undefined);
    assert.equal(existsSync(appRoot(box.dir)), false);
    assert.equal(existsSync(box.dir), false, "the docs data is deleted");
    guard.intact(box);
  });
});

test("npm run setup exits non-zero and restores both clients when the second registration fails", async () => {
  await withData(async (root) => {
    const box = sandbox(root);
    const guard = protectedFiles(root);
    const { live, data } = seedIndex(box);
    const oldServer = (name) => {
      const server = join(appRoot(box.dir), name, "src", "server.mjs");
      mkdirSync(dirname(server), { recursive: true });
      writeFileSync(server, `// ${name}`);
      return server;
    };
    const claude = { scope: "local", command: "C:\\Old Node\\node.exe", args: [oldServer("0.0.9 claude")], env: { DEBUG: "1 2" } };
    const codex = { scope: null, command: "C:\\Other Node\\node.exe", args: [oldServer("0.0.9 codex")], env: { MODE: "a b" } };
    box.seed({ claude: { ...guard.registrations.claude, "mql5-docs": claude }, codex: { ...guard.registrations.codex, "mql5-docs": codex },
      fail: { "codex add": [1] } });
    const before = data();
    const result = box.npm();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codex mcp add failed/);
    assert.deepEqual(box.entry("claude"), claude, "claude: scope, command, arguments and environment");
    assert.deepEqual(box.entry("codex"), codex);
    assert.deepEqual(data(), before, `current.json and ${live.index} unchanged, no lock left`);
    assert.deepEqual(box.apps(), ["0.0.9 claude", "0.0.9 codex"], "old app files stay; the new app folder is removed");
    assert.equal(readFileSync(claude.args[0], "utf8"), "// 0.0.9 claude");
    guard.intact(box);
  });
});
