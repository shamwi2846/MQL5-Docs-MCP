// mql5_find: names get their answer card, questions the best card or
// passage, all in one reply within a fixed budget.
import { EXPANSIONS } from "./config.mjs";
import { sectionEnd } from "./cards.mjs";
import { mainPage, rankPages } from "./names.mjs";
import { blocksOfPage, focusStart, PAGE_SIZE, paginate, quoteArgument } from "./search.mjs";

export const FIND_BUDGET = 12000;
const MAX_QUERIES = 16;
const BRIEF_BLOCK = 480;
const QUERY_ECHO = 100;
const PASSAGE = 800;
const ANCHOR_PASSAGE = 3000;
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
// ignoring case (no two keyword-index names differ only by case).
function resolveName(db, query) {
  const name = nameForm(query);
  if (db.prepare("select 1 from names where name = ?").get(name)) return { name, change: name === query ? null : "read as" };
  const lower = db.prepare("select distinct name from names where lower = ? order by name").all(name.toLowerCase());
  return lower.length ? { name: lower[0].name, change: "spelling corrected to" } : null;
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
  const card = cardOf(db, name, winner.page_id);
  const info = pageTitle(db, winner.page_id);
  const others = pages.slice(1);
  const also = others.length
    ? `Also named ${name}: ${others.slice(0, MAX_ALSO).map((page) => `${ownerName(db, page.page_id, name)} (${page.page_id})`).join(", ")}`
      + (others.length > MAX_ALSO ? ` (+${others.length - MAX_ALSO} more)` : "")
    : null;
  const outcome = outcomeLine(query, name, change, card, winner.page_id, info.title);
  if (card) {
    return {
      outcome, key: `card:${winner.page_id}:${card.name}`, full: card.full, brief: card.brief, also,
      notesKey: card.notes_key, readId: winner.page_id, readArgs: `id=${winner.page_id}`, findName: name,
    };
  }
  // An anchored name (an enum) gets its own section, from the anchor to the
  // next heading or anchor; any other page its start.
  const blocks = blocksOfPage(db, winner.page_id);
  const anchorAt = winner.anchor ? blocks.findIndex((block) => block.anchors.includes(winner.anchor)) : -1;
  const shown = anchorAt >= 0
    ? passage(winner.page_id, blocks.slice(0, sectionEnd(blocks, anchorAt)), anchorAt, ANCHOR_PASSAGE, name)
    : passage(winner.page_id, blocks, 0, PASSAGE, null);
  return { outcome, key: `passage:${winner.page_id}:${anchorAt}`, ...shown, also, readId: winner.page_id };
}

const wordsOf = (text) => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

// API names written in a question ("open a trade using CTrade::Sell"): words
// with "::", "_" or an inner capital, so plain words such as "Open" don't count.
const API_NAME = /::|_|[a-z][A-Z]/;

// A question's search words without stopwords, and its candidate pages: API
// names the question writes first, then phrase expansions, whose terms that
// are names add their main page in the listed order ("indicator buffer
// values" → CopyBuffer, SetIndexBuffer); other terms add search words. The
// question's own words are always kept.
function questionTerms(db, query) {
  const words = wordsOf(query);
  const kept = words.filter((word) => !STOPWORDS.has(word));
  const terms = new Set(kept.length ? kept : words);
  const pages = (query.match(/[A-Za-z_]\w*(?:::\w+)?/g) ?? []).filter((word) => API_NAME.test(word))
    .map((word) => mainPage(db, word)?.page_id).filter(Boolean);
  const lower = query.toLowerCase();
  for (const expansion of EXPANSIONS) {
    if (!expansion.phrases.some((phrase) => lower.includes(phrase))) continue;
    for (const term of expansion.terms) {
      const page = mainPage(db, term);
      if (page) pages.push(page.page_id);
      else for (const word of wordsOf(term)) terms.add(word);
    }
  }
  return { terms: [...terms], pages };
}

// Questions: expansion candidates first, then full-text search over all books
// with a modest boost for the Reference, merged per page; the top page shows
// its card or a passage around the matching words, the next two are listed.
function answerQuestion(db, query) {
  const { terms, pages } = questionTerms(db, query);
  if (!terms.length) return null;
  const match = terms.map((term) => `"${term}"`).join(" OR ");
  const rows = db.prepare(`select s.page_id, bm25(sections, 0, 10, 5, 1) as score, p.source
    from sections s join pages p on p.id = s.page_id where sections match ? order by score limit 200`).all(match);
  const best = new Map();
  for (const row of rows) {
    const score = row.score * (row.source === "mql5" ? 1.25 : 1);
    if (!best.has(row.page_id) || score < best.get(row.page_id)) best.set(row.page_id, score);
  }
  const searched = [...best].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const [first, ...rest] = [...new Set([...pages, ...searched])].slice(0, 3).map((id) => ({ id, title: pageTitle(db, id).title }));
  if (!first) return null;
  const card = db.prepare("select name, kind, full, brief from cards where page_id = ? and kind <> 'constant'").get(first.id);
  const outcome = `~ ${echo(query)} · no exact name; best match: ${first.title} · ${first.id}`;
  const others = rest.length ? `Other pages: ${rest.map((page) => `${page.title} (${page.id})`).join(", ")}` : null;
  if (card) {
    return {
      outcome, key: `card:${first.id}:${card.name}`, full: card.full, brief: card.brief, also: others,
      readId: first.id, readArgs: `id=${first.id}`, findName: card.name,
    };
  }
  const blocks = blocksOfPage(db, first.id);
  let start = -1;
  let focus = null;
  for (const term of terms) {
    start = focusStart(db, first.id, blocks, term);
    if (start >= 0) {
      focus = term;
      break;
    }
  }
  return { outcome, key: `passage:${first.id}:${start}`, ...passage(first.id, blocks, Math.max(start, 0), PASSAGE, focus), also: others, readId: first.id };
}

// Typo fallback: names within two edits, loaded only the first time it is needed.
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
    .filter((candidate) => candidate.distance <= 2).sort((a, b) => a.distance - b.distance).slice(0, 3).map((candidate) => candidate.name);
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
