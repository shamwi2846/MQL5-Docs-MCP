// Builds the SQLite index from unpacked CHM folders: pages, their block
// structure, full-text sections and the names that find each page.
// Only this module loads the HTML parser; the server never imports it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as cheerio from "cheerio";
import { constantCards, introEnd, pageCard } from "./cards.mjs";
import { SUMMARY_PAGES } from "./config.mjs";
import { SCHEMA_VERSION } from "./data.mjs";
import { blocksOfPage } from "./search.mjs";

const SCHEMA = `
create table meta (key text primary key, value text not null);
create table pages (id text primary key, source text not null, file text not null,
  title text not null, breadcrumb text not null, member integer not null);
create table cards (name text not null, page_id text not null, kind text not null,
  anchor text, value text, enum text, notes_key text, full text not null, brief text not null);
create index cards_by_page on cards (page_id);
create index cards_by_name on cards (name);
create table notes (key text primary key, text text not null) without rowid;
create table blocks (page_id text not null, pos integer not null, kind text not null,
  text text not null, heading text not null, table_no integer, header text, anchors text,
  primary key (page_id, pos)) without rowid;
create table names (name text not null, lower text not null, page_id text not null,
  kind text not null, member integer not null, anchor text, seq integer not null);
create index names_by_name on names (name);
create index names_by_lower on names (lower);
create virtual table sections using fts5 (page_id unindexed, title, heading, body,
  tokenize = 'unicode61 remove_diacritics 2');
`;

const HEADING_CLASSES = new Set(["p_H2", "p_H3", "p_BoldTitles"]);
const HEADING_SELECTOR = [...HEADING_CLASSES].map((cls) => `p.${cls}`).join(", ");
// Standard Library class and interface names: CTrade, CiMA (indicator
// classes), CHashMap<TKey,TValue>, ICollection<T>.
const CLASS_NAME = /^(Ci?|I)[A-Z]\w*(<[^>]*>)?$/;
const ownerOf = (className) => className.replace(/<.*$/, "");
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const MAX_LABEL = 80;

export function normalizeSpace(text) {
  return text.replace(/[\s ]+/g, " ").trim();
}

// Pages declare their charset (Windows-1252 or ISO-8859-1 today); an unknown
// label throws, so a changed encoding fails the build instead of garbling text.
export function decodePage(bytes) {
  const head = bytes.subarray(0, 2048).toString("latin1");
  const charset = /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "windows-1252";
  return new TextDecoder(charset).decode(bytes);
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Parses the loose HTML Help sitemap syntax of .hhc and .hhk files. Each entry
// keeps its names, its targets ("file.htm#anchor"), the names of the table of
// contents entries it is nested under, and its parent entry's first target.
export function parseSitemap(text) {
  const entries = [];
  const path = [];
  let last = null;
  for (const match of text.matchAll(/<(\/?)ul\b[^>]*>|<object\b[\s\S]*?<\/object>/gi)) {
    if (match[1] === "/") {
      path.pop();
    } else if (match[1] === "") {
      path.push(last);
    } else {
      const params = [...match[0].matchAll(/<param\s+name="(\w+)"\s+value="([^"]*)"/gi)];
      const valuesOf = (key) => params.filter((p) => p[1].toLowerCase() === key).map((p) => decodeEntities(p[2]));
      last = {
        name: valuesOf("name")[0] ?? "",
        targets: valuesOf("local"),
        // The nameless site-properties object can sit above the first entry.
        parents: path.filter(Boolean).map((entry) => entry.name).filter(Boolean),
        parentTarget: path.at(-1)?.targets[0] ?? null,
      };
      entries.push(last);
    }
  }
  return entries;
}

// Code lines are separated by <br>; source line breaks inside the markup are
// only formatting, while non-breaking spaces carry the code's indentation.
function codeText($el) {
  $el.find("br").replaceWith("\u0001");
  return $el.text().replace(/[ \t\r\n]+/g, " ").replace(/\u0001 ?/g, "\n").replace(/ /g, " ")
    .split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

// Turns one page into its title, keywords and an ordered list of blocks:
// headings, paragraphs, code and table rows, each with the heading it sits
// under and any anchors placed just before it.
export function parsePage(html) {
  const $ = cheerio.load(html);
  const help = $("#help");
  const title = normalizeSpace($("title").first().text()) || normalizeSpace(help.find("p.p_H1").first().text());
  const keywords = ($('meta[name="keywords"]').attr("content") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const blocks = [];
  let heading = "";
  let anchors = [];
  let tableNo = 0;

  const collectAnchors = ($el) => $el.find("a[name]").each((_, a) => anchors.push($(a).attr("name")));
  // Block elements inside one cell are separated by a space even when the
  // markup has none between them; all of the cell's text is kept.
  const cellText = ($cell) => {
    const copy = $cell.clone();
    copy.find("p, li, div, br, tr").after(" ");
    return normalizeSpace(copy.text());
  };
  const add = (kind, text, extra = {}) => {
    if (!text) return;
    blocks.push({ kind, text, heading, anchors, tableNo: null, header: null, ...extra });
    anchors = [];
  };

  const visitParagraph = ($p) => {
    collectAnchors($p);
    const cls = $p.attr("class") ?? "";
    if (cls === "p_H1") return;
    if (cls === "p_CodeExample") return add("code", codeText($p));
    const text = normalizeSpace($p.text());
    if (HEADING_CLASSES.has(cls) && text) {
      heading = text;
      return add("heading", text);
    }
    add("paragraph", text);
  };

  // A table whose every paragraph is code is a code block; any other table
  // becomes rows, each carrying its table's header row and its own anchors
  // (error-code tables anchor every row).
  const visitTable = ($table) => {
    const paragraphs = $table.find("p");
    const code = paragraphs.filter("p.p_CodeExample");
    if (code.length && code.length === paragraphs.length) {
      collectAnchors($table);
      return add("code", code.map((_, p) => codeText($(p))).get().join("\n"));
    }
    tableNo += 1;
    let header = null;
    // A first th row is a header only when its cells are short labels such as
    // "Identifier"; th rows holding content ("Methods inherited from class
    // CCanvas" as a heading with its method list) are kept as rows.
    const rows = $table.find("tr").filter((_, tr) => $(tr).closest("table").is($table));
    rows.each((index, tr) => {
      collectAnchors($(tr));
      const cells = $(tr).children("th, td").map((_, cell) => cellText($(cell))).get();
      const isHeader = index === 0 && $(tr).children("th").length && !$(tr).find(HEADING_SELECTOR).length
        && cells.every((cell) => cell.length <= MAX_LABEL);
      if (isHeader) header = cells.join(" | ");
      else add("row", cells.join(" | "), { tableNo, header });
    });
  };

  // List items hold their text directly (return-value cases, steps), so each
  // becomes a paragraph with its bullet or number; nested blocks follow it.
  const visitListItem = ($li, marker) => {
    const own = $li.clone();
    own.children("ul, ol, p, table, div").remove();
    collectAnchors(own);
    const text = normalizeSpace(own.text());
    add("paragraph", text && `${marker} ${text}`);
    visit({ children: $li.children("ul, ol, p, table, div").toArray() });
  };

  const visit = (node) => {
    let itemNo = 0;
    for (const child of node.children ?? []) {
      if (child.type !== "tag") continue;
      const $child = $(child);
      if (child.name === "a" && $child.attr("name")) anchors.push($child.attr("name"));
      else if (child.name === "table") visitTable($child);
      else if (child.name === "p") visitParagraph($child);
      else if (child.name === "li") visitListItem($child, node.name === "ol" ? `${++itemNo}.` : "-");
      else visit(child);
    }
  };
  for (const node of help.toArray()) visit(node);
  return { title, keywords, blocks, owners: declaredOwners(title, blocks) };
}

// Owners printed in the page's declarations ("bool matrix::CopyRates(",
// "vector vector::NormalizeDouble("), read from the code in its introduction.
// Some method pages sit under a category breadcrumb, so this is the only
// place their owner shows.
function declaredOwners(title, blocks) {
  if (!IDENTIFIER.test(title)) return [];
  const pattern = new RegExp(`\\b([A-Za-z_]\\w*)::${title}\\s*\\(`, "g");
  const owners = new Set();
  for (const block of blocks.slice(0, introEnd(blocks))) {
    if (block.kind === "code") for (const match of block.text.matchAll(pattern)) owners.add(match[1]);
  }
  return [...owners];
}

// Classes and interfaces declared under a Declaration heading or label
// ("class CChartObjectArrowCheck : public CChartObjectArrow;"). One page can
// document several classes.
function declaredClasses(blocks) {
  const DECLARATION = /^declarations?$/i;
  const classes = new Set();
  blocks.forEach((block, i) => {
    const labelled = DECLARATION.test(block.heading) || (blocks[i - 1]?.kind === "paragraph" && DECLARATION.test(blocks[i - 1].text));
    if (block.kind !== "code" || !labelled) return;
    for (const match of block.text.matchAll(/\b(?:class|interface)\s+((?:Ci?|I)[A-Z]\w*)/g)) classes.add(match[1]);
  });
  return [...classes];
}

function findFile(dir, extension) {
  const file = readdirSync(dir).find((name) => name.toLowerCase().endsWith(extension));
  if (!file) throw new Error(`No ${extension} file in ${dir}`);
  return join(dir, file);
}

function splitTarget(target) {
  const [file, anchor] = target.split("#");
  return { file: file.toLowerCase(), anchor: anchor || null };
}

function pageId(source, file) {
  return `${source}/${file.replace(/\.html?$/i, "").toLowerCase()}`;
}

// Consecutive blocks under one heading form a full-text section.
function sectionsOf(blocks) {
  const sections = [];
  for (const block of blocks) {
    const current = sections.at(-1);
    if (current && current.heading === block.heading) current.texts.push(block.text);
    else sections.push({ heading: block.heading, texts: [block.text] });
  }
  return sections;
}

function indexSource(statements, source, dir) {
  const toc = parseSitemap(decodePage(readFileSync(findFile(dir, ".hhc"))));
  const keywordIndex = parseSitemap(decodePage(readFileSync(findFile(dir, ".hhk"))));
  const tocByFile = new Map();
  for (const entry of toc) {
    for (const target of entry.targets) {
      const { file } = splitTarget(target);
      if (!tocByFile.has(file)) tocByFile.set(file, entry);
    }
  }

  // seq keeps the order names were found in (keyword-index order among
  // them), which ranking uses to break ties.
  const seen = new Set();
  const members = new Map();
  const addName = (name, id, kind, anchor = null) => {
    const key = `${name}\u0000${id}\u0000${anchor ?? ""}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    statements.name.run(name, name.toLowerCase(), id, kind, members.get(id) ? 1 : 0, anchor, statements.nextSeq++);
  };

  const files = readdirSync(dir).filter((name) => /\.html?$/i.test(name)).sort();
  const titles = new Map();
  const classes = new Map();
  for (const file of files) {
    const id = pageId(source, file);
    const page = parsePage(decodePage(readFileSync(join(dir, file))));
    titles.set(id, page.title);
    classes.set(id, declaredClasses(page.blocks));
    const entry = tocByFile.get(file.toLowerCase());
    const breadcrumb = entry ? [...entry.parents, entry.name].join(" > ") : page.title;
    const owners = new Set(page.owners);
    const parent = entry?.parents.at(-1);
    if (parent && CLASS_NAME.test(parent) && IDENTIFIER.test(page.title)) owners.add(ownerOf(parent));
    members.set(id, owners.size > 0);

    statements.page.run(id, source, file, page.title, breadcrumb, owners.size > 0 ? 1 : 0);
    page.blocks.forEach((block, pos) => statements.block.run(id, pos, block.kind, block.text, block.heading,
      block.tableNo, block.header, block.anchors.length ? block.anchors.join(" ") : null));
    for (const section of sectionsOf(page.blocks)) {
      statements.section.run(id, page.title, section.heading, section.texts.join("\n"));
    }
    addName(page.title, id, "title");
    // A book chapter is also found by its title without its number ("1.5.2 Dropout" → "Dropout").
    const shortTitle = /^\d+(?:\.\d+)*\.?\s+(.+)$/.exec(page.title)?.[1];
    if (shortTitle) addName(shortTitle, id, "keyword");
    for (const owner of owners) addName(`${owner}::${page.title}`, id, "member");
    for (const keyword of page.keywords) addName(keyword, id, "keyword");
  }

  // Some methods sit under a descriptive contents entry ("Moving Average",
  // "Arrows with fixed code") whose page is the class page: the owners are
  // that page's title (CiMA) or the classes its Declaration section declares.
  for (const file of files) {
    const id = pageId(source, file);
    const entry = tocByFile.get(file.toLowerCase());
    if (members.get(id) || !entry?.parentTarget || !IDENTIFIER.test(titles.get(id))) continue;
    const owners = classes.get(pageId(source, splitTarget(entry.parentTarget).file)) ?? [];
    if (!owners.length) continue;
    members.set(id, true);
    statements.pageMember.run(id);
    statements.nameMember.run(id);
    for (const owner of owners) addName(`${owner}::${titles.get(id)}`, id, "member");
  }

  const pageIds = new Set(files.map((file) => pageId(source, file)));
  for (const entry of keywordIndex) {
    for (const target of entry.targets) {
      const { file, anchor } = splitTarget(target);
      const id = pageId(source, file);
      if (pageIds.has(id)) addName(entry.name, id, "keyword", anchor);
    }
  }
}

// Cards are built once every page and name is stored, because See also
// entries are resolved to page ids through the names.
function buildCards(db) {
  const candidates = db.prepare(`select n.page_id, n.member, p.title = n.name as titled
    from names n join pages p on p.id = n.page_id where n.name = ?`);
  const ownersOf = db.prepare("select name from names where page_id = ? and kind = 'member'");
  const insertCard = db.prepare("insert into cards values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertNote = db.prepare("insert or ignore into notes values (?, ?)");
  const enumOfAnchorOn = db.prepare("select name from names where page_id = ? and anchor = ? and name like 'ENUM!_%' escape '!'");
  // Enums the keyword index points at the page itself; an enum that also has
  // an anchored definition on the page belongs to that section, not the page.
  const enumsOfPage = db.prepare(`select distinct name from names
    where page_id = ?1 and anchor is null and name like 'ENUM!_%' escape '!'
      and name not in (select name from names where page_id = ?1 and anchor is not null)`);
  const hasName = db.prepare("select 1 from names where name = ? and page_id = ?");
  const ownName = db.prepare("select 1 from names where name = ? and page_id = ? and kind in ('title', 'keyword')");
  const insertName = db.prepare("insert into names values (?, ?, ?, 'constant', 0, ?, ?)");
  let seq = db.prepare("select coalesce(max(seq), -1) + 1 as next from names").get().next;

  // A See also name links to a page only when that page is clear: the
  // current page's own owner first ("Copy" on a matrix page is matrix::Copy,
  // but never the page itself), then a single page, then a single global page
  // with that title. An ambiguous name stays unlinked rather than pointing at
  // the wrong page.
  const unique = (ids) => [...new Set(ids)];
  const resolveFor = (owners, selfId) => (name) => {
    for (const owner of owners) {
      const own = unique(candidates.all(`${owner}::${name}`).map((row) => row.page_id)).filter((id) => id !== selfId);
      if (own.length === 1) return own[0];
    }
    const rows = candidates.all(name);
    const pages = unique(rows.map((row) => row.page_id));
    if (pages.length === 1) return pages[0];
    const global = unique(rows.filter((row) => row.titled && !row.member).map((row) => row.page_id));
    return global.length === 1 ? global[0] : null;
  };

  for (const page of db.prepare("select id, title, member from pages").all()) {
    if (SUMMARY_PAGES.has(page.id)) continue;
    const blocks = blocksOfPage(db, page.id);
    const owners = ownersOf.all(page.id).map((row) => row.name.split("::")[0]);
    const card = pageCard(page, blocks, resolveFor(owners, page.id), (name) => Boolean(ownName.get(name, page.id)));
    if (card) insertCard.run(card.name, page.id, card.kind, null, null, null, null, card.full, card.brief);

    // One card per constant and page; a constant repeated on the same page keeps its first row.
    const enumOfAnchor = (anchor) => {
      if (anchor) return enumOfAnchorOn.get(page.id, anchor)?.name ?? null;
      const pageEnums = enumsOfPage.all(page.id);
      return pageEnums.length === 1 ? pageEnums[0].name : null;
    };
    const seen = new Set();
    for (const constant of constantCards(page, blocks, enumOfAnchor)) {
      if (seen.has(constant.name)) continue;
      seen.add(constant.name);
      insertCard.run(constant.name, page.id, "constant", constant.anchor, constant.value, constant.enum,
        constant.notesKey, constant.full, constant.brief);
      if (constant.notesKey) insertNote.run(constant.notesKey, constant.notes);
      if (!hasName.get(constant.name, page.id)) insertName.run(constant.name, constant.name.toLowerCase(), page.id, constant.anchor, seq++);
    }
  }
}

// Builds a new index file from unpacked sources ({ source, dir } each, with
// source "mql5", "book" or "nn") in one transaction, then compacts the
// full-text index once. A failure rolls everything back.
export function buildIndex(dbPath, sources, meta = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    const statements = {
      page: db.prepare("insert into pages values (?, ?, ?, ?, ?, ?)"),
      block: db.prepare("insert into blocks values (?, ?, ?, ?, ?, ?, ?, ?)"),
      name: db.prepare("insert into names values (?, ?, ?, ?, ?, ?, ?)"),
      section: db.prepare("insert into sections values (?, ?, ?, ?)"),
      pageMember: db.prepare("update pages set member = 1 where id = ?"),
      nameMember: db.prepare("update names set member = 1 where page_id = ?"),
      nextSeq: 0,
    };
    const insertMeta = db.prepare("insert into meta values (?, ?)");
    db.exec("begin");
    try {
      for (const { source, dir } of sources) indexSource(statements, source, dir);
      buildCards(db);
      db.exec("insert into sections (sections) values ('optimize')");
      for (const [key, value] of Object.entries({ schema_version: SCHEMA_VERSION, ...meta })) {
        insertMeta.run(key, String(value));
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } finally {
    db.close();
  }
}
