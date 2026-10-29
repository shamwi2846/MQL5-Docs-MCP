// Build checks on a new index, each returning one line per problem.
import { cardOf, mainPage } from "./names.mjs";

// SQLite's and FTS5's own integrity checks, and every keyword-index anchor
// used as a target present on its page. Needs a writable connection: FTS5
// runs its check as a special insert.
export function checkIndex(db) {
  const problems = [];
  const integrity = db.prepare("pragma integrity_check").all().map((row) => Object.values(row)[0]);
  if (integrity.join() !== "ok") problems.push(`SQLite integrity: ${integrity.slice(0, 3).join("; ")}`);
  try {
    db.exec("insert into sections (sections) values ('integrity-check')");
  } catch (error) {
    problems.push(`full-text index: ${error.message}`);
  }
  const missing = db.prepare(`select name, page_id, anchor from names n where anchor is not null
    and not exists (select 1 from blocks b where b.page_id = n.page_id
      and instr(' ' || b.anchors || ' ', ' ' || n.anchor || ' ') > 0)`).all();
  for (const row of missing.slice(0, 10)) problems.push(`${row.name}: anchor #${row.anchor} is not on ${row.page_id}`);
  return problems;
}

// Names and cards the live index has and the new one lacks. A card counts
// per page: 104 pages each have a "Create" method card.
export function lostNames(liveDb, newDb) {
  const keys = (db, sql) => new Set(db.prepare(sql).all().map((row) => row.key));
  const lost = [];
  let total = 0;
  for (const sql of ["select distinct name as key from names",
    "select distinct name || ' (' || kind || ' card on ' || page_id || ')' as key from cards"]) {
    const live = keys(liveDb, sql);
    const fresh = keys(newDb, sql);
    total += live.size;
    for (const key of live) if (!fresh.has(key)) lost.push(key);
  }
  return { lost, total };
}

// The baseline lists names that must resolve to their main page with the
// right kind; some also carry a constant value, an enum or phrases the card
// find shows must contain.
export function checkBaseline(db, baseline) {
  const problems = [];
  for (const entry of baseline.names) {
    const main = mainPage(db, entry.name);
    if (!main) {
      problems.push(`${entry.name}: not found`);
      continue;
    }
    if (main.page_id !== entry.page) problems.push(`${entry.name}: main page ${main.page_id}, expected ${entry.page}`);
    if (!entry.kind && !entry.value && !("enum" in entry) && !entry.phrases) continue;
    const card = cardOf(db, entry.name, entry.page);
    if (!card) {
      if (entry.kind && entry.kind !== "none") problems.push(`${entry.name}: no card on ${entry.page}`);
      continue;
    }
    if (entry.kind && card.kind !== entry.kind) problems.push(`${entry.name}: kind ${card.kind}, expected ${entry.kind}`);
    if (entry.value && card.value !== entry.value) problems.push(`${entry.name}: value ${card.value}, expected ${entry.value}`);
    // "enum": null asserts the constant belongs to no enum.
    if ("enum" in entry && card.enum !== entry.enum) problems.push(`${entry.name}: enum ${card.enum}, expected ${entry.enum}`);
    const notes = card.notes_key ? db.prepare("select text from notes where key = ?").get(card.notes_key)?.text ?? "" : "";
    for (const phrase of entry.phrases ?? []) {
      if (!card.full.includes(phrase) && !notes.includes(phrase)) problems.push(`${entry.name}: card lacks "${phrase}"`);
    }
  }
  return problems;
}
