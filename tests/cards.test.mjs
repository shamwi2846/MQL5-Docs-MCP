import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compactSignature, firstSentence, pageCard, splitDeclarations } from "../src/cards.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { missingFromCard } from "./helpers.mjs";

// Blocks as the indexer stores them; each block remembers the heading above it.
function blocksOf(...items) {
  let heading = "";
  return items.map(([kind, text, extra = {}]) => {
    if (kind === "heading") heading = text;
    return { kind, text, heading, tableNo: null, header: null, ...extra };
  });
}
const resolveName = (name) => ({ OrderCheck: "mql5/ordercheck" })[name] ?? null;

test("firstSentence and compactSignature", () => {
  assert.equal(firstSentence("Sends a request. Then waits."), "Sends a request.");
  assert.equal(firstSentence("No full stop here"), "No full stop here");
  assert.equal(compactSignature("bool  Buy(\n   double  volume,   // volume\n   const string  symbol=NULL  // symbol\n   )"),
    "bool Buy(double volume, const string symbol=NULL)");
});

test("a function card keeps all prose, pairs parameters and cuts only code", () => {
  const card = pageCard({ id: "mql5/sample", title: "SampleSend", member: 0 }, blocksOf(
    ["paragraph", "Sends a sample request. It is queued first."],
    ["code", "bool  SampleSend(\n   int  volume,   // volume\n   string  symbol=NULL\n   );"],
    ["heading", "Parameters"],
    ["paragraph", "volume"], ["paragraph", "[in] Requested volume."],
    ["paragraph", "symbol=NULL"], ["paragraph", "[in] Symbol; the current one when empty."],
    ["heading", "Return Value"],
    ["paragraph", "True after the basic check. This is not a sign of execution."],
    ["paragraph", "- 0, if it passes."],
    ["heading", "Note"],
    ["paragraph", "Check the result every time."],
    ["paragraph", "Example:"],
    ["code", "SampleSend(1);"], ["code", "SampleSend(2);"],
    ["heading", "The symbol should be selected first."],
    ["heading", "See also"],
    ["paragraph", "OrderCheck, Unknown Page"],
  ), resolveName);
  assert.equal(card.name, "SampleSend");
  assert.equal(card.kind, "function");
  assert.equal(card.full, [
    "Sends a sample request. It is queued first.",
    "bool  SampleSend(\n   int  volume,   // volume\n   string  symbol=NULL\n   );",
    "Parameters:",
    "volume [in] Requested volume.",
    "symbol=NULL [in] Symbol; the current one when empty.",
    "Return Value:",
    "True after the basic check. This is not a sign of execution.",
    "- 0, if it passes.",
    "Note:",
    "Check the result every time.",
    "Example:",
    "[2 code examples cut, 28 characters: mql5_read id=mql5/sample focus=Note]",
    "The symbol should be selected first.:",
    "See also: OrderCheck (mql5/ordercheck), Unknown Page",
  ].join("\n"));
  assert.equal(card.brief, "bool SampleSend(int volume, string symbol=NULL);\nSends a sample request.\nReturns: True after the basic check.");
});

test("a method card names overloads and keeps their headings", () => {
  const card = pageCard({ id: "mql5/csamplecopy", title: "Copy", member: 1 }, blocksOf(
    ["paragraph", "Copies data."],
    ["heading", "Call by position"], ["code", "int  Copy(int start);"],
    ["heading", "Call by date"], ["code", "int  Copy(datetime from);"],
    ["heading", "Return Value"], ["paragraph", "The number of copied elements."],
  ), resolveName);
  assert.equal(card.kind, "method");
  assert.match(card.full, /^Copies data\.\nCall by position:\nint {2}Copy\(int start\);\nCall by date:\nint {2}Copy\(datetime from\);\nReturn Value:/);
  assert.match(card.brief, /^int Copy\(int start\); \(\+1 overloads\)\n/);
});

test("a brief card replaces a signature that does not fit by a read pointer", () => {
  const long = `void  Big(\n${Array.from({ length: 20 }, (_, i) => `   double  argument_number_${i},`).join("\n")}\n   );`;
  const card = pageCard({ id: "mql5/big", title: "Big", member: 0 }, blocksOf(
    ["paragraph", "Does a lot."], ["code", long], ["heading", "Return Value"], ["paragraph", "Nothing."],
  ), resolveName);
  assert.equal(card.brief, "Does a lot.\nReturns: Nothing.\n(signature: mql5_read id=mql5/big)");
});

test("a long brief is shortened at a word and keeps its read pointer", () => {
  const long = `void  Big(\n${Array.from({ length: 20 }, (_, i) => `   double  argument_number_${i},`).join("\n")}\n   );`;
  const card = pageCard({ id: "mql5/big", title: "Big", member: 0 }, blocksOf(
    ["paragraph", `Starts ${"a long search ".repeat(20)}here.`], ["code", long],
    ["heading", "Return Value"], ["paragraph", `Returns ${"a handle ".repeat(20)}or INVALID_HANDLE.`],
  ), resolveName);
  assert.ok(card.brief.length <= 380, `brief is ${card.brief.length} characters`);
  assert.match(card.brief, /…\n\(signature: mql5_read id=mql5\/big\)$/);
});

test("declarations sharing one code block count as overloads", () => {
  const block = "ulong vector::Zero(\n  const double tol   // tolerance\n   );\n\nulong vectorf::Zero(\n  const float tol\n   );\n\nulong matrix::Zero(const double tol);";
  assert.equal(splitDeclarations(`#include <x.mqh>\n${block}`).length, 4);
  const card = pageCard({ id: "mql5/matrix_zero", title: "Zero", member: 1 }, blocksOf(
    ["paragraph", "Zeroes small values."], ["code", block], ["heading", "Return Value"], ["paragraph", "The count."],
  ), resolveName);
  assert.match(card.brief, /^ulong vector::Zero\(const double tol\); \(\+2 overloads\)\n/);
});

test("parameters printed after empty parentheses stay with their declaration", () => {
  const block = "void  OnSample()\n   const MqlA&  a,   // first\n   const MqlB&  b    // second\n   );";
  assert.deepEqual(splitDeclarations(block), [block]);
  const card = pageCard({ id: "mql5/onsample", title: "OnSample", member: 0 }, blocksOf(
    ["paragraph", "Handles a sample event."], ["code", block], ["heading", "Return Value"], ["paragraph", "No return value"],
  ), resolveName);
  assert.match(card.brief, /^void OnSample\(const MqlA& a, const MqlB& b\);\n/);
  assert.equal(compactSignature("int  Count() const;"), "int Count() const;", "a const method is left alone");
});

test("a class card keeps the page's Note", () => {
  const blocks = blocksOf(
    ["paragraph", "CSample is a base class."],
    ["heading", "Description"], ["paragraph", "It manages one position per symbol."],
    ["heading", "Note"], ["paragraph", "Only positions with its magic number are managed."],
    ["heading", "Declaration"], ["code", "class CSample : public CObject"],
    ["heading", "Class methods by groups"],
    ["row", "Init | Initializes the object", { tableNo: 1, header: "Initialization | " }],
    ["row", "virtual InitSignal | Initializes the signal", { tableNo: 1, header: "Initialization | " }],
  );
  const card = pageCard({ id: "mql5/csample", title: "CSample", member: 0 }, blocks, resolveName);
  assert.match(card.full, /Note:\nOnly positions with its magic number are managed\./);
  assert.match(card.full, /- virtual InitSignal: Initializes the signal/, "qualified method names are kept");
  assert.deepEqual(missingFromCard(card, blocks), []);
  const withoutInit = { ...card, full: card.full.replace("- Init: ", "- ") };
  assert.deepEqual(missingFromCard(withoutInit, blocks), ["Init | Initializes the object [Init]"],
    "a missing method name is caught even when a longer word contains it");
});

test("a class card lists methods under their groups", () => {
  const header = "Setting parameters | ";
  const card = pageCard({ id: "mql5/csample", title: "CSample", member: 0 }, blocksOf(
    ["paragraph", "CSample is a sample class."],
    ["heading", "Declaration"], ["code", "class CSample : public CObject"],
    ["heading", "Title"], ["code", "#include <Sample\\Sample.mqh>"],
    ["row", "Inheritance hierarchy CObject CSample", { tableNo: 1 }],
    ["heading", "Class methods by groups"],
    ["row", "LogLevel | Sets logging level", { tableNo: 2, header }],
    ["row", "Operations with orders | ", { tableNo: 2, header }],
    ["row", "OrderOpen | Places a pending order", { tableNo: 2, header }],
  ), resolveName);
  assert.equal(card.kind, "class");
  assert.equal(card.full, [
    "#include <Sample\\Sample.mqh>", "class CSample : public CObject", "CSample is a sample class.",
    "Setting parameters:", "- LogLevel: Sets logging level",
    "Operations with orders:", "- OrderOpen: Places a pending order",
  ].join("\n"));
  assert.equal(card.brief, "class CSample : public CObject\nCSample is a sample class.");
});

test("a struct card takes its name from the definition and lists its fields", () => {
  const header = "Field | Description";
  const card = pageCard({ id: "mql5/mqlsample", title: "Sample Request Structure", member: 0 }, blocksOf(
    ["paragraph", "Requests are sent in this structure."],
    ["code", "struct MqlSample\n  {\n   double  volume;\n  };"],
    ["paragraph", "Fields description"],
    ["row", "volume | Requested volume in lots.", { header }],
    ["heading", "Note"], ["paragraph", "Fill every field."], ["code", "MqlSample r={};"],
  ), resolveName);
  assert.equal(card.name, "MqlSample");
  assert.equal(card.kind, "struct");
  assert.equal(card.full, [
    "struct MqlSample\n  {\n   double  volume;\n  };", "Fields:", "- volume: Requested volume in lots.",
    "Requests are sent in this structure.", "Note:", "Fill every field.",
    "[code example cut, 15 characters: mql5_read id=mql5/mqlsample focus=Note]",
  ].join("\n"));
});

test("pages that are not a function, class or struct get no card", () => {
  assert.equal(pageCard({ id: "mql5/props", title: "Order Properties", member: 0 },
    blocksOf(["paragraph", "Text."], ["row", "ORDER_TYPE_BUY | Buy", { header: "Identifier | Description" }]), resolveName), null);
  assert.equal(pageCard({ id: "mql5/intro", title: "Intro", member: 0 },
    blocksOf(["paragraph", "Text."], ["code", "Intro(1);"]), resolveName), null, "no Parameters or Return Value heading");
});

test("buildIndex stores complete cards and links See also only when it is clear", () => {
  const dir = mkdtempSync(join(tmpdir(), "mql5-docs-cards-"));
  try {
    buildIndex(join(dir, "index.sqlite"), [{ source: "mql5", dir: join(import.meta.dirname, "fixtures", "mql5") }]);
    const db = new DatabaseSync(join(dir, "index.sqlite"), { readOnly: true });
    try {
      const card = db.prepare("select name, kind, full, brief from cards where page_id = 'mql5/ordersend'").get();
      assert.equal(card.name, "OrderSend");
      assert.equal(card.kind, "function");
      assert.match(card.full, /Return Value:\nTrue when the request passes the basic check\. This does not mean it was executed\./);
      assert.match(card.brief, /^bool OrderSend\(MqlTradeRequest& request, MqlTradeResult& result\);\n/);
      assert.match(card.full, /See also: CopyRates \(mql5\/copyrates\), Copy$/, "a single global title links; an ambiguous name stays plain");
      const matrix = db.prepare("select full from cards where page_id = 'mql5/matrix_copyrates'").get();
      assert.match(matrix.full, /See also: Copy \(mql5\/matrix_copy\), CopyRates \(mql5\/copyrates\)$/, "the page's own owner wins");

      // Every card built from the sample HTML carries all of its page's text.
      const blocksOf = db.prepare("select kind, text, heading, table_no as tableNo, header from blocks where page_id = ? order by pos");
      for (const stored of db.prepare("select page_id, kind, full from cards where kind <> 'constant'").all()) {
        assert.deepEqual(missingFromCard(stored, blocksOf.all(stored.page_id)), [], stored.page_id);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
