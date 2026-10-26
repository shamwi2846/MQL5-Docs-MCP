import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const [, method] = find("how do I buy with CTrade");
  assert.match(method.split("\n")[0], /best match: Buy · mql5\/ctradebuy$/, "a class the question names offers the method it asks for first");
  assert.match(method, /\nOther pages: CTrade \(mql5\/ctrade\)/);
});

test("find: a phrase matching a title only by ignoring case also lists the best search results", () => {
  const [, phrase] = find("sample fixed arrows");
  const lines = phrase.split("\n");
  assert.equal(lines[0], "= sample fixed arrows → spelling corrected to Sample fixed arrows · page · mql5/samplearrows");
  assert.match(phrase, /\nOther pages: [^\n]*\(mql5\/[a-z_]+\)/);
  assert.doesNotMatch(phrase, /Other pages: [^\n]*mql5\/samplearrows\)/, "not the page already shown");
  const [, single] = find("ordersend");
  assert.doesNotMatch(single, /Other pages/, "a single word is a name, not a phrase");
});

test("find: book chapters are found by their title without the number; the Reference spelling wins", () => {
  const source = mkdtempSync(join(tmpdir(), "mql5-docs-books-"));
  try {
    const page = (title) => `<html><head><title>${title}</title></head><body><div id="help"><p class="p_Text"><span>About ${title}.</span></p></div></body></html>`;
    const book = (dir, pages) => {
      mkdirSync(dir);
      for (const [file, title] of Object.entries(pages)) writeFileSync(join(dir, `${file}.htm`), page(title));
      writeFileSync(join(dir, "toc.hhc"), `<ul>${Object.entries(pages).map(([file, title]) =>
        `<li><object type="text/sitemap"><param name="Name" value="${title}"><param name="Local" value="${file}.htm"></object>`).join("")}</ul>`);
      writeFileSync(join(dir, "keys.hhk"), "<ul></ul>");
    };
    book(join(source, "reference"), { data_input: "Data Input" });
    book(join(source, "nn"), { "1_5_2_dropout": "1.5.2 Dropout", "1_8_data_input": "1.8 Data input" });
    buildIndex(join(source, "index.sqlite"), [{ source: "mql5", dir: join(source, "reference") }, { source: "nn", dir: join(source, "nn") }]);
    const bookDb = new DatabaseSync(join(source, "index.sqlite"), { readOnly: true });
    try {
      const [, dropout, input, typo] = blocksOf(findText(bookDb, ["Dropout", "data input", "Droout"], context));
      assert.match(dropout, /^= Dropout · 1\.5\.2 Dropout · nn\/1_5_2_dropout\n/);
      assert.match(input, /^= data input → spelling corrected to Data Input · page · mql5\/data_input\n/);
      assert.equal(typo, "none · Droout · did you mean: Dropout (nn/1_5_2_dropout)?");
    } finally {
      bookDb.close();
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("find: typos get suggestions; nothing found says so", () => {
  const [, typo, nothing] = find("OrderSnd", "zzzz qqqq");
  assert.equal(typo, "none · OrderSnd · did you mean: OrderSend (mql5/ordersend)?", "with the page to read");
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
// unless `toc` is given. `hhk` is the keyword index. `book` pages form a
// second source, a book next to the Reference.
function withPages(pages, check, { toc, hhk = "<ul></ul>", book } = {}) {
  const source = mkdtempSync(join(tmpdir(), "mql5-docs-budget-"));
  const writeSource = (dir, files, contents) => {
    const entries = Object.keys(files).map((file) =>
      `<li><object type="text/sitemap"><param name="Name" value="${file}"><param name="Local" value="${file}.htm"></object>`);
    for (const [file, html] of Object.entries(files)) writeFileSync(join(dir, `${file}.htm`), html);
    writeFileSync(join(dir, "sample.hhc"), contents ?? `<ul>${entries.join("\n")}</ul>`);
  };
  try {
    writeSource(source, pages, toc);
    writeFileSync(join(source, "sample.hhk"), hhk);
    const sources = [{ source: "mql5", dir: source }];
    if (book) {
      const dir = join(source, "book");
      mkdirSync(dir);
      writeSource(dir, book);
      writeFileSync(join(dir, "sample.hhk"), "<ul></ul>");
      sources.push({ source: "book", dir });
    }
    buildIndex(join(source, "index.sqlite"), sources);
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

test("find: a question's passage starts where the question is covered, never in code", () => {
  const guide = `<html><head><title>Storage Guide</title></head><body><div id="help"><p class="p_H1"><span>Storage Guide</span></p>
<p class="p_Text"><span>This guide describes the sample store.</span></p>
<div><table><tr><td><p class="p_CodeExample"><span>long  SampleTotal();</span></p></td></tr></table></div>
<p class="p_BoldTitles"><span>Keeping values</span></p>
<p class="p_Text"><span>Sample values are kept for 4 weeks since the last access.</span></p></div></body></html>`;
  withPages({ guide }, (pageDb) => {
    const lines = findText(pageDb, ["How long are sample values kept"], context).split("\n");
    assert.equal(lines[2], "~ How long are sample values kept · no exact name; best match: Storage Guide · mql5/guide");
    assert.deepEqual(lines.slice(3, 5), ["Keeping values:", "Sample values are kept for 4 weeks since the last access."], "not the declaration that holds \"long\"");
  });
  const calendar = `<html><head><title>Sample Calendar</title></head><body><div id="help"><p class="p_H1"><span>Sample Calendar</span></p>
<p class="p_Text"><span>A new sample value arrives every day.</span></p>
<p class="p_Text"><span>The news arrive with their importance.</span></p></div></body></html>`;
  withPages({ calendar }, (pageDb) => {
    const lines = findText(pageDb, ["Where is the news"], context).split("\n");
    assert.equal(lines[3], "The news arrive with their importance.", "\"news\" is not \"new\"");
  });
});

test("find: a book chapter with the question's rarer word beats a Reference overview without it", () => {
  // As with "Are economic calendar functions available in the Strategy
  // Tester": the overview shares the topic words, the long chapter also says
  // what the question asks.
  const page = (title, ...texts) => `<html><head><title>${title}</title></head><body><div id="help"><p class="p_H1"><span>${title}</span></p>
${texts.map((text) => `<p class="p_Text"><span>${text}</span></p>`).join("\n")}</div></body></html>`;
  const reference = {
    calendar: page("Sample Calendar", "This section describes the sample calendar functions available directly in the platform.",
      "All sample calendar functions use the server time."),
  };
  for (let i = 0; i < 4; i++) {
    reference[`notes${i}`] = page(`Sample Notes ${i}`, "Sample functions are available in the platform.",
      i === 0 ? "Programs also run in the tester." : "Programs also run on charts.");
  }
  const book = {
    "7_3_calendar": page("7.3 Sample calendar", "When developing strategies, the built-in sample calendar helps. It is available in the program interface and through functions.",
      "Sample calendar functions cannot be used in the tester: they fail with error 4014.", "Save the entries to files on a chart, then read them in the tester.",
      ...Array.from({ length: 12 }, (_, i) => `Filler sentence ${i} about news events, importance levels and countries.`)),
  };
  withPages(reference, (pageDb) => {
    const [, answer] = blocksOf(findText(pageDb, ["Are sample calendar functions available in the tester"], context));
    assert.match(answer, /best match: 7\.3 Sample calendar · book\/7_3_calendar\nSample calendar functions cannot be used in the tester/);
    assert.match(answer, /\nOther pages: Sample Calendar \(mql5\/calendar\)/);
  }, { book });
});

test("find: \"in MetaTrader 5\" does not pull a page that only repeats the product name", () => {
  const page = (title, ...texts) => `<html><head><title>${title}</title></head><body><div id="help"><p class="p_H1"><span>${title}</span></p>
${texts.map((text) => `<p class="p_Text"><span>${text}</span></p>`).join("\n")}</div></body></html>`;
  const pages = {
    python: page("Sample Python Integration", "The MetaTrader 5 package connects Python to MetaTrader 5.",
      "Use the MetaTrader 5 terminal from Python; the MetaTrader 5 module returns positions."),
    close: page("SampleClose", "Closes an open position by its ticket.", "Check the result after closing the position."),
  };
  for (let i = 0; i < 3; i++) pages[`notes${i}`] = page(`Sample Notes ${i}`, "Orders and deals are listed in the history.");
  withPages(pages, (pageDb) => {
    const [, answer] = blocksOf(findText(pageDb, ["How do I close a position in MetaTrader 5"], context));
    assert.match(answer, /best match: SampleClose · mql5\/close\n/);
  });
});

test("find: an enum section that fits one read page is shown whole", () => {
  // Twelve rows of about 280 characters: a section between the old 3,000 limit and one read page.
  const rows = Array.from({ length: 12 }, (_, i) =>
    `<tr><td><p><span>SAMPLE_FILL_${i}</span></p></td><td><p><span>Sample fill policy ${i}, ${"described with enough words for a long row. ".repeat(6)}</span></p></td></tr>`);
  const enums = `<html><head><title>Sample Properties</title></head><body><div id="help"><p class="p_H1"><span>Sample Properties</span></p>
<p class="p_Text"><a name="enum_sample_fill"></a><span>ENUM_SAMPLE_FILL</span></p>
<table><thead><tr><th><p><span>Identifier</span></p></th><th><p><span>Description</span></p></th></tr></thead><tbody>${rows.join("")}</tbody></table>
<p class="p_Text"><span>In case of pending orders, the last sample rule applies regardless of the mode.</span></p>
<p class="p_Text"><span>The next enumeration sets the sample validity.</span></p>
<p class="p_Text"><a name="enum_next"></a><span>ENUM_NEXT</span></p></div></body></html>`;
  const hhk = '<ul><li><object type="text/sitemap"><param name="Name" value="ENUM_SAMPLE_FILL"><param name="Local" value="enums.htm#enum_sample_fill"></object></ul>';
  withPages({ enums }, (pageDb) => {
    const [, answer] = blocksOf(findText(pageDb, ["ENUM_SAMPLE_FILL"], context));
    assert.ok(answer.length > 3000 && answer.length < 4200, `${answer.length}`);
    assert.match(answer, /\nIn case of pending orders, the last sample rule applies regardless of the mode\.$/);
  }, { hhk });
});

test("find: names without a card or anchor each start at their own row", () => {
  const props = `<html><head><title>Sample Properties Page</title></head><body><div id="help"><p class="p_H1"><span>Sample Properties Page</span></p>
<p class="p_Text"><span>Every sample program can set properties that the terminal reads.</span></p>
<table><thead><tr><th><p><span>Constant</span></p></th><th><p><span>Type</span></p></th><th><p><span>Description</span></p></th></tr></thead><tbody>
<tr><td><p><span>sample_buffers</span></p></td><td><p><span>int</span></p></td><td><p><span>Number of sample buffers.</span></p></td></tr>
<tr><td><p><span>sample_file</span></p></td><td><p><span>string</span></p></td><td><p><span>File passed to the sample tester.</span></p></td></tr>
</tbody></table></div></body></html>`;
  const hhk = ["sample_buffers", "sample_file"].map((name) =>
    `<li><object type="text/sitemap"><param name="Name" value="${name}"><param name="Local" value="props.htm"></object>`).join("");
  withPages({ props }, (pageDb) => {
    const [, buffers, file] = blocksOf(findText(pageDb, ["sample_buffers", "sample_file"], context));
    assert.match(buffers, /^= sample_buffers · Sample Properties Page · mql5\/props\n.*\nsample_buffers \| int \| Number of sample buffers\./s);
    assert.match(file, /^= sample_file · Sample Properties Page · mql5\/props\n.*\nsample_file \| string \| File passed to the sample tester\./s);
    assert.doesNotMatch(file, /shown above/);
  }, { hhk: `<ul>${hhk}</ul>` });
});

test("find: a section answer and its page's answer starting at the same place are both shown", () => {
  const types = `<html><head><title>Sample Types</title></head><body><div id="help"><p class="p_H1"><span>Sample Types</span></p>
<p class="p_Text"><a name="sample_char"></a><span>The sample char type holds one character.</span></p>
<p class="p_BoldTitles"><span>Other types</span></p>
<p class="p_Text"><span>The other sample types hold numbers.</span></p></div></body></html>`;
  const hhk = '<ul><li><object type="text/sitemap"><param name="Name" value="sample_char"><param name="Local" value="types.htm#sample_char"></object></ul>';
  withPages({ types }, (pageDb) => {
    const [, char, page] = blocksOf(findText(pageDb, ["sample_char", "Sample Types"], context));
    assert.match(char, /\nThe sample char type holds one character\.$/, "the section ends before Other types");
    assert.doesNotMatch(page, /shown above/);
    assert.match(page, /\nThe other sample types hold numbers\./);
  }, { hhk });
});

test("find: a name with its own section on another item's page gets that section, not the other card", () => {
  const code = (text) => `<div><table><tr><td><p class="p_CodeExample"><span>${text.replace(/\n/g, "<br>")}</span></p></td></tr></table></div>`;
  const row = (id, text) => `<tr><td><p><span>${id}</span></p></td><td><p><span>${text}</span></p></td></tr>`;
  const structs = `<html><head><title>Sample calendar structures</title></head><body><div id="help"><p class="p_H1"><span>Sample calendar structures</span></p>
<p class="p_Text"><a name="samplecountry"></a><span>Countries are set by the SampleCountry structure.</span></p>
${code("struct SampleCountry\n  {\n   ulong id;\n  };")}
<p class="p_Text"><a name="sampleevent"></a><span>Events are set by the SampleEvent structure.</span></p>
${code("struct SampleEvent\n  {\n   string event_code;\n  };")}
<p class="p_Text"><a name="enum_sample_type"></a><span>ENUM_SAMPLE_TYPE</span></p>
<table><thead><tr><th><p><span>Identifier</span></p></th><th><p><span>Description</span></p></th></tr></thead><tbody>${row("SAMPLE_TYPE_EVENT", "An event")}</tbody></table>
</div></body></html>`;
  const open = `<html><head><title>SampleOpen</title></head><body><div id="help"><p class="p_H1"><span>SampleOpen</span></p>
<p class="p_Function"><span>Opens a sample database.</span></p>
${code("int  SampleOpen(\n   uint  flags      // flags\n   );")}
<p class="p_BoldTitles"><span>Parameters</span></p><p><span>flags</span></p><p><span>[in] A combination of ENUM_SAMPLE_OPEN_FLAGS.</span></p>
<p class="p_BoldTitles"><span>Return Value</span></p><p><span>The handle, or INVALID_HANDLE.</span></p>
<p class="p_BoldTitles"><span>Note</span></p>
<p class="p_Text"><a name="enum_sample_open_flags"></a><span>ENUM_SAMPLE_OPEN_FLAGS</span></p>
<table><thead><tr><th><p><span>Identifier</span></p></th><th><p><span>Description</span></p></th></tr></thead><tbody>${row("SAMPLE_OPEN_READONLY", "Read only")}</tbody></table>
</div></body></html>`;
  const keyword = (name, local) => `<li><object type="text/sitemap"><param name="Name" value="${name}"><param name="Local" value="${local}"></object>`;
  const hhk = `<ul>${keyword("SampleCountry", "structs.htm#samplecountry")}${keyword("SampleEvent", "structs.htm#sampleevent")}${keyword("ENUM_SAMPLE_TYPE", "structs.htm#enum_sample_type")}${keyword("ENUM_SAMPLE_OPEN_FLAGS", "open.htm#enum_sample_open_flags")}</ul>`;
  withPages({ structs, open }, (pageDb) => {
    const [, country, event, type, flags, function_] = blocksOf(findText(pageDb, ["SampleCountry", "SampleEvent", "ENUM_SAMPLE_TYPE", "ENUM_SAMPLE_OPEN_FLAGS", "SampleOpen"], context));
    assert.match(country, /^= SampleCountry · struct · mql5\/structs\nstruct SampleCountry/, "the card's own struct keeps the card");
    assert.match(event, /^= SampleEvent · Sample calendar structures · mql5\/structs\n[^]*struct SampleEvent/);
    assert.doesNotMatch(event, /struct SampleCountry|shown above/);
    assert.match(type, /\nSAMPLE_TYPE_EVENT \| An event/);
    assert.match(flags, /^= ENUM_SAMPLE_OPEN_FLAGS · SampleOpen · mql5\/open\n[^]*SAMPLE_OPEN_READONLY \| Read only/);
    assert.match(function_, /^= SampleOpen · function · mql5\/open\n/, "the page's own function keeps the card");
  }, { hhk });
});

const textPage = (title, ...parts) => `<html><head><title>${title}</title></head><body><div id="help"><p class="p_H1"><span>${title}</span></p>
${parts.map((part) => (part.startsWith("<") ? part : `<p class="p_Text"><span>${part}</span></p>`)).join("\n")}</div></body></html>`;
const codeBlock = (text) => `<div><table><tr><td><p class="p_CodeExample"><span>${text.replace(/\n/g, "<br>")}</span></p></td></tr></table></div>`;
const heading = (text) => `<p class="p_BoldTitles"><span>${text}</span></p>`;
const keyword = (name, local) => `<li><object type="text/sitemap"><param name="Name" value="${name}"><param name="Local" value="${local}"></object>`;

test("find: a book chapter opening with an example struct answers its title with its text", () => {
  // As "Working with real tick arrays in MqlTick structures", which showed one sentence under "struct MqlTick".
  const tick = codeBlock("struct SampleTick\n  {\n   double bid;\n  };");
  const reference = { sampletick: textPage("SampleTick", tick, "This structure stores the latest sample prices.") };
  const book = {
    "5_3_ticks": textPage("5.3 Working with sample tick arrays", "The platform keeps the history of real sample ticks.", tick,
      "Requests for ticks are synchronized with the trade server before they return."),
  };
  withPages(reference, (pageDb) => {
    const [, chapter, struct] = blocksOf(findText(pageDb, ["Working with sample tick arrays", "SampleTick"], context));
    assert.match(chapter, /^= Working with sample tick arrays · 5\.3 Working with sample tick arrays · book\/5_3_ticks\n[^]*Requests for ticks are synchronized/);
    assert.match(struct, /^= SampleTick · struct · mql5\/sampletick\nstruct SampleTick/, "a page titled with its struct keeps the card");
  }, { book });
});

test("find: a question on a struct page shows the matching section; a function page keeps its card", () => {
  // As "Modify Pending Order", which showed the whole MqlTradeRequest card.
  const cases = Array.from({ length: 6 }, (_, i) => [heading(`Case ${i}`), `Sample case ${i} fills the request. ${"Plain words about the request. ".repeat(10)}`]).flat();
  const request = textPage("Sample Request Structure", codeBlock("struct SampleRequest\n  {\n   ulong order;\n  };"),
    "Requests are sent in this structure.", ...cases, heading("Modify Pending Order"), "Trade order to modify the prices of a pending order.");
  withPages({ request, send: functionPage("SampleSend", 1) }, (pageDb) => {
    const [, modify, send] = blocksOf(findText(pageDb, ["Modify Pending Order", "how does SampleSend work"], context));
    assert.match(modify, /best match: Sample Request Structure · mql5\/request\nModify Pending Order:\nTrade order to modify the prices of a pending order\./);
    assert.doesNotMatch(modify, /struct SampleRequest/);
    assert.match(send, /best match: SampleSend · mql5\/send\nThe SampleSend function does sample work\./, "a function card still answers");
  }, { hhk: `<ul>${keyword("SampleRequest", "request.htm")}</ul>` });
});

test("find: a class's method catalogue doesn't outrank the page that answers", () => {
  // As "stop limit order triggered becomes limit order", which answered with CExpert's method list.
  const row = (method, text) => `<tr><td><p><span>${method}</span></p></td><td><p><span>${text}</span></p></td></tr>`;
  const expert = textPage("CSampleExpert", "CSampleExpert is a base class for sample strategies.", heading("Class Methods by Groups"),
    `<table><thead><tr><th><p><span>Trade Event Processing Methods</span></p></th><th><p><span></span></p></th></tr></thead><tbody>
${row("TradeEventOrderTriggered", "Event handler of the Pending Stop Limit Order Triggered event")}
${row("CheckTrailingOrderLong", "Checks Trailing Stop conditions of Buy Limit/Stop order")}</tbody></table>`);
  const book = {
    "6_4_4_types": textPage("6.4.4 Sample order types", "Upon reaching the stop price of a stop limit order, a corresponding limit order is placed.",
      "A limit order with such a price gets triggered almost immediately.",
      ...Array.from({ length: 8 }, (_, i) => `Filler sentence ${i} about market orders, pending orders and their expiration.`)),
  };
  withPages({ expert }, (pageDb) => {
    const [, answer] = blocksOf(findText(pageDb, ["stop limit order triggered becomes limit order"], context));
    assert.match(answer, /best match: 6\.4\.4 Sample order types · book\/6_4_4_types\n/);
  }, { book });
});

test("find: a function the question writes with its capital reaches its page", () => {
  // As "Print in the strategy tester log": "print" alone is in every code example.
  const notes = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [
    [`notes${i}`, textPage(`Sample Tester Notes ${i}`, "Programs write their messages to the tester log.", "The tester log keeps every pass.")],
    [`example${i}`, textPage(`Sample Example ${i}`, "The example shows a value.", codeBlock(`Printout("value ${i}");`))],
  ]).flat());
  // Unrelated pages, so the question's words are as rare as in the real docs.
  for (let i = 0; i < 20; i++) notes[`topic${i}`] = textPage(`Sample Topic ${i}`, `Topic ${i} describes charts, colors and objects.`);
  const printout = textPage("Printout", "It enters a message in the journal.", "Printout does not work during optimization in the tester.");
  const best = (pages) => {
    let line;
    withPages(pages, (pageDb) => { line = findText(pageDb, ["Printout in the tester log"], context).split("\n")[2]; });
    return line;
  };
  assert.match(best({ ...notes, printout }), /best match: Printout · mql5\/printout$/);
  // Two fuzzy-system pages are titled "Calculate": a title two pages share is no sign of which one is meant.
  assert.match(best({ ...notes, printout, printout2: printout }), /best match: Sample Tester Notes/, "a title two pages share gets no boost");
});

test("find: a question naming an API in a context its page lacks is answered where both are covered", () => {
  // As "CopyTicks in the Strategy Tester": the CopyTicks page never mentions the tester.
  const ticks = textPage("SampleTicks", "The function receives ticks into an array.", codeBlock("int  SampleTicks(\n   string  symbol\n   );"),
    heading("Parameters"), "<p><span>symbol</span></p>", "<p><span>[in] Symbol name.</span></p>",
    heading("Return Value"), "The number of copied ticks.", heading("Note"), "Ticks are synchronized with the trade server.");
  const pages = {
    ticks,
    // Ranks first for the tester words, but names the API only in code.
    tester: textPage("Sample Strategy Tester", "The strategy tester runs sample programs on history.",
      codeBlock("SampleTicks(_Symbol); // ticks in the strategy tester")),
    // Ranks before the testing page too, but names the API only in its method catalogue.
    testerClass: textPage("Strategy Tester Ticks Class", "This class controls the strategy tester.", heading("Class Methods by Groups"),
      `<table><thead><tr><th><p><span>Method</span></p></th><th><p><span>Description</span></p></th></tr></thead><tbody>
<tr><td><p><span>SampleTicks</span></p></td><td><p><span>Gets ticks in the strategy tester</span></p></td></tr></tbody></table>`),
    // Its first section scores higher for the question's words, but never names the API.
    testing: textPage("Testing Sample Programs", heading("Strategy tester ticks"), "The strategy tester stores ticks; the strategy tester keeps ticks in its cache.",
      "Testing on history is fast.", heading("Using real ticks during a test"),
      "Ticks are stored in the cache of the strategy tester. The SampleTicks function receives ticks outside the cache only when testing on real ticks, as SampleFeed does."),
    feed: textPage("SampleFeed", "SampleFeed delivers ticks in the strategy tester."),
  };
  withPages(pages, (pageDb) => {
    const [, tester, own, second] = blocksOf(findText(pageDb, ["SampleTicks ticks in the strategy tester", "SampleTicks ticks synchronized",
      "SampleTicks from SampleFeed ticks in the strategy tester"], context));
    assert.match(tester, /best match: Testing Sample Programs · mql5\/testing\nUsing real ticks during a test:\nTicks are stored in the cache/);
    assert.match(tester, /\nOther pages: SampleTicks \(mql5\/ticks\)/, "the API page is listed next");
    assert.match(own, /best match: SampleTicks · mql5\/ticks\n/, "a paragraph of the API page holds the whole context");
    assert.match(second, /best match: SampleFeed · mql5\/feed\nSampleFeed delivers ticks in the strategy tester\.\nOther pages: SampleTicks \(mql5\/ticks\)/,
      "another named page whose paragraph holds the context comes first");
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
