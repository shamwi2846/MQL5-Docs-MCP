import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildIndex } from "../src/indexer.mjs";
import { FIND_BUDGET, findText, normalizeQueries } from "../src/find.mjs";
import { readPage } from "../src/search.mjs";

const context = { tag: "abc1234", downloaded: "2026-10-21" };
const HEADER = "MQL5 docs downloaded 2026-10-21 · index abc1234";
let dir;
let db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "mql5-docs-find-"));
  buildIndex(join(dir, "index.sqlite"), [{ source: "mql5", dir: join(import.meta.dirname, "fixtures", "mql5") }]);
  db = new DatabaseSync(join(dir, "index.sqlite"), { readOnly: true });
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const blocksOf = (text) => text.split("\n\n");
const find = (...queries) => blocksOf(findText(db, queries, context));

test("find: a name gets its card; other spellings say how they were read", () => {
  const [header, card, call, lower, dotted] = find("OrderSend", "OrderSend()", "ordersend", "CTrade.Buy");
  assert.equal(header, HEADER);
  assert.match(card, /^= OrderSend · function · mql5\/ordersend\nSends a sample trade request/);
  assert.match(card, /This does not mean it was executed\./);
  assert.equal(call, "= OrderSend() → read as OrderSend · function · mql5/ordersend (shown above)");
  assert.equal(lower, "= ordersend → spelling corrected to OrderSend · function · mql5/ordersend (shown above)");
  assert.match(dotted, /^= CTrade\.Buy → read as CTrade::Buy · Buy · mql5\/ctradebuy\nOpens a sample long position\./);
});

test("find: a global API beats a member; members sharing a name ask for Class::Method", () => {
  const [, copyRates, create] = find("CopyRates", "Create");
  assert.match(copyRates, /^= CopyRates · page · mql5\/copyrates\n/);
  assert.match(copyRates, /\nAlso named CopyRates: matrix::CopyRates \(mql5\/matrix_copyrates\)$/);
  assert.equal(create, "= Create · 2 pages share this name: CiSampleMA::Create (mql5/cisamplemacreate), "
    + "CSampleArrowUp::Create (mql5/samplearrowscreate). Ask with Class::Method.");
  const [, owned] = find("CSampleArrowDown::Create");
  assert.match(owned, /^= CSampleArrowDown::Create · method · mql5\/samplearrowscreate\nCreates a sample arrow object\./);
});

test("find: constants show their enum and section notes once per reply", () => {
  const [, filling, fok] = find("ORDER_FILLING_RETURN", "ORDER_FILLING_FOK");
  assert.match(filling, /^= ORDER_FILLING_RETURN · constant of ENUM_ORDER_TYPE_FILLING · mql5\/orderproperties\n/);
  assert.match(filling, /\nSection notes: Sample filling policy notes\.\n[^]*Pending orders use Return regardless of the mode\./);
  assert.match(fok, /^= ORDER_FILLING_FOK · constant of ENUM_ORDER_TYPE_FILLING · mql5\/orderproperties\n/);
  assert.match(fok, /\nSection notes shown above\.$/);
  assert.doesNotMatch(fok, /Pending orders/);
});

test("find: an enum without a card starts at its anchor; a page title at the page start", () => {
  const [, enumBlock, page] = find("ENUM_ORDER_TYPE_FILLING", "Order Properties");
  const lines = enumBlock.split("\n");
  assert.equal(lines[0], "= ENUM_ORDER_TYPE_FILLING · Order Properties · mql5/orderproperties");
  assert.equal(lines[1], "Sample filling policy notes.");
  assert.equal(lines[2], "Fill policy | Description | The value in ENUM_ORDER_TYPE_FILLING");
  assert.match(page, /^= Order Properties · page · mql5\/orderproperties\nSample text before the enumeration/);
});

test("find: questions search, with phrase expansions as first candidates", () => {
  const [, search] = find("how to send a trade request");
  assert.match(search, /^~ how to send a trade request · no exact name; best match: OrderSend · mql5\/ordersend\n/);
  const [, expanded] = find("open a trade");
  assert.match(expanded.split("\n")[0], /best match: OrderSend · mql5\/ordersend$/);
  assert.match(expanded, /\nOther pages: Buy \(mql5\/ctradebuy\)/, "CTrade::Buy from the expansion comes next");
  const [, named] = find("open a trade like matrix::CopyRates");
  assert.match(named.split("\n")[0], /best match: CopyRates · mql5\/matrix_copyrates$/, "an API the question names comes first");
  assert.match(named, /\nOther pages: OrderSend \(mql5\/ordersend\), Buy \(mql5\/ctradebuy\)$/);
});

test("find: typos get suggestions; nothing found says so", () => {
  const [, typo, nothing] = find("OrderSnd", "zzzz qqqq");
  assert.equal(typo, "none · OrderSnd · did you mean: OrderSend?");
  assert.equal(nothing, "none · zzzz qqqq · nothing matched; rephrase, or check mql5.com");
});

test("find: input as a list, one string, or a list sent as JSON text; at most 16 answered", () => {
  assert.deepEqual(normalizeQueries("OrderSend").queries, ["OrderSend"]);
  assert.deepEqual(normalizeQueries('["OrderSend", " CopyRates ", 7, ""]').queries, ["OrderSend", "CopyRates"]);
  assert.deepEqual(normalizeQueries("[not json").queries, ["[not json"]);
  const many = Array.from({ length: 18 }, (_, i) => `Q${i}`);
  const { queries, skipped } = normalizeQueries(many);
  assert.equal(queries.length, 16);
  assert.deepEqual(skipped, ["Q16", "Q17"]);
  const reply = blocksOf(findText(db, many, context));
  assert.equal(reply.at(-1), "(2 more queries skipped: Q16, Q17)");
  assert.equal(findText(db, [], context), `${HEADER}\nnone · no query given`);
});

// Function pages written into a temporary folder, so no large fixture is
// committed. Each note paragraph is about 930 characters.
function functionPage(title, noteParagraphs, params = ["value"]) {
  const note = Array.from({ length: noteParagraphs }, (_, i) =>
    `<p class="p_FunctionRemark"><span>Note paragraph ${i} of ${title}. ${"This sentence fills the note with ordinary words. ".repeat(18)}</span></p>`).join("\n");
  return `<html><head><title>${title}</title></head><body><div id="help">
<p class="p_H1"><span>${title}</span></p>
<p class="p_Function"><span>The ${title} function does sample work.</span></p>
<div><table><tr><td><p class="p_CodeExample"><span>bool&nbsp;&nbsp;${title}(</span>${params.map((param, i) =>
    `<br><span>&nbsp;&nbsp;&nbsp;int&nbsp;&nbsp;${param}${i < params.length - 1 ? "," : ""}</span>`).join("")}<br><span>&nbsp;&nbsp;&nbsp;);</span></p></td></tr></table></div>
<p class="p_BoldTitles"><span>Parameters</span></p>
${params.map((param) => `<p class="p_FunctionParameter"><span>${param}</span></p>
<p class="p_ParameterDesrciption"><span>[in] &nbsp;A sample value.</span></p>`).join("\n")}
<p class="p_BoldTitles"><span>Note</span></p>
${note}</div></body></html>`;
}

// Pages are keyed by file name; each is listed in the table of contents
// unless `toc` is given. `hhk` is the keyword index.
function withPages(pages, check, { toc, hhk = "<ul></ul>" } = {}) {
  const source = mkdtempSync(join(tmpdir(), "mql5-docs-budget-"));
  try {
    const entries = Object.keys(pages).map((file) =>
      `<li><object type="text/sitemap"><param name="Name" value="${file}"><param name="Local" value="${file}.htm"></object>`);
    for (const [file, html] of Object.entries(pages)) writeFileSync(join(source, `${file}.htm`), html);
    writeFileSync(join(source, "sample.hhc"), toc ?? `<ul>${entries.join("\n")}</ul>`);
    writeFileSync(join(source, "sample.hhk"), hhk);
    buildIndex(join(source, "index.sqlite"), [{ source: "mql5", dir: source }]);
    const pageDb = new DatabaseSync(join(source, "index.sqlite"), { readOnly: true });
    try {
      check(pageDb);
    } finally {
      pageDb.close();
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

test("find: a batch over the budget keeps full cards first and briefs the rest", () => {
  const names = Array.from({ length: 16 }, (_, i) => `Sample${String.fromCharCode(65 + i)}`);
  withPages(Object.fromEntries(names.map((name) => [name.toLowerCase(), functionPage(name, 2)])), (pageDb) => {
    const text = findText(pageDb, names, context);
    assert.ok(text.length <= FIND_BUDGET, `${text.length}`);
    const blocks = blocksOf(text).slice(1);
    assert.equal(blocks.length, 16);
    blocks.forEach((block, i) => assert.ok(block.startsWith(`= ${names[i]} · function · mql5/${names[i].toLowerCase()}\n`), block));
    assert.match(blocks[0], /Note paragraph 1 of SampleA/, "the first card is full");
    assert.match(blocks[15], /\n\(brief; full card: mql5_find SampleP\)$/, "the last card is brief");
    assert.ok(blocks.filter((block) => block.includes("(brief;")).every((block) => block.length <= 480));
  });
});

test("find: an oversized card is cut at a line and says how to read on", () => {
  withPages({ huge: functionPage("Huge", 16), small: functionPage("Small", 1) }, (pageDb) => {
    const alone = findText(pageDb, ["Huge"], context);
    assert.ok(alone.length <= FIND_BUDGET, `${alone.length}`);
    assert.match(alone, /\nNote paragraph \d+ of Huge\. [^\n]*ordinary words\.\n\[continues/, "cut after a whole line");
    // Reading on goes to the cut section's page that holds the first line left out.
    const [, page] = /\n\[continues: mql5_read id=mql5\/huge focus=Note page=(\d+)\]$/.exec(alone);
    const lastShown = Number(/Note paragraph (\d+) of Huge\.[^\n]*\n\[continues/.exec(alone)[1]);
    const next = readPage(pageDb, { id: "mql5/huge", focus: "Note", page: Number(page) }, context);
    assert.match(next, new RegExp(`\\nNote paragraph ${lastShown + 1} of Huge\\.`));
    assert.doesNotMatch(next, /Note paragraph 0 of Huge/, "not the start of the section again");
    const [, huge, small] = blocksOf(findText(pageDb, ["Huge", "Small"], context));
    assert.match(huge, /\n\(brief; read the rest: mql5_read id=mql5\/huge\)$/, "no circular mql5_find pointer");
    assert.match(small, /Note paragraph 0 of Small/);
  });
});

test("find: briefs keep their read position and repeats point back", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    `<tr><td><p><span>SAMPLE_VALUE_${i}</span></p></td><td><p><span>Sample value number ${i}, described with enough words to fill a row.</span></p></td></tr>`);
  const enumPage = `<html><head><title>Sample Enums</title></head><body><div id="help">
<p class="p_H1"><span>Sample Enums</span></p>
<p class="p_Text"><a name="enum_sample"></a><span>ENUM_SAMPLE</span></p>
<table><thead><tr><th><p><span>Identifier</span></p></th><th><p><span>Description</span></p></th></tr></thead><tbody>${rows.join("")}</tbody></table>
</div></body></html>`;
  const hhk = '<ul><li><object type="text/sitemap"><param name="Name" value="ENUM_SAMPLE"><param name="Local" value="enums.htm#enum_sample"></object></ul>';
  withPages({ big: functionPage("Big", 10), small: functionPage("Small", 3), enums: enumPage }, (pageDb) => {
    const text = findText(pageDb, ["Big", "Small", "ENUM_SAMPLE", "small"], context);
    assert.ok(text.length <= FIND_BUDGET, `${text.length}`);
    const [, big, small, enumBlock, repeat] = blocksOf(text);
    assert.match(big, /Note paragraph 9 of Big/, "the first card is full");
    assert.match(small, /\n\(brief; full card: mql5_find Small\)$/);
    assert.match(enumBlock, /^= ENUM_SAMPLE · Sample Enums · mql5\/enums\nENUM_SAMPLE\n/);
    assert.match(enumBlock, /\n\(brief; read the rest: mql5_read id=mql5\/enums focus=ENUM_SAMPLE\)$/, "the pointer keeps the anchor's focus");
    assert.equal(repeat, "= small → spelling corrected to Small · function · mql5/small (shown above)");
  }, { hhk });
});

test("find: a question's passage reads on from the word that matched", () => {
  const paragraphs = Array.from({ length: 10 }, (_, i) =>
    `<p class="p_Text"><span>Paragraph ${i}${i === 5 ? " explains execution" : ""}. ${"Plain filler words for the guide page. ".repeat(7)}</span></p>`);
  const guide = `<html><head><title>Guide</title></head><body><div id="help"><p class="p_H1"><span>Guide</span></p>
${paragraphs.join("\n")}</div></body></html>`;
  withPages({ guide }, (pageDb) => {
    const lines = findText(pageDb, ["zebra execution"], context).split("\n");
    assert.equal(lines[2], "~ zebra execution · no exact name; best match: Guide · mql5/guide");
    assert.match(lines[3], /^Paragraph 5 explains execution\./);
    assert.equal(lines.at(-1), "more: mql5_read id=mql5/guide focus=execution", "not the unmatched first word");
  });
});

test("find: a brief never cuts a signature", () => {
  // A long name echoed in a long query leaves less room than the stored
  // signature needs (it is under the 240 characters a brief keeps).
  const name = "SampleFunctionWithAVeryLongNameForBriefsThatKeepsGoingOnAndOn";
  const params = Array.from({ length: 9 }, (_, i) => `parameter_${i}`);
  withPages({ big: functionPage("Big", 10), long: functionPage(name, 10, params) }, (pageDb) => {
    const query = `${name}(parameter_0, parameter_1, parameter_2, parameter_3, parameter_4, parameter_5, parameter_6)`;
    const [, , long] = blocksOf(findText(pageDb, ["Big", query], context));
    const lines = long.split("\n");
    assert.match(lines[0], new RegExp(`^= ${name}\\(parameter_0, .*… → read as ${name} · function · mql5/long$`));
    assert.equal(lines.at(-1), `(brief; full card: mql5_find ${name})`);
    const brief = pageDb.prepare("select brief from cards where name = ?").get(name).brief.split("\n");
    assert.ok(brief[0].startsWith(`bool ${name}(int parameter_0,`), brief[0]);
    assert.ok(long.length <= 480, `${long.length}`);
    assert.ok(!lines.some((line) => line.startsWith("bool ")), "the signature is left out whole, not cut");
    assert.ok(lines.includes(`The ${name} function does sample work.`), "the description still shows");
  });
});

test("find: room is kept for long outcome lines", () => {
  // Six classes with long names share the method "Shared", so its outcome
  // line alone (about 800 characters) is longer than a brief block.
  const classes = Array.from({ length: 6 }, (_, i) =>
    `CSampleClassWithAVeryLongNameUsedOnlyToLengthenTheOutcomeLineAndMakeItLongerThanAnyRealClassNameEverWas${i}`);
  const pages = { cardone: functionPage("CardOne", 4), cardtwo: functionPage("CardTwo", 4) };
  for (const [i] of classes.entries()) pages[`shared${i}`] = functionPage("Shared", 0);
  const toc = `<ul>
<li><object type="text/sitemap"><param name="Name" value="CardOne"><param name="Local" value="cardone.htm"></object>
<li><object type="text/sitemap"><param name="Name" value="CardTwo"><param name="Local" value="cardtwo.htm"></object>
${classes.map((owner, i) => `<li><object type="text/sitemap"><param name="Name" value="${owner}"></object>
<ul><li><object type="text/sitemap"><param name="Name" value="Shared"><param name="Local" value="shared${i}.htm"></object></ul>`).join("\n")}
</ul>`;
  withPages(pages, (pageDb) => {
    const queries = ["CardOne", "CardTwo", ...Array.from({ length: 14 }, () => "Shared")];
    const text = findText(pageDb, queries, context);
    const blocks = blocksOf(text).slice(1);
    assert.ok(blocks[2].length > 700, `${blocks[2].length}`);
    assert.match(blocks[2], /^= Shared · 6 pages share this name: CSampleClassWith/);
    assert.equal(blocks.length, 16);
    assert.ok(text.length <= FIND_BUDGET, `${text.length}`);
  }, { toc });
});
