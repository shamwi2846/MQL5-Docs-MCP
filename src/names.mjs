// Ranks the pages a name belongs to, in the design's order: a page titled
// exactly with the name; never a summary page; the Reference before the
// books; a global API before a class member; the page whose table names the
// constant's enum (its definition) before pages that only repeat it, such as
// the Python API pages; keyword-index entries before other names; then the
// order names were found in.
import { SUMMARY_PAGES } from "./config.mjs";

const CANDIDATES = `select n.page_id, n.anchor, n.kind, n.member, n.seq, p.source, p.title = n.name as titled,
    exists (select 1 from cards c where c.page_id = n.page_id and c.name = n.name and c.enum is not null) as owned
  from names n join pages p on p.id = n.page_id where n.name = ?`;

function compare(a, b) {
  return (b.titled - a.titled)
    || (SUMMARY_PAGES.has(a.page_id) - SUMMARY_PAGES.has(b.page_id))
    || ((b.source === "mql5") - (a.source === "mql5"))
    || (a.member - b.member)
    || (b.owned - a.owned)
    || ((b.kind === "keyword") - (a.kind === "keyword"))
    || (a.seq - b.seq);
}

// Distinct pages for a name, best first. A page's place comes from its best
// row; its anchor is the most precise one any of its rows gives: an anchor
// named like the name itself, then the first anchored row, so an unanchored
// keyword row never hides where an enum is defined.
export function rankPages(db, name) {
  const rows = db.prepare(CANDIDATES).all(name).sort(compare);
  const pages = new Map();
  for (const row of rows) if (!pages.has(row.page_id)) pages.set(row.page_id, { ...row });
  for (const page of pages.values()) {
    const anchored = rows.filter((row) => row.page_id === page.page_id && row.anchor).sort((a, b) => a.seq - b.seq);
    page.anchor = (anchored.find((row) => row.anchor === name.toLowerCase()) ?? anchored[0])?.anchor ?? null;
  }
  return [...pages.values()];
}

export function mainPage(db, name) {
  return rankPages(db, name)[0] ?? null;
}
