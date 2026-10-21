import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildIndex, decodePage, parsePage, parseSitemap, SCHEMA_VERSION } from "../src/indexer.mjs";

const fixtures = join(import.meta.dirname, "fixtures", "mql5");
const fixturePage = (file) => parsePage(decodePage(readFileSync(join(fixtures, file))));

test("decodePage uses the declared charset", () => {
  const html = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>a'), Buffer.from([0x96]), Buffer.from("b</p>")]);
  assert.match(decodePage(html), /a–b/);
  assert.throws(() => decodePage(Buffer.from('<meta charset="no-such-charset">')), RangeError);
});

test("parseSitemap keeps nesting, multiple targets and decoded names", () => {
  const toc = parseSitemap(readFileSync(join(fixtures, "mql5.hhc"), "latin1"));
  const buy = toc.find((entry) => entry.name === "Buy");
  assert.deepEqual(buy.parents, ["MQL5 Reference", "Trade Classes & Helpers", "CTrade"]);
  assert.deepEqual(toc.find((entry) => entry.name === "Order Properties").parents, ["MQL5 Reference"]);
  const keywords = parseSitemap(readFileSync(join(fixtures, "mql5.hhk"), "latin1"));
  assert.deepEqual(keywords.find((entry) => entry.name === "Trading").targets, ["ordersend.htm", "CTrade.htm"]);
});

test("parsePage turns a function page into ordered blocks", () => {
  const page = fixturePage("ordersend.htm");
  assert.equal(page.title, "OrderSend");
  assert.deepEqual(page.keywords, ["OrderSend", "MqlTradeRequest"]);
  assert.deepEqual(page.blocks.map((block) => block.kind),
    ["paragraph", "code", "heading", "paragraph", "paragraph", "heading", "paragraph", "paragraph", "paragraph",
      "paragraph", "heading", "paragraph", "paragraph", "paragraph", "heading", "paragraph"]);
  assert.equal(page.blocks[0].text, "Sends a sample trade request to the trade server.");
  assert.equal(page.blocks[1].text,
    "bool  OrderSend(\n   MqlTradeRequest& request,  // what to do\n   MqlTradeResult&  result\n   );");
  assert.equal(page.blocks[4].heading, "Parameters");
  assert.equal(page.blocks[4].text, "[in] The request to send.");
  assert.equal(page.blocks[6].text, "True when the request passes the basic check. This does not mean it was executed.");
  assert.deepEqual(page.blocks.slice(7, 10).map((block) => [block.heading, block.text]), [
    ["Return Value", "- -1, if the sample check fails;"],
    ["Return Value", "- 0, if it passes."],
    ["Return Value", "- a nested detail"],
  ], "list items, including nested ones, are kept under their heading");
  assert.deepEqual(page.blocks.slice(11, 14).map((block) => block.text),
    ["Check the result structure after every call.", "1. Send the request.", "2. Read the result."]);
  assert.ok(!page.blocks.some((block) => block.text.includes("MQL5 Reference")), "navigation outside #help is skipped");
});

test("parsePage keeps anchors and table header rows", () => {
  const page = fixturePage("orderproperties.htm");
  const enumName = page.blocks.find((block) => block.text === "ENUM_ORDER_TYPE");
  assert.deepEqual(enumName.anchors, ["enum_order_type"]);
  const rows = page.blocks.filter((block) => block.kind === "row");
  assert.deepEqual(rows.map((row) => row.text), ["ORDER_TYPE_BUY | Sample buy order", "ORDER_TYPE_SELL | Sample sell order"]);
  assert.ok(rows.every((row) => row.header === "Identifier | Description" && row.tableNo === 1));
  assert.deepEqual(rows.map((row) => row.anchors), [[], ["order_type_sell"]], "an anchor inside a row stays on that row");
  assert.equal(page.blocks.at(-1).text, "Sample notes after the table.");
});

test("parsePage reads method owners from the declarations only", () => {
  assert.deepEqual(fixturePage("matrix_copyrates.htm").owners, ["matrix", "vector"]);
  assert.deepEqual(fixturePage("copyrates.htm").owners, []);
});

test("parsePage keeps header-styled rows that hold content", () => {
  const rows = fixturePage("ctrade.htm").blocks.filter((block) => block.kind === "row");
  assert.deepEqual(rows.map((row) => [row.text, row.header]), [
    ["Methods inherited from class CSample Load, Save, Clear, Compare, Type", null],
    ["Methods inherited from class CBase Next, Prev", null],
  ]);
});

test("buildIndex stores pages, blocks, names and searchable sections", () => {
  const dir = mkdtempSync(join(tmpdir(), "mql5-docs-index-"));
  const dbPath = join(dir, "index.sqlite");
  try {
    buildIndex(dbPath, [{ source: "mql5", dir: fixtures }], { builder_version: "test" });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const all = (sql, ...args) => db.prepare(sql).all(...args);
      assert.deepEqual(all("select id from pages order by id").map((row) => row.id),
        ["mql5/cfilecopy", "mql5/copyrates", "mql5/ctrade", "mql5/ctradebuy", "mql5/matrix_copy", "mql5/matrix_copyrates",
          "mql5/orderproperties", "mql5/ordersend"]);
      assert.equal(all("select breadcrumb from pages where id = 'mql5/ctradebuy'")[0].breadcrumb,
        "MQL5 Reference > Trade Classes & Helpers > CTrade > Buy");

      const names = (name) => all("select page_id, kind, member, anchor from names where name = ? order by page_id, kind", name)
        .map((row) => ({ ...row }));
      assert.deepEqual(names("CTrade::Buy"), [{ page_id: "mql5/ctradebuy", kind: "member", member: 1, anchor: null }]);
      assert.deepEqual(names("Buy"), [{ page_id: "mql5/ctradebuy", kind: "title", member: 1, anchor: null }]);
      assert.deepEqual(names("matrix::CopyRates"), [{ page_id: "mql5/matrix_copyrates", kind: "member", member: 1, anchor: null }]);
      assert.deepEqual(names("vector::CopyRates").map((row) => row.page_id), ["mql5/matrix_copyrates"]);
      assert.deepEqual(names("CopyRates").map((row) => [row.page_id, row.member]),
        [["mql5/copyrates", 0], ["mql5/matrix_copyrates", 1]], "the global function is not a member");
      assert.deepEqual(names("ENUM_ORDER_TYPE"), [{ page_id: "mql5/orderproperties", kind: "keyword", member: 0, anchor: "enum_order_type" }]);
      assert.deepEqual(names("Trading").map((row) => row.page_id), ["mql5/ctrade", "mql5/ordersend"]);
      assert.deepEqual(all("select page_id from names where name = 'Trading' order by seq").map((row) => row.page_id),
        ["mql5/ordersend", "mql5/ctrade"], "seq keeps keyword-index order");
      assert.deepEqual(names("OrderSend"), [{ page_id: "mql5/ordersend", kind: "title", member: 0, anchor: null }],
        "the same name and page is stored once");
      assert.equal(names("Missing").length, 0, "keyword targets without a page are skipped");
      assert.equal(all("select page_id from names where lower = 'ordersend'")[0].page_id, "mql5/ordersend");

      assert.equal(all("select count(*) as n from blocks where page_id = 'mql5/ordersend'")[0].n, 16);
      const hits = all("select page_id, heading from sections where sections match ? order by rank", '"executed"');
      assert.deepEqual(hits.map((row) => ({ ...row })), [{ page_id: "mql5/ordersend", heading: "Return Value" }]);
      assert.equal(all("select value from meta where key = 'schema_version'")[0].value, String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildIndex rolls back and reports a missing table of contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "mql5-docs-index-"));
  try {
    assert.throws(() => buildIndex(join(dir, "index.sqlite"), [{ source: "mql5", dir }]), /No \.hhc file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
