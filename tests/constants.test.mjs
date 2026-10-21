import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constantCards } from "../src/cards.mjs";
import { checkBaseline } from "../src/checks.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { mainPage, rankPages } from "../src/names.mjs";

function blocksOf(...items) {
  let heading = "";
  return items.map(([kind, text, extra = {}]) => {
    if (kind === "heading") heading = text;
    return { kind, text, heading, tableNo: null, header: null, anchors: [], ...extra };
  });
}

test("constant cards: values, labelled descriptions and capped siblings", () => {
  const header = "Code | Constant | Description";
  const rows = Array.from({ length: 12 }, (_, i) => ["row", `${10000 + i} | SAMPLE_CODE_${i} | Sample ${i}`, { tableNo: 1, header }]);
  const cards = constantCards({ id: "mql5/codes" }, blocksOf(["paragraph", "Sample codes."], ...rows), () => null);
  assert.equal(cards.length, 12);
  const first = cards[0];
  assert.deepEqual([first.name, first.value, first.enum], ["SAMPLE_CODE_0", "10000", null]);
  assert.equal(first.full, [
    "Sample 0",
    "Other values: SAMPLE_CODE_1, SAMPLE_CODE_2, SAMPLE_CODE_3, SAMPLE_CODE_4, SAMPLE_CODE_5, SAMPLE_CODE_6, SAMPLE_CODE_7, "
      + "SAMPLE_CODE_8, SAMPLE_CODE_9, SAMPLE_CODE_10 (+1 more: mql5_read id=mql5/codes focus=SAMPLE_CODE_0)",
    "More: mql5_read id=mql5/codes focus=SAMPLE_CODE_0",
  ].join("\n"));
  assert.equal(first.notes, "Sample codes.");

  const labelled = constantCards({ id: "mql5/dx" }, blocksOf(
    ["row", "DX_A | 1 | D3D11_A", { tableNo: 1, header: "ID | Value | Match in D3D11_SAMPLE" }],
  ), () => null);
  assert.equal(labelled[0].full.split("\n")[0], "Match in D3D11_SAMPLE: D3D11_A", "other columns keep their label");
});

test("constant cards: only the authored identifier column defines constants", () => {
  const blocks = blocksOf(
    ["row", "Return | Rest stays. | ORDER_FILLING_RETURN", { tableNo: 1, header: "Fill policy | Description | The value in ENUM_ORDER_TYPE_FILLING" }],
    ["row", "MARKET_MODE | + | -", { tableNo: 2, header: "Mode | FOK | Return" }],
    ["row", "PRICE | Not a constant", { tableNo: 3, header: "Field | Description" }],
    ["row", "lowercase | Not a constant", { tableNo: 4, header: "Identifier | Description" }],
  );
  const cards = constantCards({ id: "mql5/props" }, blocks, () => null);
  assert.deepEqual(cards.map((card) => [card.name, card.enum]), [["ORDER_FILLING_RETURN", "ENUM_ORDER_TYPE_FILLING"]]);
  assert.equal(cards[0].full.split("\n")[0], "Fill policy: Return — Rest stays.");
});

test("constant cards: the enum comes from the section anchor, only for the section's first table", () => {
  const enumOfAnchor = (anchor) => ({ enum_sample: "ENUM_SAMPLE" })[anchor] ?? null;
  const blocks = blocksOf(
    ["paragraph", "ENUM_SAMPLE", { anchors: ["enum_sample"] }],
    ["row", "SAMPLE_A | First", { tableNo: 1, header: "Identifier | Description" }],
    ["paragraph", "Section prose."],
    ["row", "SAMPLE_X | Later table", { tableNo: 2, header: "Identifier | Description" }],
    ["paragraph", "Next section", { anchors: ["other"] }],
  );
  const cards = constantCards({ id: "mql5/props" }, blocks, enumOfAnchor);
  assert.deepEqual(cards.map((card) => [card.name, card.enum, card.anchor]),
    [["SAMPLE_A", "ENUM_SAMPLE", "enum_sample"], ["SAMPLE_X", null, "enum_sample"]]);
  assert.equal(cards[0].notes, "Section prose.", "the bare enum label is not a note");
  assert.equal(cards[0].notesKey, "mql5/props#0");
});

let dir;
let db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "mql5-docs-constants-"));
  buildIndex(join(dir, "index.sqlite"), [{ source: "mql5", dir: join(import.meta.dirname, "fixtures", "mql5") }]);
  db = new DatabaseSync(join(dir, "index.sqlite"), { readOnly: true });
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const constantCard = (name, pageId) =>
  db.prepare("select value, enum, notes_key, full from cards where kind = 'constant' and name = ? and page_id = ?").get(name, pageId);
const notesOf = (card) => db.prepare("select text from notes where key = ?").get(card.notes_key)?.text;

test("built index: section notes keep conditions the row leaves out", () => {
  const card = constantCard("ORDER_FILLING_RETURN", "mql5/orderproperties");
  assert.equal(card.enum, "ENUM_ORDER_TYPE_FILLING");
  assert.match(card.full, /Not allowed in Market mode\./);
  assert.equal(notesOf(card), "Sample filling policy notes.\nThe execution-mode table follows.\nPending orders use Return regardless of the mode.");
  assert.equal(constantCard("ORDER_FILLING_FOK", "mql5/orderproperties").notes_key, card.notes_key, "one notes entry per section");
  assert.equal(constantCard("ORDER_TIME_GTC", "mql5/orderproperties").enum, "ENUM_ORDER_TYPE_TIME");
  const buy = constantCard("ORDER_TYPE_BUY", "mql5/orderproperties");
  assert.equal(buy.enum, "ENUM_ORDER_TYPE");
  assert.match(notesOf(buy), /Sample notes after the table\./, "an anchored row does not end its table's section");
  assert.equal(constantCard("MARKET_MODE", "mql5/orderproperties"), undefined, "a matrix table defines no constants");
});

test("built index: page-level enums, values, flags and linked identifiers", () => {
  assert.equal(constantCard("SUNDAY", "mql5/enum_day_sample").enum, "ENUM_DAY_SAMPLE", "a linked identifier cell counts");
  assert.equal(constantCard("DX_SAMPLE_POINT", "mql5/enum_day_sample").value, "1");
  assert.equal(constantCard("D3D11_SAMPLE_POINT", "mql5/enum_day_sample"), undefined, "a comparison column defines nothing");
  assert.equal(constantCard("DX_SAMPLE_POINT", "mql5/enum_day_sample").enum, null, "a table under a heading gets no page-level enum");
  assert.ok(constantCard("FONT_SAMPLE_ITALIC", "mql5/enum_day_sample"));
  assert.equal(constantCard("PRICE", "mql5/enum_day_sample"), undefined);
  const done = constantCard("TRADE_RETCODE_DONE", "mql5/enum_trade_return_codes");
  assert.equal(done.value, "10009");
  assert.equal(done.enum, null, "an enum defined in its own section on the page is not the page's enum");
  assert.equal(constantCard("CRYPT_SAMPLE_A", "mql5/enum_trade_return_codes").enum, "ENUM_SAMPLE_CRYPT");
  assert.equal(db.prepare("select count(*) as n from cards where page_id = 'mql5/constant_indices'").get().n, 0, "summary pages make no cards");
});

test("main page: never a summary page, global before member, title first", () => {
  assert.equal(mainPage(db, "TRADE_RETCODE_DONE").page_id, "mql5/enum_trade_return_codes");
  assert.equal(mainPage(db, "CopyRates").page_id, "mql5/copyrates");
  assert.deepEqual(rankPages(db, "CopyRates").map((row) => row.page_id), ["mql5/copyrates", "mql5/matrix_copyrates"]);
  assert.equal(mainPage(db, "ORDER_TYPE_BUY").anchor, "enum_order_type");
  assert.equal(mainPage(db, "ENUM_ORDER_TYPE_FILLING").anchor, "enum_order_type_filling",
    "an earlier unanchored keyword row does not hide the enum's anchor");
  assert.equal(mainPage(db, "ORDER_TYPE_SELL").anchor, "order_type_sell", "an anchor named like the name wins");
  assert.equal(mainPage(db, "NoSuchName"), null);
});

test("checkBaseline reports every mismatch", () => {
  const good = { names: [
    { name: "OrderSend", page: "mql5/ordersend", kind: "function", phrases: ["This does not mean it was executed."] },
    { name: "TRADE_RETCODE_DONE", page: "mql5/enum_trade_return_codes", kind: "constant", value: "10009", enum: null },
    { name: "ORDER_FILLING_RETURN", page: "mql5/orderproperties", kind: "constant", enum: "ENUM_ORDER_TYPE_FILLING",
      phrases: ["regardless of the mode"] },
    { name: "Order Properties", page: "mql5/orderproperties", kind: "none" },
  ] };
  assert.deepEqual(checkBaseline(db, good), []);
  const bad = { names: [
    { name: "TRADE_RETCODE_DONE", page: "mql5/constant_indices" },
    { name: "TRADE_RETCODE_REQUOTE", page: "mql5/enum_trade_return_codes", kind: "function", value: "1", enum: "ENUM_X",
      phrases: ["missing"] },
    { name: "Gone", page: "mql5/gone" },
  ] };
  assert.deepEqual(checkBaseline(db, bad), [
    "TRADE_RETCODE_DONE: main page mql5/enum_trade_return_codes, expected mql5/constant_indices",
    "TRADE_RETCODE_REQUOTE: kind constant, expected function",
    "TRADE_RETCODE_REQUOTE: value 10004, expected 1",
    "TRADE_RETCODE_REQUOTE: enum null, expected ENUM_X",
    "TRADE_RETCODE_REQUOTE: card lacks \"missing\"",
    "Gone: not found",
  ]);
});
