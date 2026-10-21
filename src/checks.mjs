// Build checks on a new index. The baseline lists names that must resolve to
// their main page with the right kind; some also carry a constant value, an
// enum or phrases their card must contain. Returns one line per problem.
import { mainPage } from "./names.mjs";

function cardFor(db, name, pageId) {
  return db.prepare("select kind, value, enum, notes_key, full from cards where page_id = ? and name = ?").get(pageId, name)
    ?? db.prepare("select kind, value, enum, notes_key, full from cards where page_id = ? and kind <> 'constant'").get(pageId);
}

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
    const card = cardFor(db, entry.name, entry.page);
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
