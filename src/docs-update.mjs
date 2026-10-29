// npm run docs:update: download the three CHM files, unpack them with
// Windows' hh.exe, build a new index, check it, then switch data/current.json
// to it. Nothing in use is replaced: a failed step leaves the live index and
// current.json as they were, and removes only what this update created.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { checkBaseline, checkIndex, lostNames } from "./checks.mjs";
import { loadBaseline } from "./config.mjs";
import { dataDir, hashFile, INDEX_NAME, openIndex, readCurrent, SCHEMA_VERSION, VERSION } from "./data.mjs";
import { buildIndex, decodePage, parseSitemap } from "./indexer.mjs";

export const BOOKS = [
  { source: "mql5", file: "mql5.chm", url: "https://www.mql5.com/files/docs/mql5.chm" },
  { source: "book", file: "mql5book.chm", url: "https://www.mql5.com/files/book/mql5book.chm?v=2" },
  { source: "nn", file: "neuronetworksbook.chm", url: "https://www.mql5.com/files/book/neuronetworksbook.chm?v=2" },
];
const HOST = "www.mql5.com";
const MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_MS = 3 * 60 * 1000;
const MAX_REDIRECTS = 3;
const UNPACK_MS = 2 * 60 * 1000;
const MAX_LOSS = 0.02;
const BUSY = new Set(["EBUSY", "EPERM", "EACCES"]);

// An expected failure, reported to the user as its message alone.
export class UpdateError extends Error {}
const fail = (message) => {
  throw new UpdateError(message);
};

// The lock file holds this process's id and start time; only the process that
// wrote it removes it.
export function takeLock(dir) {
  const file = join(dir, "update.lock");
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  try {
    writeFileSync(file, mine, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Unreadable: still another update's lock.
    }
    fail(`Another docs update may be running (process ${holder?.pid ?? "?"}, started at ${holder?.started ?? "?"}); `
      + "if none is, delete data/update.lock and try again.");
  }
  return () => {
    try {
      if (readFileSync(file, "utf8") === mine) unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
}

// HTTPS from www.mql5.com only, at most 3 redirects on that host, at most
// 50 MB and 3 minutes; the byte count must match Content-Length, because half
// a CHM still unpacks to a complete-looking set of pages. Hashed while written.
// `stop` aborts it from outside (another download failed).
export async function download(url, file, { fetchImpl = fetch, stop } = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_MS), ...(stop ? [stop] : [])]);
  let current = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== "https:" || current.host !== HOST) fail(`Refused download from ${current.href}: only https://${HOST}.`);
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      if (redirects === MAX_REDIRECTS) fail(`Too many redirects downloading ${url}.`);
      const location = response.headers.get("location") ?? fail(`A redirect without a location from ${current.href}.`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) fail(`Download of ${url} failed: HTTP ${response.status}.`);
    const expected = Number(response.headers.get("content-length") ?? NaN);
    if (expected > MAX_BYTES) fail(`${url} is larger than 50 MB.`);
    const hash = createHash("sha256");
    let bytes = 0;
    const out = createWriteStream(file);
    try {
      await pipeline(Readable.fromWeb(response.body), async function* count(chunks) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) fail(`${url} is larger than 50 MB.`);
          hash.update(chunk);
          yield chunk;
        }
      }, out);
    } finally {
      // pipeline can settle before the file is closed; cleanup must not race it.
      if (!out.closed) await once(out, "close");
    }
    if (Number.isFinite(expected) && bytes !== expected) fail(`Download of ${url} is incomplete (${bytes} of ${expected} bytes).`);
    return hash.digest("hex");
  }
}

// The three downloads run at the same time. The first failure aborts the
// others, and all have settled (their files closed) before it is reported,
// so cleanup never races a download still writing.
export async function downloadBooks(work, fetchImpl) {
  mkdirSync(work);
  const stop = new AbortController();
  let firstError = null;
  const hashes = await Promise.all(BOOKS.map((book) => download(book.url, join(work, book.file), { fetchImpl, stop: stop.signal })
    .catch((error) => {
      firstError ??= error;
      stop.abort();
      return null;
    })));
  if (firstError) throw firstError;
  return Object.fromEntries(BOOKS.map((book, i) => [book.source, hashes[i]]));
}

// hh.exe is started from inside the work folder with plain relative names (an
// absolute path produces nothing). It always exits with 0, so its output is
// checked before anything is built.
export function unpack(work, book, { command = "hh.exe", prefix = [], timeout = UNPACK_MS } = {}) {
  const out = `${book.source}-pages`;
  const result = spawnSync(command, [...prefix, "-decompile", out, book.file], { cwd: work, timeout, windowsHide: true });
  if (result.error?.code === "ETIMEDOUT" || result.signal) fail(`Unpacking ${book.file} took longer than ${timeout / 1000} s.`);
  if (result.error) fail(`Unpacking ${book.file} failed: ${result.error.message}.`);
  const dir = join(work, out);
  checkUnpacked(dir, book.file);
  return dir;
}

// The contents and keyword index exist and parse, every entry points to a page
// that exists, and every page has a title and ends with </html>.
export function checkUnpacked(dir, name) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    fail(`Unpacking ${name} produced nothing.`);
  }
  const pages = files.filter((file) => /\.html?$/i.test(file));
  const lower = new Set(pages.map((file) => file.toLowerCase()));
  for (const extension of [".hhc", ".hhk"]) {
    const sitemap = files.find((file) => file.toLowerCase().endsWith(extension)) ?? fail(`${name} has no ${extension} file.`);
    const targets = parseSitemap(decodePage(readFileSync(join(dir, sitemap)))).flatMap((entry) => entry.targets);
    if (!targets.length) fail(`${name}: ${sitemap} lists no pages.`);
    const missing = targets.find((target) => !lower.has(target.split("#")[0].toLowerCase()));
    if (missing) fail(`${name}: ${sitemap} points to a missing page (${missing}).`);
  }
  for (const page of pages) {
    const text = readFileSync(join(dir, page), "latin1");
    if (!/<title>[^<]*\S[^<]*<\/title>/i.test(text) || !/<\/html>\s*$/i.test(text)) fail(`${name}: page ${page} is incomplete.`);
  }
}

// Unpacks the three books inside work (which sits in dir) and checks that
// unpacking wrote nothing next to it: the CHM files are downloaded data, so
// anything that appeared there is removed and the update stops, also when
// unpacking failed for another reason.
export function unpackBooks(dir, work, unpackOptions) {
  const before = new Set(readdirSync(dir));
  try {
    return BOOKS.map((book) => ({ source: book.source, dir: unpack(work, book, unpackOptions) }));
  } finally {
    const added = readdirSync(dir).filter((name) => !before.has(name));
    for (const name of added) rmSync(join(dir, name), { recursive: true, force: true });
    if (added.length) fail(`Unpacking wrote outside its work folder: ${added.join(", ")}.`);
  }
}

export const stampNow = () => new Date().toISOString().replace(/[-:.]/g, "");

// The live index when it passes all its checks (schema, SHA-256, SQLite
// integrity), else null. Damage can make SQLite's check throw instead of
// report, which counts as failing it.
export async function healthyLive(dir) {
  const live = await openIndex(dir);
  if (live.error) return null;
  try {
    if (live.db.prepare("pragma integrity_check").get().integrity_check === "ok") return live;
  } catch {
    // Too damaged to check.
  }
  live.db.close();
  return null;
}

// Builds into build-<stamp>.sqlite, runs the build checks, then gives it its
// final name index-<stamp>.sqlite with a hard link, which never replaces a
// file. current.json is not touched: setup switches later than an update does.
export async function buildChecked(dir, sources, meta, { acceptLoss = false, baseline = loadBaseline(), log = () => {} } = {}) {
  const stamp = stampNow();
  const temp = join(dir, `build-${stamp}.sqlite`);
  const index = `index-${stamp}.sqlite`;
  try {
    buildIndex(temp, sources, meta);
    const db = new DatabaseSync(temp);
    try {
      const problems = [...checkIndex(db), ...checkBaseline(db, baseline)];
      if (problems.length) fail(`The new index failed its checks:\n- ${problems.slice(0, 20).join("\n- ")}`);
      // Skipped when the live index is damaged or missing, so it never blocks its own repair.
      const live = await healthyLive(dir);
      if (live) {
        let comparison;
        try {
          comparison = lostNames(live.db, db);
        } finally {
          live.db.close();
        }
        const { lost, total } = comparison;
        if (lost.length) log(`The new index lacks ${lost.length} of ${total} names and cards:\n- ${lost.join("\n- ")}`);
        if (lost.length > total * MAX_LOSS && !acceptLoss) {
          fail(`The new index lacks ${lost.length} of ${total} names and cards (more than 2%); `
            + "run again with --accept-loss to use it anyway.");
        }
      }
    } finally {
      db.close();
    }
    try {
      linkSync(temp, join(dir, index));
    } catch (error) {
      if (error.code === "EEXIST") fail(`${index} already exists; try again.`);
      throw error;
    }
    return { index, sha256: await hashFile(join(dir, index)) };
  } finally {
    rmSync(temp, { force: true });
  }
}

// Unpacks the books downloadBooks put in work and builds a checked index from
// them. Returns the current.json record for it; when to switch is the caller's.
export async function buildDownloaded(dir, work, chm, { acceptLoss, baseline, log, unpackOptions } = {}) {
  const downloaded = new Date().toISOString().slice(0, 10);
  const meta = { builder_version: VERSION, downloaded, chm: JSON.stringify(chm) };
  const sources = unpackBooks(dir, work, unpackOptions);
  const { index, sha256 } = await buildChecked(dir, sources, meta, { acceptLoss, baseline, log });
  return { index, sha256, schema_version: SCHEMA_VERSION, chm, downloaded, builder_version: VERSION };
}

// current.json is written to a temporary file and renamed into place, retried
// for about 5 seconds while Windows reports it busy (any open handle on it,
// such as a server reading it, blocks the rename). If it stays busy, the old
// current.json stays.
export async function switchCurrent(dir, current) {
  const temp = join(dir, "current.json.tmp");
  writeFileSync(temp, JSON.stringify(current, null, 2));
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, join(dir, "current.json"));
      return;
    } catch (error) {
      if (!BUSY.has(error.code) || attempt === 20) {
        rmSync(temp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

// Deletes work folders and every index or build file except `keep`, the one
// current.json names. A file still open (a running server's index) is
// skipped; it goes at the next update. Unless `keep` is a valid index name
// (current.json may be damaged), no index file is deleted.
export function cleanUp(dir, keep) {
  const known = typeof keep === "string" && INDEX_NAME.test(keep);
  for (const name of readdirSync(dir)) {
    try {
      if (/^work-/.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
      else if (known && name !== keep && /^(index|build)-.*\.sqlite(-journal)?$/.test(name)) unlinkSync(join(dir, name));
    } catch (error) {
      if (!BUSY.has(error.code)) throw error;
    }
  }
}

const sameHashes = (a, b) => BOOKS.every((book) => a?.[book.source] === b[book.source]);

// npm run docs:update. It runs only next to an index of this schema version;
// otherwise setup installs the matching server and index together. The format
// is checked on current.json as read under the lock: a setup that switched to
// another format just before must not get its index replaced.
const NO_CURRENT = "No usable data/current.json: run `npm run setup`, which installs the server and builds its index.";
export async function update({ dir = dataDir(), acceptLoss = false, baseline, fetchImpl, unpackOptions, log = console.log } = {}) {
  if (!readCurrent(dir)) fail(NO_CURRENT);
  const release = takeLock(dir);
  const work = join(dir, `work-${stampNow()}`);
  try {
    const current = readCurrent(dir) ?? fail(NO_CURRENT);
    if (current.schema_version !== SCHEMA_VERSION) {
      fail(`The installed index has format ${current.schema_version}; this update builds format ${SCHEMA_VERSION}: run \`npm run setup\`.`);
    }
    const hashes = await downloadBooks(work, fetchImpl);
    if (sameHashes(current.chm, hashes) && current.builder_version === VERSION) {
      // Up to date only when the live index also passes its checks; otherwise it is rebuilt.
      const live = await healthyLive(dir);
      live?.db.close();
      if (live) {
        log("MQL5 docs are already up to date.");
        return { upToDate: true };
      }
    }
    const built = await buildDownloaded(dir, work, hashes, { acceptLoss, baseline, log, unpackOptions });
    await switchCurrent(dir, built);
    log(`MQL5 docs updated (downloaded ${built.downloaded}, ${built.index}). Restart Claude Code and Codex to use them.`);
    return { index: built.index };
  } finally {
    // A failed run leaves current.json as it was, so this keeps the index it
    // names and removes this run's work folder and any index it built. The
    // lock is released even if cleanup fails.
    try {
      cleanUp(dir, readCurrent(dir)?.index);
    } finally {
      release();
    }
  }
}
