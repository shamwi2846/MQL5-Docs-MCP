// The data folder and the live index. data/current.json names the index file
// with its SHA-256 and schema version; a docs update writes a new index file
// and switches current.json, it never replaces a file in use.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The index format. The indexer writes it into meta; the server reads only
// an index of this format.
export const SCHEMA_VERSION = 1;
const INDEX_NAME = /^index-[\w.-]+\.sqlite$/;
const UPDATE = "run `npm run docs:update`";
const SETUP = "run `npm run setup`";

export function dataDir() {
  return process.env.MQL5_DOCS_DATA ?? join(process.env.LOCALAPPDATA ?? homedir(), "mql5-docs-mcp", "data");
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Opens the live index read-only once it matches current.json: its hash and
// schema version. Returns { db, tag, downloaded }, or { error } with one line
// saying what is wrong and what to run. An index that just disappeared means
// an update switched and cleaned up, so current.json is read once more.
export async function openIndex(dir = dataDir()) {
  for (let attempt = 1; ; attempt++) {
    let current;
    try {
      current = JSON.parse(await readFile(join(dir, "current.json"), "utf8"));
    } catch {
      return { error: `No MQL5 docs index is installed (data/current.json is missing or unreadable); ${SETUP}.` };
    }
    if (current === null || typeof current !== "object") return { error: `data/current.json is damaged; ${SETUP}.` };
    if (current.schema_version !== SCHEMA_VERSION) {
      return { error: `The installed MQL5 docs index has format ${current.schema_version}; this server reads format ${SCHEMA_VERSION}; ${SETUP}.` };
    }
    if (typeof current.index !== "string" || !INDEX_NAME.test(current.index)) return { error: `data/current.json names no valid index file; ${SETUP}.` };
    const file = join(dir, current.index);
    let sha256;
    try {
      sha256 = await hashFile(file);
    } catch (error) {
      if (error.code === "ENOENT" && attempt === 1) continue;
      return { error: `The MQL5 docs index ${current.index} is missing or unreadable; ${UPDATE}.` };
    }
    if (sha256 !== current.sha256) return { error: `The MQL5 docs index ${current.index} is damaged (its hash differs from data/current.json); ${UPDATE}.` };
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const version = db.prepare("select value from meta where key = 'schema_version'").get()?.value;
      if (version !== String(SCHEMA_VERSION)) throw new Error(`format ${version}`);
      return { db, tag: sha256.slice(0, 7), downloaded: current.downloaded };
    } catch {
      db?.close();
      return { error: `The MQL5 docs index ${current.index} could not be read as format ${SCHEMA_VERSION}; ${UPDATE}.` };
    }
  }
}
