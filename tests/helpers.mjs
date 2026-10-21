// Completeness check shared by the fixture and real-docs tests: every piece
// of documentation text a card is meant to carry must appear in it. Only code
// examples are cut on purpose; declarations (signatures, the class
// declaration and include line, the struct definition) must stay. See also
// becomes one line of names, and table rows may be reformatted, so each
// non-empty cell is checked on its own.
import { SECTION_HEADINGS } from "../src/cards.mjs";

const CLASS_LAYOUT = /^(declaration|title|class methods by groups?)$/i;

function requiredCode(card, blocks) {
  const code = blocks.filter((block) => block.kind === "code");
  if (card.kind === "class") return code.filter((block) => block.text.startsWith("#include") || /^class\s/m.test(block.text));
  if (card.kind === "struct") return code.slice(0, 1);
  const end = blocks.findIndex((block) => block.kind === "heading" && SECTION_HEADINGS.has(block.text));
  return blocks.slice(0, end < 0 ? blocks.length : end).filter((block) => block.kind === "code");
}

// A cell must appear as whole words: "Init" is not found inside "Initializes".
function containsWhole(text, part) {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}(?=[^\\w]|$)`).test(text);
}

export function missingFromCard(card, blocks) {
  const missing = [];
  const required = new Set(requiredCode(card, blocks));
  for (const block of blocks) {
    if (block.heading === "See also") continue;
    if (block.kind === "code") {
      if (required.has(block) && !card.full.includes(block.text)) missing.push(block.text);
      continue;
    }
    if (card.kind === "struct" && /^Fields? description$/i.test(block.text)) continue;
    // A class page's hierarchy row is layout, not prose; its method rows are checked cell by cell.
    if (card.kind === "class" && CLASS_LAYOUT.test(block.heading) && (block.kind !== "row" || !block.header)) continue;
    const cells = block.kind === "row" ? block.text.split(" | ") : [block.text];
    for (const cell of cells.map((text) => text.trim()).filter(Boolean)) {
      if (!containsWhole(card.full, cell)) missing.push(`${block.text} [${cell}]`);
    }
  }
  return missing;
}
