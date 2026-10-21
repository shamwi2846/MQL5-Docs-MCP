import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildIndex } from "../src/indexer.mjs";
import { paginate, readPage } from "../src/search.mjs";

const context = { tag: "abc1234" };
let dir;
let db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "mql5-docs-read-"));
  buildIndex(join(dir, "index.sqlite"), [{ source: "mql5", dir: join(import.meta.dirname, "fixtures", "mql5") }]);
  db = new DatabaseSync(join(dir, "index.sqlite"), { readOnly: true });
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function blocksOf(...items) {
  let heading = "";
  return items.map(([kind, text, extra = {}]) => {
    if (kind === "heading") heading = text;
    return { kind, text, heading, tableNo: null, header: null, anchors: [], ...extra };
  });
}

test("read: a whole short page with its header line", () => {
  const text = readPage(db, { id: "mql5/ordersend" }, context);
  const lines = text.split("\n");
  assert.equal(lines[0], "OrderSend · MQL5 Reference > Trade Functions > OrderSend · mql5/ordersend · page 1 of 1 · index abc1234");
  assert.equal(lines[1], "Sends a sample trade request to the trade server.");
  assert.match(text, /\nReturn Value:\nTrue when the request passes the basic check\. This does not mean it was executed\.\n- -1/);
  assert.doesNotMatch(text, /next:/);
});

test("read: focus lands on a name's anchor, an exact heading, or whole words", () => {
  const filling = readPage(db, { id: "mql5/orderproperties", focus: "ENUM_ORDER_TYPE_FILLING" }, context).split("\n");
  assert.equal(filling[1], "Sample filling policy notes.", "the anchor wins over the earlier mention");
  assert.equal(filling[2], "Fill policy | Description | The value in ENUM_ORDER_TYPE_FILLING", "a table starts with its header");
  const note = readPage(db, { id: "mql5/ordersend", focus: "note" }, context).split("\n");
  assert.equal(note[1], "Note:");
  const row = readPage(db, { id: "mql5/orderproperties", focus: "ORDER_TYPE_SELL" }, context).split("\n");
  assert.deepEqual(row.slice(1, 3), ["Identifier | Description", "ORDER_TYPE_SELL | Sample sell order"],
    "a constant's focus lands on its own row, with its table header");
  const enumColumn = readPage(db, { id: "mql5/orderproperties", focus: "ORDER_FILLING_FOK" }, context).split("\n");
  assert.equal(enumColumn[2], "Fill or Kill | All or nothing. | ORDER_FILLING_FOK", "an identifier column named by its enum counts");
});

test("read: a cell outside the identifier column does not take the focus", () => {
  // "Fill or Kill" is a Fill policy cell; the heading of that name is the target.
  const lines = readPage(db, { id: "mql5/orderproperties", focus: "Fill or Kill" }, context).split("\n");
  assert.deepEqual(lines.slice(1, 3), ["Fill or Kill:", "Sample section about all-or-nothing fills."]);
});

test("read: a focus that is not found says so and shows the start", () => {
  const lines = readPage(db, { id: "mql5/ordersend", focus: "nowhere" }, context).split("\n");
  assert.equal(lines[1], 'Focus "nowhere" not found on this page; showing its start.');
  assert.equal(lines[2], "Sends a sample trade request to the trade server.");
});

test("read: unknown and malformed ids, and pages past the end", () => {
  assert.equal(readPage(db, { id: "mql5/gone" }, context), "mql5/gone is not in the current docs (index abc1234); use mql5_find again.");
  assert.equal(readPage(db, { id: "../etc/passwd" }, context), '"../etc/passwd" is not a page id. Use mql5_find to get one.');
  assert.equal(readPage(db, { id: "mql5/ordersend", page: 3 }, context), "mql5/ordersend has 1 page; page 3 does not exist.");
});

test("paginate: pages break at blocks, long code at lines, long prose at sentences", () => {
  const code = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, "0")} of the example;`).join("\n");
  const prose = "One sentence here. ".repeat(20).trim();
  const pages = paginate(blocksOf(["heading", "Note"], ["code", code], ["paragraph", prose]), 0, 300);
  assert.ok(pages.every((page) => page.length <= 300), pages.map((page) => page.length).join(","));
  assert.ok(pages[0].startsWith("Note:\nline 00"));
  assert.match(pages[0], /;\s\(continues\)$/, "a split code block says it continues");
  assert.equal(pages.join("\n").replace(/ \(continues\)/g, "").includes("line 29 of the example;"), true);
  assert.ok(pages.some((page) => /^One sentence here\./.test(page)), "prose is split at sentences");
});

test("paginate: a table split across pages repeats its header", () => {
  const header = "Identifier | Description";
  const rows = Array.from({ length: 20 }, (_, i) => ["row", `SAMPLE_${i} | Description number ${i}`, { tableNo: 1, header }]);
  const pages = paginate(blocksOf(["heading", "Values"], ...rows), 0, 200);
  assert.ok(pages.length > 1);
  for (const page of pages.slice(1)) assert.ok(page.startsWith(`${header}\n`), page);
  assert.equal(pages.join("\n").split(header).length - 1, pages.length);
});

test("read: long pages page on, and the next call carries focus and page", () => {
  // A long page written into a temporary folder, so no large fixture is committed.
  const source = mkdtempSync(join(tmpdir(), "mql5-docs-long-"));
  try {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `<p class="p_Text"><span>Paragraph ${i} of the long sample page, written to fill several pages of text.</span></p>`).join("\n");
    writeFileSync(join(source, "long.htm"), `<html><head><title>LongSample</title></head><body><div id="help">
<p class="p_H1"><span>LongSample</span></p>${paragraphs}
<p class="p_BoldTitles"><span>Return Value</span></p>${paragraphs}</div></body></html>`);
    writeFileSync(join(source, "long.hhc"), '<ul><li><object type="text/sitemap"><param name="Name" value="LongSample"><param name="Local" value="long.htm"></object></ul>');
    writeFileSync(join(source, "long.hhk"), "<ul></ul>");
    buildIndex(join(source, "index.sqlite"), [{ source: "mql5", dir: source }]);
    const longDb = new DatabaseSync(join(source, "index.sqlite"), { readOnly: true });
    try {
      const first = readPage(longDb, { id: "mql5/long" }, context).split("\n");
      assert.match(first[0], /· mql5\/long · page 1 of \d+ · index abc1234$/);
      assert.equal(first.at(-1), "next: mql5_read id=mql5/long page=2");
      const focused = readPage(longDb, { id: "mql5/long", focus: "Return Value" }, context).split("\n");
      assert.equal(focused[1], "Return Value:");
      assert.equal(focused.at(-1), 'next: mql5_read id=mql5/long focus="Return Value" page=2');
      const second = readPage(longDb, { id: "mql5/long", focus: "Return Value", page: 2 }, context).split("\n");
      assert.match(second[0], /page 2 of \d+/);
      assert.ok(!second.includes("Return Value:"), "page 2 continues after the focus");
    } finally {
      longDb.close();
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
