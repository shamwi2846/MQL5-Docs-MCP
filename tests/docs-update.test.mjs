// Risky step: docs:update deletes index files and handles downloaded data.
// Test plans (crosscheck): the main path with an open reader, another
// format refused before downloading, a required warning that --accept-loss
// can't waive, an off-host redirect never contacted, current.json busy
// through the retries; for the checks: page-specific card loss, a missing
// anchor, a lost section exception. Downloads are served by a stub; hh.exe
// is a stand-in script that copies the fixture pages.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lostNames } from "../src/checks.mjs";
import { openIndex, SCHEMA_VERSION, VERSION } from "../src/data.mjs";
import { cleanUp, download, update } from "../src/docs-update.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { baseline, files, installIndex, installWithExtras, makeBook, stubFetch, unpackOptions, withData } from "./update-helpers.mjs";

let BOOK;
before(() => {
  BOOK = makeBook();
});
after(() => rmSync(BOOK, { recursive: true, force: true }));

const install = (dir, name = "index-a.sqlite") => installIndex(dir, name, [{ source: "mql5", dir: BOOK }]);
const options = (extra = {}) => ({ fetchImpl: stubFetch(BOOK), unpackOptions, baseline, log: () => {}, ...extra });
const bookPages = (db) => db.prepare("select count(*) as n from pages where id like 'book/%'").get().n;

test("docs:update switches to a new checked index without disturbing an open reader", async () => {
  await withData(async (dir) => {
    const old = install(dir, "index-20261001T000000000Z.sqlite");
    const reader = new DatabaseSync(join(dir, old.index), { readOnly: true });
    let current;
    try {
      assert.equal(bookPages(reader), 0);
      const result = await update({ dir, ...options() });
      current = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
      assert.equal(current.index, result.index);
      assert.match(current.index, /^index-\d{8}T\d{9}Z\.sqlite$/);
      assert.equal(current.schema_version, SCHEMA_VERSION);
      assert.equal(current.builder_version, VERSION);
      assert.deepEqual(Object.keys(current.chm), ["mql5", "book", "nn"]);
      assert.equal(createHash("sha256").update(readFileSync(join(dir, current.index))).digest("hex"), current.sha256);
      assert.deepEqual(files(dir), ["current.json", old.index, current.index].sort(), "the open old index stays; work folder and lock are gone");
      assert.equal(bookPages(reader), 0, "the running reader keeps its index");
    } finally {
      reader.close();
    }
    const opened = await openIndex(dir);
    assert.equal(opened.tag, current.sha256.slice(0, 7));
    assert.deepEqual(opened.current, current);
    assert.ok(bookPages(opened.db) > 0, "a new reader gets the new books");
    opened.db.close();
    const again = await update({ dir, ...options() });
    assert.deepEqual(again, { upToDate: true }, "same downloads and builder: nothing rebuilt");
    assert.deepEqual(files(dir), ["current.json", current.index], "the old index goes once nothing has it open");
  });
});

test("docs:update refuses an index of another format before downloading", async () => {
  await withData(async (dir) => {
    const live = install(dir);
    writeFileSync(join(dir, "current.json"), JSON.stringify({ ...live, schema_version: SCHEMA_VERSION + 1 }));
    const before = files(dir);
    let requests = 0;
    const counting = async (url) => {
      requests += 1;
      return stubFetch(BOOK)(url);
    };
    await assert.rejects(update({ dir, ...options({ fetchImpl: counting }) }), /has format 2; this update builds format 1: run `npm run setup`/);
    assert.equal(requests, 0);
    assert.deepEqual(files(dir), before);
  });
});

test("docs:update validates the current schema after acquiring its lock", async () => {
  await withData(async (dir) => {
    const live = install(dir);
    // A setup of a newer format finishes and releases the lock just as this update takes it.
    const upgraded = JSON.stringify({ ...live, index: "index-newer.sqlite", schema_version: SCHEMA_VERSION + 1 });
    const writeFile = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
      if (String(file).endsWith("update.lock")) {
        writeFile(join(dir, "index-newer.sqlite"), "newer format");
        writeFile(join(dir, "current.json"), upgraded);
        fs.writeFileSync = writeFile;
        syncBuiltinESMExports();
      }
      return writeFile(file, ...rest);
    };
    syncBuiltinESMExports();
    let requests = 0;
    try {
      await assert.rejects(update({ dir, ...options({ fetchImpl: async () => {
        requests += 1;
        throw new Error("no download expected");
      } }) }), /has format 2; this update builds format 1: run `npm run setup`/);
    } finally {
      fs.writeFileSync = writeFile;
      syncBuiltinESMExports();
    }
    assert.equal(requests, 0);
    assert.equal(readFileSync(join(dir, "current.json"), "utf8"), upgraded, "the upgraded pointer stays");
    assert.equal(readFileSync(join(dir, "index-newer.sqlite"), "utf8"), "newer format", "and its index");
    assert.equal(existsSync(join(dir, "update.lock")), false, "the lock is released");
  });
});

test("docs:update stops at another update's lock and leaves it", async () => {
  await withData(async (dir) => {
    install(dir);
    writeFileSync(join(dir, "update.lock"), JSON.stringify({ pid: 4242, started: "2026-10-21T10:00:00.000Z" }));
    const before = files(dir);
    await assert.rejects(update({ dir, ...options() }),
      /Another docs update may be running \(process 4242, started at 2026-10-21T10:00:00\.000Z\); if none is, delete data\/update\.lock/);
    assert.deepEqual(files(dir), before);
  });
});

test("docs:update leaves the live index when a download, unpacking, a check or the switch fails", async () => {
  await withData(async (dir) => {
    const live = install(dir);
    const currentBefore = readFileSync(join(dir, "current.json"), "utf8");
    const requested = [];
    const offHost = async (url) => {
      requested.push(String(url));
      if (String(url).includes("neuronetworksbook")) {
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/docs.chm" } });
      }
      return stubFetch(BOOK)(url);
    };
    // One download fails while the other two are still streaming: they are
    // aborted and settled before cleanup and the lock's release.
    const aborted = [];
    const oneFails = async (url, { signal }) => {
      if (String(url).includes("/mql5.chm")) return new Response("down", { status: 500 });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          signal.addEventListener("abort", () => {
            aborted.push(String(url));
            controller.error(signal.reason);
          });
        },
      });
      return new Response(body, { headers: { "content-length": "1000" } });
    };
    const remove = (page, text) => stubFetch(BOOK, { "mql5.chm": { copy: BOOK, remove: { [page]: text } } });
    const failures = [
      [{ fetchImpl: offHost }, /Refused download from https:\/\/attacker\.example\/docs\.chm/],
      [{ fetchImpl: oneFails }, /Download of https:\/\/www\.mql5\.com\/files\/docs\/mql5\.chm failed: HTTP 500/],
      [{ fetchImpl: stubFetch(BOOK, { "mql5book.chm": { copy: BOOK, truncate: "ordersend.htm" } }) }, /page ordersend\.htm is incomplete/],
      [{ fetchImpl: stubFetch(BOOK, { "mql5.chm": "not a chm" }) }, /Unpacking mql5\.chm produced nothing/],
      [{ fetchImpl: stubFetch(BOOK, { "mql5.chm": { copy: BOOK, escape: "stray.txt" } }) }, /wrote outside its work folder: stray\.txt/],
      [{ fetchImpl: stubFetch(BOOK, { "mql5.chm": { copy: BOOK, escape: "stray2.txt", truncate: "ordersend.htm" } }) },
        /wrote outside its work folder: stray2\.txt/],
      [{ fetchImpl: stubFetch(BOOK, { "mql5.chm": { hang: true } }), unpackOptions: { ...unpackOptions, timeout: 500 } }, /took longer than/],
      [{ baseline: { names: [{ name: "NoSuchName", page: "mql5/none" }] } }, /failed its checks:\n- NoSuchName: not found/],
      // --accept-loss never waives the baseline: OrderSend's warning, or the
      // pending-order exception in ORDER_FILLING_RETURN's section notes.
      [{ acceptLoss: true, baseline: { names: [{ name: "OrderSend", page: "mql5/ordersend", phrases: ["not a sign of successful execution"] }] } },
        /OrderSend: card lacks "not a sign of successful execution"/],
      [{ acceptLoss: true, fetchImpl: remove("orderproperties.htm", "Pending orders use Return regardless of the mode.") },
        /ORDER_FILLING_RETURN: card lacks "regardless of the mode"/],
      [{ fetchImpl: remove("orderproperties.htm", '<a name="enum_order_type_filling" class="hmanchor"></a>') },
        /ENUM_ORDER_TYPE_FILLING: anchor #enum_order_type_filling is not on mql5\/orderproperties/],
    ];
    for (const [extra, message] of failures) {
      await assert.rejects(update({ dir, ...options(extra) }), message);
      assert.equal(readFileSync(join(dir, "current.json"), "utf8"), currentBefore, `${message}: current.json unchanged`);
      assert.deepEqual(files(dir), ["current.json", live.index], `${message}: only the live index is left`);
    }
    assert.ok(!requested.some((url) => url.includes("attacker.example")), "the off-site host is never contacted");
    assert.equal(aborted.length, 2, "the other downloads were aborted");

    // Any open handle on current.json blocks the rename: after about 5 s of
    // retries the update fails and the old pointer and index stay.
    const handle = openSync(join(dir, "current.json"), "r");
    try {
      await assert.rejects(update({ dir, ...options() }), (error) => error.code === "EPERM");
    } finally {
      closeSync(handle);
    }
    assert.equal(readFileSync(join(dir, "current.json"), "utf8"), currentBefore);
    assert.deepEqual(files(dir), ["current.json", live.index], "the unused new index and the temporary pointer are removed");
    const db = new DatabaseSync(join(dir, live.index), { readOnly: true });
    assert.ok(db.prepare("select count(*) as n from pages").get().n > 0, "the live index still reads");
    db.close();
  });
});

test("docs:update releases its lock even when cleanup fails", async () => {
  await withData(async (dir) => {
    install(dir);
    // Make removing the work folder fail with an error cleanup doesn't skip.
    const realRm = fs.rmSync;
    fs.rmSync = (path, ...rest) => {
      if (/[\\/]work-/.test(String(path))) throw Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
      return realRm(path, ...rest);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(update({ dir, ...options({ fetchImpl: async () => new Response("down", { status: 500 }) }) }), /ENOTEMPTY/);
    } finally {
      fs.rmSync = realRm;
      syncBuiltinESMExports();
    }
    assert.ok(!files(dir).includes("update.lock"), "the next update is not blocked");
  });
});

test("docs:update stops when more than 2% of names and cards would be lost, unless accepted", async () => {
  await withData(async (dir) => {
    // More than 20, the old report's cutoff.
    const titles = Array.from({ length: 21 }, (_, i) => `ExtraPage${i}`);
    installWithExtras(dir, BOOK, titles);
    const logged = [];
    await assert.rejects(update({ dir, ...options({ log: (line) => logged.push(line) }) }),
      /The new index lacks \d+ of \d+ names and cards \(more than 2%\); run again with --accept-loss/);
    assert.deepEqual(files(dir), ["current.json", "index-a.sqlite"]);
    for (const title of titles) assert.match(logged.join("\n"), new RegExp(`\\n- ${title}(\\n|$)`), "every lost name is listed");
    const accepted = await update({ dir, ...options({ acceptLoss: true }) });
    assert.deepEqual(files(dir), ["current.json", accepted.index]);
  });
});

test("docs:update counts lost cards per page, so surviving names don't hide them", async () => {
  await withData(async (dir) => {
    // Four extra Create pages: the name Create survives on the fixture pages,
    // but four cards are lost.
    installWithExtras(dir, BOOK, ["Create", "Create", "Create", "Create"]);
    const logged = [];
    await assert.rejects(update({ dir, ...options({ log: (line) => logged.push(line) }) }), /more than 2%/);
    for (let i = 0; i < 4; i++) assert.match(logged.join("\n"), new RegExp(`\\n- Create \\(function card on book/extra${i}\\)`));
    assert.doesNotMatch(logged.join("\n"), /\n- Create(\n|$)/, "the name itself is not lost");
    assert.deepEqual(files(dir), ["current.json", "index-a.sqlite"]);
  });
});

test("lostNames reports a card lost on one page while another page keeps the name", async () => {
  await withData(async (dir) => {
    const fewer = join(dir, "fewer");
    cpSync(BOOK, fewer, { recursive: true });
    rmSync(join(fewer, "samplearrowscreate.htm"));
    buildIndex(join(dir, "live.sqlite"), [{ source: "mql5", dir: BOOK }]);
    buildIndex(join(dir, "new.sqlite"), [{ source: "mql5", dir: fewer }]);
    const live = new DatabaseSync(join(dir, "live.sqlite"), { readOnly: true });
    const fresh = new DatabaseSync(join(dir, "new.sqlite"), { readOnly: true });
    try {
      const { lost } = lostNames(live, fresh);
      assert.ok(lost.includes("Create (method card on mql5/samplearrowscreate)"), lost.join(", "));
      assert.ok(!lost.includes("Create"));
    } finally {
      live.close();
      fresh.close();
    }
  });
});

test("docs:update rebuilds an index that fails SQLite's integrity check even when nothing changed", async () => {
  await withData(async (dir) => {
    // One page overwritten, the damaged file's hash recorded, so only
    // SQLite's own check can notice. Most damage makes the check report a
    // problem; damage to the full-text index's own pages makes it throw.
    // Both must lead to a rebuild, never to "up to date".
    const clean = join(dir, "clean.sqlite");
    buildIndex(clean, [{ source: "mql5", dir: BOOK }]);
    const cleanBytes = readFileSync(clean);
    rmSync(clean);
    const damaged = (page) => Buffer.from(cleanBytes).fill(0xff, page * 4096, page * 4096 + 4096);
    const outcome = (bytes) => {
      writeFileSync(join(dir, "probe.sqlite"), bytes);
      const db = new DatabaseSync(join(dir, "probe.sqlite"), { readOnly: true });
      try {
        db.prepare("select value from meta").get();
        return db.prepare("pragma integrity_check").get().integrity_check === "ok" ? "ok" : "reports";
      } catch {
        return "throws";
      } finally {
        db.close();
      }
    };
    const chosen = {};
    for (let page = 3; page < cleanBytes.length / 4096; page++) chosen[outcome(damaged(page))] ??= page;
    rmSync(join(dir, "probe.sqlite"));
    assert.ok(chosen.throws && chosen.reports, JSON.stringify(chosen));

    const served = createHash("sha256").update(JSON.stringify({ copy: BOOK })).digest("hex");
    for (const page of [chosen.throws, chosen.reports]) {
      const name = "index-a.sqlite";
      const bytes = damaged(page);
      writeFileSync(join(dir, name), bytes);
      writeFileSync(join(dir, "current.json"), JSON.stringify({ index: name, sha256: createHash("sha256").update(bytes).digest("hex"),
        schema_version: SCHEMA_VERSION, chm: { mql5: served, book: served, nn: served }, builder_version: VERSION }));
      const opened = await openIndex(dir);
      assert.equal(opened.error, undefined, `page ${page}: hash and format still match`);
      opened.db.close();
      const result = await update({ dir, ...options() });
      assert.ok(result.index, `page ${page}: rebuilt, not reported up to date`);
      assert.deepEqual(files(dir), ["current.json", result.index]);
      rmSync(join(dir, result.index));
    }
  });
});

test("cleanup keeps the index current.json names and any index still open", async () => {
  await withData(async (dir) => {
    install(dir, "index-old.sqlite");
    const reader = new DatabaseSync(join(dir, "index-old.sqlite"), { readOnly: true });
    reader.prepare("select count(*) from pages").get();
    install(dir, "index-new.sqlite");
    writeFileSync(join(dir, "build-x.sqlite"), "left by a crash");
    cleanUp(dir, "index-new.sqlite");
    assert.deepEqual(files(dir), ["current.json", "index-new.sqlite", "index-old.sqlite"], "the open index is skipped");
    reader.close();
    cleanUp(dir, undefined);
    assert.deepEqual(files(dir), ["current.json", "index-new.sqlite", "index-old.sqlite"], "no index is deleted without a known live one");
    cleanUp(dir, ["index-new.sqlite"]);
    assert.deepEqual(files(dir), ["current.json", "index-new.sqlite", "index-old.sqlite"], "nor with a damaged index name");
    cleanUp(dir, "index-new.sqlite");
    assert.deepEqual(files(dir), ["current.json", "index-new.sqlite"]);
  });
});

test("downloads: HTTPS on www.mql5.com only, few redirects, complete and within 50 MB", async () => {
  await withData(async (dir) => {
    const file = join(dir, "x.chm");
    const redirect = (location) => async () => new Response(null, { status: 302, headers: { location } });
    await assert.rejects(download("http://www.mql5.com/files/docs/mql5.chm", file), /only https:\/\/www\.mql5\.com/);
    await assert.rejects(download("https://www.mql5.com/a.chm", file, { fetchImpl: redirect("https://evil.example/a.chm") }),
      /Refused download from https:\/\/evil\.example\/a\.chm/);
    await assert.rejects(download("https://www.mql5.com/a.chm", file, { fetchImpl: redirect("/b.chm") }), /Too many redirects/);
    const short = async () => new Response(Buffer.from("half"), { headers: { "content-length": "8" } });
    await assert.rejects(download("https://www.mql5.com/a.chm", file, { fetchImpl: short }), /incomplete \(4 of 8 bytes\)/);
    const huge = async () => new Response(Buffer.from("x"), { headers: { "content-length": String(60 * 1024 * 1024) } });
    await assert.rejects(download("https://www.mql5.com/a.chm", file, { fetchImpl: huge }), /larger than 50 MB/);
    const ok = async () => new Response(Buffer.from("chm"), { headers: { "content-length": "3" } });
    assert.equal(await download("https://www.mql5.com/a.chm", file, { fetchImpl: ok }), createHash("sha256").update("chm").digest("hex"));
  });
});

test("downloads: more than 50 MB without a Content-Length stops at the limit", async () => {
  await withData(async (dir) => {
    const work = join(dir, "work");
    mkdirSync(work);
    const MIB = 1024 * 1024;
    let sent = 0;
    // Fifty 1 MiB chunks, then one byte more, made as they are read.
    const endless = async () => new Response(new ReadableStream({
      pull(controller) {
        const size = sent < 50 * MIB ? MIB : 1;
        sent += size;
        controller.enqueue(new Uint8Array(size));
        if (sent > 50 * MIB) controller.close();
      },
    }));
    await assert.rejects(download("https://www.mql5.com/a.chm", join(work, "big.chm"), { fetchImpl: endless }), /larger than 50 MB/);
    rmSync(work, { recursive: true });
    assert.equal(existsSync(work), false, "the file is closed when the failure is reported");
  });
});

test("downloads: a failed download has closed its file when it reports the failure", async () => {
  await withData(async (dir) => {
    for (let i = 0; i < 20; i++) {
      const work = join(dir, `work-${i}`);
      mkdirSync(work);
      const file = join(work, "cut.chm");
      const cut = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
          setTimeout(() => controller.error(new Error("connection reset")), 5);
        },
      }), { headers: { "content-length": String(1024 * 1024) } });
      await assert.rejects(download("https://www.mql5.com/a.chm", file, { fetchImpl: cut }), /connection reset/);
      // A file Node still has open can be deleted on Windows, but its folder
      // can't be removed until the file is closed.
      rmSync(work, { recursive: true });
      assert.equal(existsSync(work), false);
    }
  });
});
