// npm run setup: installs this version for Claude Code and Codex and builds
// its index when needed. npm run setup -- --uninstall [--purge] removes it.
// Everything that can fail is checked before anything changes; a failure
// after that puts the previous client entries back (DESIGN.md section 9).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dataDir, readCurrent, SCHEMA_VERSION, VERSION } from "./data.mjs";
import { takeLock } from "./docs-update.mjs";

const NAME = "mql5-docs";
const REPO = join(import.meta.dirname, "..");
const COPIED = ["src", "config", "package.json", "node_modules"];
const CLIENT_MS = 120_000;

// An expected failure, reported to the user as its message alone.
export class SetupError extends Error {}
const fail = (message) => {
  throw new SetupError(message);
};

// claude is a native program. codex is an npm package whose codex.cmd
// launcher only runs node on its codex.js: running that script directly
// passes every argument exactly, with no shell and no quoting rules.
const run = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: CLIENT_MS, windowsHide: true });
export function codexScript() {
  // Windows allows quoted PATH entries ("C:\Some Folder").
  for (const folder of (process.env.PATH ?? "").split(delimiter).map((entry) => entry.replace(/^"(.*)"$/, "$1")).filter(Boolean)) {
    const script = join(folder, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(join(folder, "codex.cmd")) && existsSync(script)) return script;
  }
  return null;
}
export const CLIENTS = {
  claude: (args) => run("claude", args),
  codex: (args) => {
    const script = codexScript();
    return script ? run(process.execPath, [script, ...args]) : { status: null, error: new Error("codex not found") };
  },
};

// App folders sit next to the data folder: %LOCALAPPDATA%\mql5-docs-mcp\app.
export const appRoot = (dir) => join(dirname(dir), "app");

// The client's mql5-docs entry as { scope, command, args, env }, or null.
function getEntry(name, run) {
  const result = run(name === "codex" ? ["mcp", "get", NAME, "--json"] : ["mcp", "get", NAME]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    if (/No MCP server named/.test(output)) return null;
    fail(`${name} mcp get failed: ${output.trim() || result.error?.message}`);
  }
  if (name === "codex") {
    const { transport } = JSON.parse(result.stdout);
    return { scope: null, command: transport.command, args: transport.args ?? [], env: transport.env ?? {} };
  }
  const field = (label) => new RegExp(`^\\s*${label}:\\s*(.*)$`, "m").exec(result.stdout)?.[1].trim() ?? "";
  const scope = /^User/i.test(field("Scope")) ? "user" : /^Project/i.test(field("Scope")) ? "project" : "local";
  const environment = result.stdout.split(/^\s*Environment:\s*$/m)[1] ?? "";
  const env = Object.fromEntries([...environment.matchAll(/^\s+(\w+)=(.*)$/gm)].map((match) => [match[1], match[2].trim()]));
  // claude prints the arguments joined by spaces; a v2 entry has exactly
  // one, the server path, which may itself contain spaces.
  return { scope, command: field("Command"), args: field("Args") ? [field("Args")] : [], env };
}

const real = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

// An entry runs a v2 installation when its one argument is a server.mjs
// inside the app folder (compared after resolving 8.3 short names).
export function isV2(entry, root) {
  const [server] = entry.args;
  return entry.args.length === 1 && /[\\/]src[\\/]server\.mjs$/i.test(server)
    && real(server).toLowerCase().startsWith(real(root).toLowerCase() + sep);
}

function removeEntry(name, run, entry) {
  const result = run(name === "codex" ? ["mcp", "remove", NAME] : ["mcp", "remove", NAME, "-s", entry.scope ?? "user"]);
  if (result.status !== 0) fail(`${name} mcp remove failed: ${(result.stderr || result.stdout || "").trim()}`);
}

// The server name comes before the environment options: claude's -e takes
// every following value up to the next option, so a name after it would be
// read as one more variable.
function addEntry(name, run, entry) {
  const env = Object.entries(entry.env ?? {}).flatMap(([key, value]) => [name === "codex" ? "--env" : "-e", `${key}=${value}`]);
  const scope = name === "codex" ? [] : ["-s", entry.scope ?? "user"];
  const result = run(["mcp", "add", ...scope, NAME, ...env, "--", entry.command, ...entry.args]);
  if (result.status !== 0) fail(`${name} mcp add failed: ${(result.stderr || result.stdout || "").trim()}`);
}

// Node must have node:sqlite with FTS5 and both page decoders; Node 24 is
// the tested line, another major version only warns.
export function checkNode(log) {
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("create virtual table t using fts5(x); insert into t values ('a');");
    db.close();
    new TextDecoder("windows-1252");
    new TextDecoder("iso-8859-1");
  } catch (error) {
    fail(`This Node (${process.version}) lacks what the index needs: ${error.message}`);
  }
  if (!process.version.startsWith("v24.")) log(`Warning: tested on Node 24; this is ${process.version}.`);
}

// The clients whose CLI answers, with their current mql5-docs entry, and
// whether any client was skipped (its entries couldn't be read, so app
// folders it may still use must stay). An entry that runs anything other
// than a v2 installation stops setup before anything changes.
function findClients(clients, root, log) {
  const found = [];
  let skipped = false;
  for (const [name, run] of Object.entries(clients)) {
    if (run(["--version"]).status !== 0) {
      log(`${name}: not found, skipped.`);
      skipped = true;
      continue;
    }
    const entry = getEntry(name, run);
    if (entry && !isV2(entry, root)) {
      fail(`${name} already has an ${NAME} entry that runs ${[entry.command, ...entry.args].join(" ")}; `
        + `remove it first (${name} mcp remove ${NAME}).`);
    }
    found.push({ name, run, old: entry, removed: false, added: false });
  }
  return { found, skipped };
}

// The new copy's server answers tools/list, and its find module returns
// OrderSend's card from the index that is about to be live.
async function selfTest(app, indexFile, dir) {
  const client = new Client({ name: "mql5-docs-setup", version: VERSION });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(app, "src", "server.mjs")], env: { ...process.env, MQL5_DOCS_DATA: dir }, stderr: "ignore",
  }));
  try {
    const { tools } = await client.listTools();
    if (tools.length !== 2) fail(`Self-test: the new server lists ${tools.length} tools.`);
  } finally {
    await client.close();
  }
  const { findText } = await import(pathToFileURL(join(app, "src", "find.mjs")).href);
  const db = new DatabaseSync(indexFile, { readOnly: true });
  try {
    if (!/\n= OrderSend · function · mql5\/ordersend\n/.test(findText(db, ["OrderSend"], { tag: "selftest", downloaded: "-" }))) {
      fail("Self-test: find OrderSend did not return its card.");
    }
  } finally {
    db.close();
  }
}

// Puts back the remembered entries, newest change first. Returns a line per
// client it could not repair, with that client's actual state.
function restore(found) {
  const broken = [];
  for (const client of [...found].reverse()) {
    try {
      if (client.added) removeEntry(client.name, client.run, { scope: "user" });
      if (client.old && client.removed) addEntry(client.name, client.run, client.old);
    } catch (error) {
      let state;
      try {
        const entry = getEntry(client.name, client.run);
        state = entry ? `its ${NAME} entry runs ${[entry.command, ...entry.args].join(" ")}` : `it has no ${NAME} entry`;
      } catch {
        state = "its state could not be read";
      }
      broken.push(`${client.name}: ${error.message}; ${state}`);
    }
  }
  return broken;
}

const stampNow = () => new Date().toISOString().replace(/[-:.]/g, "");

// App folders no client entry refers to, except the new one, are deleted.
function removeUnusedApps(root, keep, found) {
  const used = new Set([keep, ...found.map((client) => getEntry(client.name, client.run)).filter(Boolean)
    .map((entry) => dirname(dirname(entry.args[0] ?? "")))].map((path) => real(path).toLowerCase()));
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (!used.has(real(path).toLowerCase())) rmSync(path, { recursive: true, force: true, maxRetries: 2 });
  }
}

// `build` passes test inputs (downloads, unpacker, baseline) to the update code.
export async function setup({ dir = dataDir(), clients = CLIENTS, log = console.log, build = {} } = {}) {
  checkNode(log);
  const root = appRoot(dir);
  // The docs lock is held from before the client entries are read until the
  // end, so another setup, uninstall or update can't change them meanwhile.
  mkdirSync(dir, { recursive: true });
  const release = takeLock(dir);
  try {
    const { found, skipped } = findClients(clients, root, log);
    if (!found.length) fail("Neither Claude Code (claude) nor Codex (codex) was found.");

    // A new app folder every time, so a half-finished setup never leaves a mixed install.
    const app = join(root, `${VERSION}-${stampNow()}`);
    if (existsSync(app)) fail(`${app} already exists; try again.`);
    try {
      for (const item of COPIED) cpSync(join(REPO, item), join(app, item), { recursive: true });
    } catch (error) {
      rmSync(app, { recursive: true, force: true });
      throw error;
    }
    await install(dir, app, found, { log, build });
    if (!skipped) removeUnusedApps(root, app, found);
    log(`Installed ${NAME} ${VERSION} for ${found.map((client) => client.name).join(" and ")}. Restart Claude Code and Codex.`);
  } finally {
    release();
  }
}

// Builds the index if needed with the new copy's own update code, tests the
// copy, registers it with each client and switches to the new index; on a
// failure, puts the previous entries back.
async function install(dir, app, found, { log, build }) {
  const update = await import(pathToFileURL(join(app, "src", "docs-update.mjs")).href);
  let built = null;
  try {
    // Reused only when healthy (schema, SHA-256, SQLite integrity) and built by this version.
    const live = await update.healthyLive(dir);
    live?.db.close();
    if (!live || readCurrent(dir).builder_version !== VERSION) {
      const work = join(dir, `work-${stampNow()}`);
      const chm = await update.downloadBooks(work, build.fetchImpl);
      const downloaded = new Date().toISOString().slice(0, 10);
      const sources = update.unpackBooks(dir, work, build.unpackOptions);
      const meta = { builder_version: VERSION, downloaded, chm: JSON.stringify(chm) };
      built = { ...await update.buildChecked(dir, sources, meta, { baseline: build.baseline, log }), chm, downloaded };
    }
    await selfTest(app, join(dir, built?.index ?? readCurrent(dir).index), dir);
    // The data folder is part of the registration, so the server finds this
    // index whatever environment the client starts it with.
    const entry = { scope: "user", command: process.execPath, args: [join(app, "src", "server.mjs")], env: { MQL5_DOCS_DATA: dir } };
    for (const client of found) {
      if (client.old) {
        removeEntry(client.name, client.run, client.old);
        client.removed = true;
      }
      addEntry(client.name, client.run, entry);
      client.added = true;
    }
    if (built) {
      await update.switchCurrent(dir, { index: built.index, sha256: built.sha256, schema_version: SCHEMA_VERSION, chm: built.chm,
        downloaded: built.downloaded, builder_version: VERSION });
    }
  } catch (error) {
    const broken = restore(found);
    // current.json is unchanged. cleanUp removes an unnamed index only when
    // current.json names a valid one, so after a failed first install the
    // index this run built is removed here.
    update.cleanUp(dir, readCurrent(dir)?.index);
    if (built && readCurrent(dir)?.index !== built.index) rmSync(join(dir, built.index), { force: true });
    if (!broken.length) {
      rmSync(app, { recursive: true, force: true });
      throw error;
    }
    fail(`${error.message}\nSetup could not put back every client entry, so it kept ${app}:\n- ${broken.join("\n- ")}\n`
      + "Run `npm run setup` again to repair this.");
  }
  update.cleanUp(dir, readCurrent(dir)?.index);
}

// Removes only entries that run a v2 installation, then the app folders
// (kept when a client couldn't be checked, since it may still use one);
// purge also deletes the docs data. Holds the docs lock like setup.
export async function uninstall({ dir = dataDir(), clients = CLIENTS, purge = false, log = console.log } = {}) {
  const root = appRoot(dir);
  mkdirSync(dir, { recursive: true });
  const release = takeLock(dir);
  try {
    let skipped = false;
    for (const [name, run] of Object.entries(clients)) {
      if (run(["--version"]).status !== 0) {
        log(`${name}: not found, so its entries could not be checked.`);
        skipped = true;
        continue;
      }
      const entry = getEntry(name, run);
      if (entry && isV2(entry, root)) removeEntry(name, run, entry);
      else if (entry) log(`${name}: its ${NAME} entry does not run a v2 installation; left alone.`);
    }
    if (skipped) log(`App folders kept in ${root}; run the uninstall again once every client is available.`);
    else rmSync(root, { recursive: true, force: true });
    if (purge) rmSync(dir, { recursive: true, force: true });
  } finally {
    release();
  }
  log(purge ? `Removed ${NAME} and its data.` : `Removed ${NAME}; the docs data stays.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--uninstall")) await uninstall({ purge: args.includes("--purge") });
    else await setup();
  } catch (error) {
    if (!["SetupError", "UpdateError"].includes(error.constructor.name)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
