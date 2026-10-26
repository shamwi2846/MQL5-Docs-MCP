// mql5_find: names get their answer card, questions the best card or
// passage, all in one reply within a fixed budget.
import { EXPANSIONS } from "./config.mjs";
import { CLASS_LAYOUT, sectionEnd } from "./cards.mjs";
import { mainPage, rankPages } from "./names.mjs";
import { blocksOfPage, focusStart, PAGE_SIZE, paginate, quoteArgument } from "./search.mjs";

export const FIND_BUDGET = 12000;
const MAX_QUERIES = 16;
const BRIEF_BLOCK = 480;
const QUERY_ECHO = 100;
const PASSAGE = 800;
const MAX_ALSO = 5;
const STOPWORDS = new Set(["a", "an", "and", "are", "can", "do", "does", "for", "from", "get", "how", "i", "in", "is",
  "it", "me", "my", "of", "on", "or", "the", "to", "use", "what", "when", "which", "with"]);

// Accepts a list, a single string, or a list sent as JSON text (one real
// Claude Code call did that). Up to 16 queries are answered.
export function normalizeQueries(input) {
  let list = input;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      list = Array.isArray(parsed) ? parsed : [input];
    } catch {
      list = [input];
    }
  }
  const queries = (Array.isArray(list) ? list : []).filter((query) => typeof query === "string")
    .map((query) => query.trim()).filter(Boolean);
  return { queries: queries.slice(0, MAX_QUERIES), skipped: queries.slice(MAX_QUERIES) };
}

// "OrderSend()" and "OrderSend(...)" are read as OrderSend, "CTrade.Buy" as
// CTrade::Buy. Questions are never rewritten.
export function nameForm(query) {
  const call = /^([A-Za-z_][\w:]*)\s*\(.*\)\s*;?$/.exec(query);
  if (call) return call[1];
  const dotted = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(query);
  return dotted ? `${dotted[1]}::${dotted[2]}` : query;
}

// A name found as written, after its form was normalized, or only by
// ignoring case. No two keyword-index names differ only by case, but a book
// chapter's short title can ("Input variables" next to "Input Variables"):
// then the spelling whose main page is in the Reference wins.
function resolveName(db, query) {
  const name = nameForm(query);
  if (db.prepare("select 1 from names where name = ?").get(name)) return { name, change: name === query ? null : "read as" };
  const spellings = db.prepare("select distinct name from names where lower = ? order by name").all(name.toLowerCase()).map((row) => row.name);
  if (!spellings.length) return null;
  return { name: spellings.find((spelling) => mainPage(db, spelling)?.source === "mql5") ?? spellings[0], change: "spelling corrected to" };
}

const echo = (query) => (query.length > QUERY_ECHO ? `${query.slice(0, QUERY_ECHO - 1)}…` : query);
const pageTitle = (db, id) => db.prepare("select title, breadcrumb from pages where id = ?").get(id);

function ownerName(db, pageId, name) {
  const row = db.prepare("select name from names where page_id = ? and kind = 'member' and name like ?").get(pageId, `%::${name}`);
  return row?.name ?? pageTitle(db, pageId)?.title ?? pageId;
}

function cardOf(db, name, pageId) {
  return db.prepare("select name, kind, value, enum, notes_key, full, brief from cards where page_id = ? and kind = 'constant' and name = ?").get(pageId, name)
    ?? db.prepare("select name, kind, value, enum, notes_key, full, brief from cards where page_id = ? and kind <> 'constant'").get(pageId);
}

// A passage of a page as mql5_read prints it, from a start block, cut at a
// block boundary. readArgs are the mql5_read arguments that read on from its
// start; the full form ends with them when the passage was cut.
function passage(pageId, blocks, start, size, focus) {
  const pages = paginate(blocks, start, size);
  const readArgs = `id=${pageId}${focus ? ` focus=${quoteArgument(focus)}` : ""}`;
  return { full: pages.length > 1 ? `${pages[0]}\nmore: mql5_read ${readArgs}` : pages[0], brief: pages[0], readArgs };
}

function outcomeLine(query, name, change, card, pageId, title) {
  const shown = change ? `${echo(query)} → ${change} ${name}` : name;
  if (!card) return `= ${shown} · ${title === name ? "page" : title} · ${pageId}`;
  if (card.kind !== "constant") return `= ${shown} · ${card.kind} · ${pageId}`;
  const facts = [card.enum && `of ${card.enum}`, card.value && `value ${card.value}`].filter(Boolean).join(", ");
  return `= ${shown} · constant${facts ? ` ${facts}` : ""} · ${pageId}`;
}

// Names: the winner's card (or its anchored passage), plus other pages with
// the name. When two or more class members share the name and no global API
// wins (104 pages are titled "Create"), no card is shown.
function answerName(db, query, resolved) {
  const { name, change } = resolved;
  const pages = rankPages(db, name);
  const titledMembers = pages.filter((page) => page.titled && page.member);
  const globalTitled = pages.some((page) => page.titled && !page.member);
  if (!globalTitled && titledMembers.length >= 2) {
    const owners = titledMembers.slice(0, MAX_ALSO).map((page) => `${ownerName(db, page.page_id, name)} (${page.page_id})`);
    const more = titledMembers.length > MAX_ALSO ? `, +${titledMembers.length - MAX_ALSO} more` : "";
    return { outcome: `= ${echo(query)} · ${titledMembers.length} pages share this name: ${owners.join(", ")}${more}. Ask with Class::Method.` };
  }
  const winner = pages[0];
  // A page's card describes one item (the calendar structures page's card is
  // MqlCalendarCountry, a function page's card the function). A name with its
  // own section further down the page (MqlCalendarEvent, an enum on a
  // function page) answers with that section instead of the other item's card.
  const pageCard = cardOf(db, name, winner.page_id);
  const otherItem = pageCard && pageCard.kind !== "constant" && pageCard.name !== name && winner.anchor;
  const blocks = !pageCard || otherItem ? blocksOfPage(db, winner.page_id) : null;
  const anchorAt = blocks && winner.anchor ? blocks.findIndex((block) => block.anchors.includes(winner.anchor)) : -1;
  const card = otherItem && anchorAt > 0 ? null : pageCard;
  const info = pageTitle(db, winner.page_id);
  const others = pages.slice(1);
  const alsoNamed = others.length
    ? `Also named ${name}: ${others.slice(0, MAX_ALSO).map((page) => `${ownerName(db, page.page_id, name)} (${page.page_id})`).join(", ")}`
      + (others.length > MAX_ALSO ? ` (+${others.length - MAX_ALSO} more)` : "")
    : null;
  // A phrase that matched a title only by ignoring case ("global variables")
  // may mean another page ("Global Variables of the Terminal"): the best
  // search results are listed too.
  const named = new Set(pages.map((page) => page.page_id));
  const related = change === "spelling corrected to" && /\s/.test(query)
    ? searchPages(db, questionTerms(db, query).terms, query).filter((id) => !named.has(id)).slice(0, 2) : [];
  const relatedLine = related.length ? `Other pages: ${related.map((id) => `${pageTitle(db, id).title} (${id})`).join(", ")}` : null;
  const also = [alsoNamed, relatedLine].filter(Boolean).join("\n") || null;
  const outcome = outcomeLine(query, name, change, card, winner.page_id, info.title);
  if (card) {
    return {
      outcome, key: `card:${winner.page_id}:${card.name}`, full: card.full, brief: card.brief, also,
      notesKey: card.notes_key, readId: winner.page_id, readArgs: `id=${winner.page_id}`, findName: name,
    };
  }
  // An anchored name (an enum) gets its own section, from the anchor to the
  // next heading or anchor, up to one read page, so a rule at its end stays
  // (RETURN for pending orders). Any other name starts where the page has it
  // (a #property name's own row), a page's own title at the page start.
  const nameAt = anchorAt < 0 && name !== info.title ? focusStart(db, winner.page_id, blocks, name) : -1;
  const shown = anchorAt >= 0
    ? passage(winner.page_id, blocks.slice(0, sectionEnd(blocks, anchorAt)), anchorAt, PAGE_SIZE, name)
    : passage(winner.page_id, blocks, Math.max(nameAt, 0), PASSAGE, nameAt >= 0 ? name : null);
  // A section answer ends at its section, so it never stands in for a page passage that starts at the same place.
  const key = anchorAt >= 0 ? `section:${winner.page_id}:${anchorAt}` : `passage:${winner.page_id}:${Math.max(nameAt, 0)}`;
  return { outcome, key, ...shown, also, readId: winner.page_id };
}

const wordsOf = (text) => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

// API names written in a question ("open a trade using CTrade::Sell"): words
// with "::", "_", an inner capital or two capitals (CTrade), so plain words
// such as "Open" don't count.
const API_NAME = /::|_|[a-z][A-Z]|[A-Z].*[A-Z]/;
const MAX_METHODS = 2;
const camelWords = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_]+/);

// Methods of a class a question names whose name's words all appear in the
// question ("close an open position with CTrade" → CTrade::PositionClose).
function methodsAsked(db, owner, words) {
  return db.prepare("select name, page_id from names where kind = 'member' and name like ? escape '!' order by name")
    .all(`${owner.replace(/[!%_]/g, "!$&")}::%`)
    .filter((row) => camelWords(row.name.split("::")[1]).every((word) => words.includes(word)))
    .slice(0, MAX_METHODS).map((row) => row.page_id);
}

// Product names say nothing in a question (every page is about MetaTrader 5),
// and the Python-integration pages repeat them: "in MetaTrader 5" pulled
// those pages ahead of the MQL5 page that answers. A version number after the
// name ("MetaTrader 5", "MQL 5") goes with it.
const PRODUCT_NAMES = new Set(["metatrader", "mt5", "mql5", "mql"]);
const productName = (word, before) => PRODUCT_NAMES.has(word) || (/^\d$/.test(word) && (before === "metatrader" || before === "mql"));

// A question's search words without stopwords and product names, and its
// candidate pages: API names the question writes first (a class preceded by
// its methods the question asks for; `names` and `named` keep these apart),
// then phrase expansions, whose terms that are names add their main page in
// the listed order ("indicator buffer values" → CopyBuffer, SetIndexBuffer);
// other terms add search words. The question's own words are always kept.
function questionTerms(db, query) {
  const words = wordsOf(query);
  const kept = words.filter((word, i) => !STOPWORDS.has(word) && !productName(word, words[i - 1]));
  const terms = new Set(kept.length ? kept : words);
  const names = [];
  const named = [];
  for (const word of query.match(/[A-Za-z_]\w*(?:::\w+)?/g) ?? []) {
    const page = API_NAME.test(word) && mainPage(db, word)?.page_id;
    if (!page) continue;
    names.push(word);
    named.push(...methodsAsked(db, word, words), page);
  }
  const pages = [...named];
  const lower = query.toLowerCase();
  for (const expansion of EXPANSIONS) {
    if (!expansion.phrases.some((phrase) => lower.includes(phrase))) continue;
    for (const term of expansion.terms) {
      const page = mainPage(db, term);
      if (page) pages.push(page.page_id);
      else for (const word of wordsOf(term)) terms.add(word);
    }
  }
  return { terms: [...terms], pages, names, named };
}

// How rare a word is across all sections (inverse document frequency),
// counted once per index.
const sectionCounts = new WeakMap();
function rarity(db, term) {
  if (!sectionCounts.has(db)) sectionCounts.set(db, { total: db.prepare("select count(*) as n from sections").get().n, terms: new Map() });
  const counts = sectionCounts.get(db);
  if (!counts.terms.has(term)) counts.terms.set(term, db.prepare("select count(*) as n from sections where sections match ?").get(`"${term}"`).n);
  return Math.log((counts.total + 1) / (counts.terms.get(term) + 1));
}

// A page titled with a word the question writes with one capital ("Print in
// the strategy tester log"), when no other non-member page has that title
// (two fuzzy-system pages are titled "Calculate").
function titledPages(db, query) {
  const titled = db.prepare("select id from pages where title = ? and member = 0");
  const capitalized = new Set((query.match(/[A-Za-z_]\w*/g) ?? []).filter((word) => /^[A-Z][a-z0-9]+$/.test(word)));
  return new Set([...capitalized].flatMap((word) => {
    const rows = titled.all(word);
    return rows.length === 1 ? [rows[0].id] : [];
  }));
}

// Full-text search over all books, merged per page by its best section, best
// first. A section keeps a modest boost for the Reference and loses up to half
// its score when it lacks the question's rarer words, so an overview that only
// shares "calendar functions available" doesn't beat the book page that
// answers "... in the tester". A class page's method catalogue counts half:
// it shares a trading question's words without answering it (CExpert lists
// "Pending Order Triggered"). A page titled with a capitalized word of the
// question counts double: "print" alone is in every code example.
const MISSING_WORDS = 0.5;
const CATALOGUE = 0.5;
const TITLE_WORD = 2;
function searchPages(db, terms, query) {
  if (!terms.length) return [];
  const weights = new Map(terms.map((term) => [term, rarity(db, term)]));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0) || 1;
  const titled = titledPages(db, query);
  const match = terms.map((term) => `"${term}"`).join(" OR ");
  const rows = db.prepare(`select s.page_id, s.heading, s.title || ' ' || s.heading || ' ' || s.body as text,
    bm25(sections, 0, 10, 5, 1) as score, p.source
    from sections s join pages p on p.id = s.page_id where sections match ? order by score limit 200`).all(match);
  const best = new Map();
  for (const row of rows) {
    const words = new Set(wordsOf(row.text));
    const found = terms.reduce((sum, term) => sum + (words.has(term) ? weights.get(term) : 0), 0);
    let score = row.score * (row.source === "mql5" ? 1.25 : 1) * MISSING_WORDS ** (1 - found / total);
    if (CLASS_LAYOUT.test(row.heading)) score *= CATALOGUE;
    if (titled.has(row.page_id)) score *= TITLE_WORD;
    if (!best.has(row.page_id) || score < best.get(row.page_id)) best.set(row.page_id, score);
  }
  return [...best].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

// Where a question's passage starts: the prose block that best covers the
// question's words the page title doesn't already hold (each counting 1 plus
// its rarity), with its section heading counted too, so a section about the
// topic beats a contents line. Words match singular or plural ("Testing
// Trading Strategies" holds "strategy"). Code never counts ("long" in a
// declaration). The focus lets mql5_read start at the same place.
// "news" is not the plural of "new".
const singular = (word) => (word === "news" ? word : word.replace(/ies$/, "y").replace(/(?<!s)s$/, ""));
const singularWords = (text) => new Set(wordsOf(text).map(singular));
function passageStart(db, page, blocks, terms) {
  const title = singularWords(page.title);
  const asked = terms.filter((term) => !title.has(singular(term))).sort((a, b) => rarity(db, b) - rarity(db, a));
  const weight = (text) => {
    const words = singularWords(text);
    return asked.reduce((sum, term) => sum + (words.has(singular(term)) ? 1 + rarity(db, term) : 0), 0);
  };
  let start = -1;
  let best = 0;
  blocks.forEach((block, i) => {
    if (block.kind === "code" || block.kind === "heading") return;
    const score = weight(block.text) + weight(block.heading);
    if (score > best) [best, start] = [score, i];
  });
  if (start < 0) return { start: 0, focus: null };
  const term = asked.find((word) => wordsOf(blocks[start].text).includes(word));
  return { start, focus: term && focusStart(db, page.id, blocks, term) === start ? term : blocks[start].heading || null };
}

// Whether one prose block of a page, counted with its heading, holds every
// word. Code never counts: a code example that calls an API says nothing
// about the context it is asked in. Neither does a class's method catalogue,
// which names methods without explaining them; other table rows do count (a
// constant's row is its description).
function proseHolds(db, pageId, words) {
  return blocksOfPage(db, pageId).some((block) => {
    if (block.kind === "code" || CLASS_LAYOUT.test(block.heading)) return false;
    const found = new Set([...wordsOf(block.text), ...wordsOf(block.heading ?? "")]);
    return words.every((word) => found.has(word));
  });
}

// A question that names an API in a context its page never covers ("CopyTicks
// in the Strategy Tester": no paragraph of the CopyTicks page holds strategy
// and tester) is answered by the best search result with a paragraph holding
// the API and the whole context (Testing Trading Strategies: "the CopyTicks
// function allows receiving ticks outside the cache (only when testing on
// real ticks)"); the API's page is listed next. A word the API page happens
// to share ("ticks") doesn't keep it first. Another page the question names
// that covers the context comes first instead ("OnDeinit when I use
// ExpertRemove in optimization" → ExpertRemove).
function contextPage(db, apiWords, named, context, searched) {
  if (!named.length || !context.length || proseHolds(db, named[0], context)) return null;
  return named.find((id) => proseHolds(db, id, context))
    ?? searched.find((id) => !named.includes(id) && proseHolds(db, id, [...apiWords, ...context])) ?? null;
}

// Questions: candidates from the question's API names and expansions first,
// then search; the top page shows its card when it is a function or method
// (signature, parameters, notes), otherwise the passage that covers the
// question best: a class card is a method catalogue and a struct card the
// whole page ("Modify Pending Order" is one section of MqlTradeRequest's 6,000
// characters). The next two pages are listed.
function answerQuestion(db, query) {
  const { terms, pages, names, named } = questionTerms(db, query);
  if (!terms.length) return null;
  const searched = searchPages(db, terms, query);
  // The question's own words set its context and place the passage; words from expansions only find pages.
  const asked = wordsOf(query);
  const own = terms.filter((term) => asked.includes(term));
  const apiWords = new Set(names.flatMap(wordsOf));
  const lead = contextPage(db, [...apiWords], named, own.filter((term) => !apiWords.has(term)), searched);
  const [first, ...rest] = [...new Set([...(lead ? [lead] : []), ...pages, ...searched])].slice(0, 3)
    .map((id) => ({ id, title: pageTitle(db, id).title }));
  if (!first) return null;
  const card = db.prepare("select name, kind, full, brief from cards where page_id = ? and kind in ('function', 'method')").get(first.id);
  const outcome = `~ ${echo(query)} · no exact name; best match: ${first.title} · ${first.id}`;
  const others = rest.length ? `Other pages: ${rest.map((page) => `${page.title} (${page.id})`).join(", ")}` : null;
  if (card) {
    return {
      outcome, key: `card:${first.id}:${card.name}`, full: card.full, brief: card.brief, also: others,
      readId: first.id, readArgs: `id=${first.id}`, findName: card.name,
    };
  }
  const blocks = blocksOfPage(db, first.id);
  const { start, focus } = passageStart(db, first, blocks, own);
  return { outcome, key: `passage:${first.id}:${start}`, ...passage(first.id, blocks, start, PASSAGE, focus), also: others, readId: first.id };
}

// Typo fallback: names within two edits, loaded only the first time it is
// needed, each shown with its main page so it can be read at once.
const namesCache = new WeakMap();
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
function didYouMean(db, query) {
  if (!namesCache.has(db)) namesCache.set(db, db.prepare("select distinct name from names where length(name) >= 4").all().map((row) => row.name));
  const target = query.toLowerCase();
  return namesCache.get(db).filter((name) => Math.abs(name.length - query.length) <= 2)
    .map((name) => ({ name, distance: editDistance(name.toLowerCase(), target) }))
    .filter((candidate) => candidate.distance <= 2).sort((a, b) => a.distance - b.distance).slice(0, 3)
    .map((candidate) => `${candidate.name} (${mainPage(db, candidate.name).page_id})`);
}

function answer(db, query) {
  const resolved = resolveName(db, query);
  if (resolved) return answerName(db, query, resolved);
  const result = answerQuestion(db, query);
  if (result) return result;
  const suggestions = /^[\w:.()]+$/.test(query) ? didYouMean(db, nameForm(query)) : [];
  return { outcome: suggestions.length
    ? `none · ${echo(query)} · did you mean: ${suggestions.join(", ")}?`
    : `none · ${echo(query)} · nothing matched; rephrase, or check mql5.com` };
}

// Fits brief text into `room` characters: whole lines while they fit, then a
// prose line shortened at a word. A signature or table row is never cut: a
// first line too long to keep whole is left out for the lines after it, and
// the brief's marker says where to read it.
function fitBrief(text, room) {
  const lines = text.split("\n");
  const kept = [];
  for (const line of lines) {
    const left = room - kept.join("\n").length - (kept.length ? 1 : 0);
    if (line.length <= left) {
      kept.push(line);
      continue;
    }
    const cut = /[.!?…]$/.test(line) ? line.lastIndexOf(" ", left - 2) : -1;
    if (cut > 0) kept.push(`${line.slice(0, cut)}…`);
    break;
  }
  if (!kept.length && lines.length > 1) return fitBrief(lines.slice(1).join("\n"), room);
  return kept.join("\n");
}

// Where the cut part of an oversized card starts on its page: the heading
// above the first line left out, and the read page from that heading that
// holds the line (found by its start; a parameter line "name [in] text" is
// found by its text). Never later than the line, so nothing is skipped.
function continuation(db, item, lines, kept) {
  const blocks = blocksOfPage(db, item.readId);
  const headings = new Set(blocks.filter((block) => block.kind === "heading").map((block) => `${block.text}:`));
  const heading = lines.slice(0, kept + 1).findLast((line) => headings.has(line));
  if (!heading) return item.readArgs;
  const focus = heading.slice(0, -1);
  const pages = paginate(blocks, focusStart(db, item.readId, blocks, focus), PAGE_SIZE);
  const omitted = lines[kept];
  const probes = [omitted, omitted.slice(omitted.indexOf(" ") + 1)].map((text) => text.slice(0, 60));
  const page = Math.max(pages.findIndex((text) => probes.some((probe) => text.includes(probe))), 0) + 1;
  return `id=${item.readId} focus=${quoteArgument(focus)}${page > 1 ? ` page=${page}` : ""}`;
}

// Assembles the reply within the budget: every outcome line always; full
// blocks when they all fit, otherwise each query's full block if it still
// leaves room for the brief blocks after it, else its brief block; repeated
// results and shared section notes are shown once.
export function findText(db, input, { tag, downloaded }) {
  const { queries, skipped } = normalizeQueries(input);
  const header = `MQL5 docs downloaded ${downloaded} · index ${tag}`;
  const skippedLine = skipped.length
    ? `(${skipped.length} more queries skipped: ${skipped.slice(0, 3).map(echo).join(", ")}${skipped.length > 3 ? ", …" : ""})` : null;
  if (!queries.length) return [header, "none · no query given"].join("\n");
  const answers = queries.map((query) => answer(db, query));

  const seen = new Set();
  const notesSeen = new Set();
  const fullOf = (item) => {
    if (!item.full) return item.outcome;
    if (seen.has(item.key)) return `${item.outcome} (shown above)`;
    const notes = item.notesKey && !notesSeen.has(item.notesKey) ? db.prepare("select text from notes where key = ?").get(item.notesKey)?.text : null;
    const sharedNotes = item.notesKey && notesSeen.has(item.notesKey) ? "Section notes shown above." : null;
    return [item.outcome, item.full, notes && `Section notes: ${notes}`, sharedNotes, item.also].filter(Boolean).join("\n");
  };
  const markFull = (item) => {
    if (item.key) seen.add(item.key);
    if (item.notesKey) notesSeen.add(item.notesKey);
  };
  const briefOf = (item) => {
    if (!item.full) return item.outcome;
    if (seen.has(item.key)) return `${item.outcome} (shown above)`;
    const marker = item.findName && fullOf(item).length <= FIND_BUDGET
      ? `(brief; full card: mql5_find ${item.findName})` : `(brief; read the rest: mql5_read ${item.readArgs})`;
    const text = fitBrief(item.brief, BRIEF_BLOCK - item.outcome.length - marker.length - 2);
    return [item.outcome, text, marker].filter(Boolean).join("\n");
  };
  const fixed = header.length + (skippedLine ? skippedLine.length + 1 : 0) + 2;

  // A single oversized card is shown up to the budget at line boundaries.
  const render = (parts) => [header, ...parts, skippedLine].filter(Boolean).join("\n\n");
  const fulls = [];
  for (const item of answers) {
    fulls.push(fullOf(item));
    markFull(item);
  }
  if (render(fulls).length <= FIND_BUDGET) return render(fulls);
  if (answers.length === 1) {
    const lines = fulls[0].split("\n");
    let kept = 0;
    let used = fixed;
    while (kept < lines.length && used + lines[kept].length + 1 <= FIND_BUDGET - 120) used += lines[kept++].length + 1;
    return render([`${lines.slice(0, kept).join("\n")}\n[continues: mql5_read ${continuation(db, answers[0], lines, kept)}]`]);
  }

  seen.clear();
  notesSeen.clear();
  const parts = [];
  let used = fixed;
  answers.forEach((item, index) => {
    const restBriefs = answers.slice(index + 1).reduce((sum, rest) => sum + briefOf(rest).length + 2, 0);
    const full = fullOf(item);
    let block;
    if (used + full.length + 2 + restBriefs <= FIND_BUDGET) {
      block = full;
      markFull(item);
    } else {
      const brief = briefOf(item);
      block = used + brief.length + 2 + restBriefs <= FIND_BUDGET ? brief
        : `${item.outcome}${item.readId ? `\n(not shown: ${item.findName ? `mql5_find ${item.findName}` : `mql5_read ${item.readArgs}`})` : ""}`;
      // A repeat of this result later in the reply points back here; its
      // section notes were not printed, so they stay unmarked.
      if (item.key) seen.add(item.key);
    }
    parts.push(block);
    used += block.length + 2;
  });
  return render(parts);
}
