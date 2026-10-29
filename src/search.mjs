// Reading pages from the index as plain text. The same rendering is used for
// mql5_read pages and for the passages mql5_find shows.
import { escapeRegExp, rowIdentifier } from "./cards.mjs";

export const PAGE_SIZE = 4000;
const ID_PATTERN = /^(mql5|book|nn)\/[a-z0-9_.-]+$/;
const CONTINUES = " (continues)";

export function blocksOfPage(db, id) {
  return db.prepare(`select kind, text, heading, table_no as tableNo, header, anchors
    from blocks where page_id = ? order by pos`).all(id)
    .map((block) => ({ ...block, anchors: block.anchors ? block.anchors.split(" ") : [] }));
}

const wholeWord = (text, flags) => new RegExp(`(^|[^\\w])${escapeRegExp(text)}(?=[^\\w]|$)`, flags);

// Where a focus starts, in this order: the table row that defines the focus
// in its identifier column (a constant's own row, even deep in a long table;
// other cells, like a method named Description, don't count), a name whose
// keyword-index anchor is on this page (ENUM_ORDER_TYPE_FILLING is mentioned
// on Order Properties before it is defined), an exact heading (focus=Note
// lands on the Note heading), then the first block containing the focus as
// whole words, matching case first.
export function focusStart(db, id, blocks, focus) {
  const row = blocks.findIndex((block) => rowIdentifier(block) === focus);
  if (row >= 0) return row;
  const anchors = db.prepare(`select anchor from names where page_id = ? and anchor is not null
    and (name = ? or lower = ?) order by name = ? desc, seq`).all(id, focus, focus.toLowerCase(), focus).map((row) => row.anchor);
  for (const anchor of anchors) {
    const at = blocks.findIndex((block) => block.anchors.includes(anchor));
    if (at >= 0) return at;
  }
  const heading = blocks.findIndex((block) => block.kind === "heading" && block.text.toLowerCase() === focus.toLowerCase());
  if (heading >= 0) return heading;
  for (const flags of ["", "i"]) {
    const pattern = wholeWord(focus, flags);
    const at = blocks.findIndex((block) => pattern.test(block.text) || (block.header && pattern.test(block.header)));
    if (at >= 0) return at;
  }
  return -1;
}

// A block longer than a page is split: code at line breaks, prose at
// sentences, and a sentence longer than a page at words.
function splitLong(text, kind, size) {
  if (text.length <= size) return [text];
  const units = kind === "code" ? text.split("\n") : text.split(/(?<=[.!?])\s+/).flatMap((sentence) =>
    (sentence.length <= size ? [sentence] : sentence.split(" ")));
  const joiner = kind === "code" ? "\n" : " ";
  const parts = [];
  let current = "";
  for (const unit of units) {
    const next = current ? `${current}${joiner}${unit}` : unit;
    if (next.length > size - CONTINUES.length && current) {
      parts.push(current);
      current = unit;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts.map((part, i) => (i < parts.length - 1 ? part + CONTINUES : part));
}

// Splits blocks (from start) into pages of about `size` characters at block
// boundaries. A row carries its table's header line when it opens its table
// or a page; the heading above the start is printed when the start is not a
// heading itself; a heading never ends a page, it moves to the next one with
// the block it introduces (long blocks leave room for it).
export function paginate(blocks, start, size = PAGE_SIZE) {
  const room = Math.min(200, Math.floor(size / 4));
  const pieces = [];
  const first = blocks[start];
  if (first && first.kind !== "heading" && first.heading) pieces.push({ text: `${first.heading}:`, isHeading: true });
  let lastTable = null;
  for (const block of blocks.slice(start)) {
    const isRow = block.kind === "row";
    const opensTable = isRow && block.tableNo !== lastTable;
    lastTable = isRow ? block.tableNo : null;
    if (block.kind === "heading") {
      pieces.push({ text: `${block.text}:`, isHeading: true });
      continue;
    }
    splitLong(block.text, block.kind, size - room).forEach((part, i) => {
      pieces.push({ text: part, header: isRow ? block.header : null, opensTable: opensTable && i === 0 });
    });
  }
  const pages = [];
  let lines = [];
  const onlyHeadings = () => lines.every((line) => line.isHeading);
  const render = (piece) => (piece.header && (piece.opensTable || onlyHeadings()) ? `${piece.header}\n${piece.text}` : piece.text);
  for (const piece of pieces) {
    const used = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
    if (!onlyHeadings() && used + render(piece).length + 1 > size) {
      const carried = [];
      while (lines.at(-1)?.isHeading) carried.unshift(lines.pop());
      pages.push(lines.map((line) => line.text).join("\n"));
      lines = carried;
    }
    lines.push({ ...piece, text: render(piece) });
  }
  if (lines.length) pages.push(lines.map((line) => line.text).join("\n"));
  return pages.length ? pages : [""];
}

export const quoteArgument = (value) => (/[\s=]/.test(value) ? JSON.stringify(value) : value);

// mql5_read: one page of a documentation page, with a header line and, when
// there is more, the complete arguments for the next call.
export function readPage(db, { id, focus, page = 1 }, { tag }) {
  if (!ID_PATTERN.test(id ?? "")) return `"${id}" is not a page id. Use mql5_find to get one.`;
  const info = db.prepare("select title, breadcrumb from pages where id = ?").get(id);
  if (!info) return `${id} is not in the current docs (index ${tag}); use mql5_find again.`;
  const blocks = blocksOfPage(db, id);
  let start = 0;
  let notice = "";
  if (focus) {
    const at = focusStart(db, id, blocks, focus);
    if (at < 0) notice = `Focus "${focus}" not found on this page; showing its start.`;
    else start = at;
  }
  const pages = paginate(blocks, start);
  if (!Number.isInteger(page) || page < 1 || page > pages.length) {
    const from = focus ? ` from focus "${focus}"` : "";
    return `${id} has ${pages.length} page${pages.length === 1 ? "" : "s"}${from}; page ${page} does not exist.`;
  }
  const header = `${info.title} · ${info.breadcrumb} · ${id} · page ${page} of ${pages.length} · index ${tag}`;
  const focusArgument = focus && !notice ? ` focus=${quoteArgument(focus)}` : "";
  const next = page < pages.length ? `next: mql5_read id=${id}${focusArgument} page=${page + 1}` : null;
  return [header, notice, pages[page - 1], next].filter(Boolean).join("\n");
}
