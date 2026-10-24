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
import { FIND_BUDGET, findText } from "../src/find.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { readPage } from "../src/search.mjs";
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

test("real docs: section notes start with their own lead-in, not the next section's", { skip }, () => {
  const notesOf = (name, pageId) => db.prepare("select n.text from cards c join notes n on n.key = c.notes_key"
    + " where c.kind = 'constant' and c.name = ? and c.page_id = ?").get(name, pageId)?.text;
  assert.equal(notesOf("SYMBOL_FILLING_MODE", "mql5/marketinfoconstants"), "For function SymbolInfoInteger()");
  assert.equal(notesOf("SYMBOL_VOLUME_STEP", "mql5/marketinfoconstants"), "For function SymbolInfoDouble()");
  const filling = notesOf("ORDER_FILLING_IOC", "mql5/orderproperties");
  assert.match(filling, /ORDER_FILLING_RETURN filling type should be used regardless/);
  assert.doesNotMatch(filling, /type_time/, "the next section's lead-in stays with ENUM_ORDER_TYPE_TIME");
  assert.match(notesOf("ORDER_TIME_GTC", "mql5/orderproperties"), /^The order validity period can be set in the type_time field/);
});

test("real docs: later declarations of a page's own function stay in its card", { skip }, () => {
  const card = (pageId) => db.prepare("select full, brief from cards where page_id = ?").get(pageId);
  const color = card("mql5/caxiscolor");
  assert.match(color.full, /\nSets the axis color\.\nvoid {2}Color\(/, "the setter after the getter");
  assert.match(color.brief, /^color Color\(\) \(\+1 overloads\)/);
  assert.match(card("mql5/ontesterinit").full, /\nvoid {2}OnTesterInit\(void\);\n/, "the old void form");
  assert.equal((card("mql5/graphplot").full.match(/^string {2}GraphPlot\(/gm) ?? []).length, 10, "all ten overloads");
  assert.equal((card("mql5/cchartobjectsetdouble").full.match(/^bool {2}SetDouble\(/gm) ?? []).length, 2, "the overload under Parameters");
  assert.equal((card("mql5/matrix_gemm").full.match(/^bool (matrix|vector)<T>::GeMM\(/gm) ?? []).length, 4, "the template forms in the Note");
});

test("real docs: enum and property answers show the asked part", { skip }, () => {
  const context = { tag: "realtst", downloaded: "today" };
  const [, filling, buffers, file] = findText(db, ["ENUM_ORDER_TYPE_FILLING", "indicator_buffers", "tester_file"], context).split("\n\n");
  assert.match(filling, /In case of pending orders, the ORDER_FILLING_RETURN filling type should be used regardless/, "the section's last rule");
  assert.match(buffers, /\nindicator_buffers \| int \| /);
  assert.match(file, /\ntester_file \| string \| /);
});

test("real docs: a name with its own section on another item's page gets that section", { skip }, () => {
  const context = { tag: "realtst", downloaded: "today" };
  const [, country, event, flags, open] = findText(db, ["MqlCalendarCountry", "MqlCalendarEvent", "ENUM_DATABASE_OPEN_FLAGS", "DatabaseOpen"], context).split("\n\n");
  assert.match(country, /^= MqlCalendarCountry · struct · /);
  assert.match(event, /\nstruct MqlCalendarEvent\n/);
  assert.doesNotMatch(event, /struct MqlCalendarCountry/);
  assert.match(flags, /\nDATABASE_OPEN_READONLY \| /);
  assert.match(open, /^= DatabaseOpen · function · /);
});

test("real docs: a comparison column defines no constants", { skip }, () => {
  const count = db.prepare("select count(*) as n from cards where kind = 'constant' and name like 'D3D11!_%' escape '!'").get().n;
  assert.equal(count, 0);
});

test("real docs: reading splits a long example and lands on a constant deep in a table", { skip }, () => {
  const context = { tag: "realtst" };
  const first = readPage(db, { id: "mql5/databaseexecute" }, context);
  const pages = Number(/page 1 of (\d+)/.exec(first)[1]);
  assert.ok(pages >= 7, `DatabaseExecute has ${pages} pages`);
  for (let page = 1; page <= pages; page++) {
    const text = readPage(db, { id: "mql5/databaseexecute", page }, context);
    assert.ok(text.length <= 4300, `page ${page} is ${text.length} characters`);
  }
  const error = readPage(db, { id: "mql5/errorcodes", focus: "ERR_USER_ERROR_FIRST" }, context).split("\n");
  assert.ok(error.slice(1, 4).some((line) => line.includes("ERR_USER_ERROR_FIRST")), error.slice(0, 4).join("\n"));
});

test("real docs: find keeps names apart and every reply within the budget", { skip }, () => {
  const context = { tag: "realtst", downloaded: "2026-10-21" };
  const [, create] = findText(db, ["Create"], context).split("\n\n");
  assert.match(create, /^= Create · \d{3} pages share this name: .*\. Ask with Class::Method\.$/, "104 class methods, no global winner");
  const [, indicator] = findText(db, ["CiAC::Create"], context).split("\n\n");
  assert.match(indicator, /^= CiAC::Create · method · mql5\/ciaccreate\n/);
  const huge = findText(db, ["DynamicModeDecompositionQR"], context);
  assert.ok(huge.length <= FIND_BUDGET, `${huge.length}`);
  assert.match(huge, /\n\[continues: mql5_read id=mql5\/dynamicmodedecompositionqr focus=\w+\]$/);
  const [, phrase] = findText(db, ["global variables"], context).split("\n\n");
  assert.match(phrase, /\nOther pages: Global Variables of the Terminal \(mql5\/globals\)/, "the case-matched title and the terminal's global variables");
  const [, method] = findText(db, ["how to close an open position with CTrade"], context).split("\n\n");
  assert.match(method, /^~ [^\n]*best match: PositionClose · mql5\/ctradepositionclose\n/);
  const names = loadBaseline().names.filter((entry) => entry.kind !== "none").slice(0, 16).map((entry) => entry.name);
  const batch = findText(db, names, context);
  assert.ok(batch.length <= FIND_BUDGET, `${batch.length}`);
  assert.equal(batch.match(/^= /gm).length, 16, "every name keeps its outcome line");
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
