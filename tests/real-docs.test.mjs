// Checks cards built from the real documentation with the current code. The
// docs can't be committed, so this runs only on a PC that has the Reference
// unpacked (a folder with mql5.hhc, mql5.hhk and the pages):
//   set MQL5_DOCS_REFERENCE=<that folder> && npm test
// It builds a fresh index from that folder, so it always tests the current
// indexer and cards.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkBaseline } from "../src/checks.mjs";
import { loadBaseline } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { missingFromCard } from "./helpers.mjs";

const reference = process.env.MQL5_DOCS_REFERENCE;
const skip = !reference && "set MQL5_DOCS_REFERENCE to the unpacked Reference";

const SAMPLE_PAGES = {
  "mql5/ordersend": ["not a sign of successful execution"],
  "mql5/ontick": ["code example cut"],
  "mql5/copybuffer": ["Call by the first position"],
  "mql5/print": ["optimization"],
  "mql5/ontradetransaction": ["is not guaranteed"],
  "mql5/mqltraderequest": ["Fields:"],
  "mql5/ctrade": ["Operations with orders:"],
  "mql5/cexpert": ["Note:"],
  "mql5/dynamicmodedecompositionqr": [],
  "mql5/databaseexecute": ["code example cut"],
};

let dir;
let db;
before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "mql5-docs-real-"));
  buildIndex(join(dir, "index.sqlite"), [{ source: "mql5", dir: reference }]);
  db = new DatabaseSync(join(dir, "index.sqlite"), { readOnly: true });
});
after(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("real docs: the sample cards are complete", { skip }, () => {
  const blocksOf = db.prepare("select kind, text, heading, table_no as tableNo, header from blocks where page_id = ? order by pos");
  for (const [pageId, phrases] of Object.entries(SAMPLE_PAGES)) {
    const card = db.prepare("select kind, full, brief from cards where page_id = ?").get(pageId);
    assert.ok(card, `${pageId} has a card`);
    assert.deepEqual(missingFromCard(card, blocksOf.all(pageId)), [], `${pageId} is complete`);
    for (const phrase of phrases) assert.ok(card.full.includes(phrase), `${pageId} contains "${phrase}"`);
    assert.ok(card.brief.length <= 380, `${pageId} brief is ${card.brief.length} characters`);
  }
});

test("real docs: every baseline name resolves with its kind, value, enum and phrases", { skip }, () => {
  assert.deepEqual(checkBaseline(db, loadBaseline()), []);
});

test("real docs: a comparison column defines no constants", { skip }, () => {
  const count = db.prepare("select count(*) as n from cards where kind = 'constant' and name like 'D3D11!_%' escape '!'").get().n;
  assert.equal(count, 0);
});

test("real docs: briefs keep their signature or a read pointer", { skip }, () => {
  const brief = (pageId) => db.prepare("select brief from cards where page_id = ?").get(pageId).brief;
  assert.match(brief("mql5/matrix_replacetozero"), /^ulong vector::ReplaceToZero\(.*\);? \(\+7 overloads\)\n/);
  assert.match(brief("mql5/ontradetransaction"),
    /^void OnTradeTransaction\(const MqlTradeTransaction& trans, const MqlTradeRequest& request, const MqlTradeResult& result\);\n/);
  const find = brief("mql5/filefindfirst");
  assert.ok(find.length <= 380);
  assert.match(find, /^long FileFindFirst\(|\(signature: mql5_read id=mql5\/filefindfirst\)$/);
});
