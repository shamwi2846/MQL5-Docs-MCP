// Builds the ready-to-print answer cards of function, method, class and
// struct pages from their stored blocks. Cards copy the documentation text;
// they only leave out code examples, each replaced by a marker that says how
// to read it.

export const SECTION_HEADINGS = new Set(["Parameters", "Return Value", "Note", "See also"]);
const BRIEF_MAX = 380;
const SIGNATURE_MAX = 240;
// Class pages lay out their declaration, include line and method tables
// under these headings; everything else on the page is prose for the card.
const CLASS_LAYOUT = /^(declaration|title|class methods by groups?)$/i;
// "request", "array[]", "symbol=NULL", "comment=\"\"", "..."
const PARAMETER_NAME = /^(\.\.\.|[\w[\]&*.]+(=\S*)?)$/;

export function firstSentence(text) {
  return (/^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text).trim();
}

function introEnd(blocks) {
  const end = blocks.findIndex((block) => block.kind === "heading" && SECTION_HEADINGS.has(block.text));
  return end < 0 ? blocks.length : end;
}

function declares(blocks, pattern) {
  return blocks.some((block) => block.kind === "code" && pattern.test(block.text));
}

function codeMarker(codes, id, heading) {
  const size = codes.reduce((sum, code) => sum + code.text.length, 0).toLocaleString("en-US");
  const what = codes.length === 1 ? "code example" : `${codes.length} code examples`;
  return `[${what} cut, ${size} characters: mql5_read id=${id} focus=${heading}]`;
}

// Consecutive blocks under one heading, in page order.
function groupByHeading(blocks) {
  const groups = [];
  for (const block of blocks) {
    if (block.kind === "heading") groups.push({ heading: block.text, blocks: [] });
    else if (groups.length) groups.at(-1).blocks.push(block);
    else groups.push({ heading: "", blocks: [block] });
  }
  return groups;
}

// A parameter name paragraph is followed by its description ("[in] ...").
function parameterLines(blocks) {
  const lines = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const next = blocks[i + 1];
    const isName = block.kind === "paragraph" && block.text.length <= 60 && PARAMETER_NAME.test(block.text);
    if (isName && next?.kind === "paragraph" && next.text.startsWith("[")) {
      lines.push(`${block.text} ${next.text}`);
      i++;
    } else if (block.kind !== "code") {
      lines.push(block.text);
    }
  }
  return lines;
}

function seeAlsoLine(blocks, resolveName) {
  const names = blocks.filter((block) => block.kind === "paragraph")
    .flatMap((block) => block.text.split(",")).map((name) => name.trim()).filter(Boolean);
  if (!names.length) return null;
  return "See also: " + names.map((name) => {
    const id = resolveName(name);
    return id ? `${name} (${id})` : name;
  }).join(", ");
}

// Everything after the declarations except See also and code examples:
// Parameters, Return Value, Note and any further headings, which on many
// pages are warnings ("The symbol should be selected by Name method.").
function bodyLines(blocks, id, resolveName) {
  const lines = [];
  let seeAlso = null;
  for (const group of groupByHeading(blocks)) {
    if (group.heading === "See also") {
      seeAlso = seeAlsoLine(group.blocks, resolveName);
      continue;
    }
    if (group.heading) lines.push(`${group.heading}:`);
    lines.push(...(group.heading === "Parameters" ? parameterLines(group.blocks) : group.blocks
      .filter((block) => block.kind !== "code").map((block) => block.text)));
    const codes = group.blocks.filter((block) => block.kind === "code");
    if (codes.length) lines.push(codeMarker(codes, id, group.heading || "Example"));
  }
  if (seeAlso) lines.push(seeAlso);
  return lines;
}

function introLines(blocks) {
  return blocks.map((block) => (block.kind === "heading" ? `${block.text}:` : block.text));
}

// A declaration on one line without its comments, so it fits a brief card:
// "bool Buy(double volume, const string symbol=NULL, ...)". A few pages print
// "void OnTradeTransaction()" with the parameters on the following lines; the
// parameters are moved back inside the parentheses.
export function compactSignature(code) {
  return code.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join(" ")
    .replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s([),;])/g, "$1").trim()
    .replace(/\(\)\s+([^()]+)\)(;?)$/, "($1)$2");
}

// One code block can hold several declarations (ReplaceToZero prints eight).
// A new declaration starts at a line that opens parentheses once the previous
// ones are closed; other lines (parameters, comments) stay with the one above.
export function splitDeclarations(code) {
  const declarations = [];
  let current = [];
  let depth = 0;
  for (const line of code.split("\n")) {
    if (!current.length && !line.trim()) continue;
    const bare = line.replace(/\/\/.*$/, "");
    if (bare.includes("(") && depth <= 0 && current.length) {
      declarations.push(current.join("\n").trimEnd());
      current = [];
      depth = 0;
    }
    current.push(line);
    for (const char of bare) depth += char === "(" ? 1 : char === ")" ? -1 : 0;
  }
  if (current.length) declarations.push(current.join("\n").trimEnd());
  return declarations;
}

// Cuts text at a word boundary and marks the cut.
function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}…`;
}

// A brief card keeps the first signature when it is short enough and
// shortens the sentences to fit; otherwise the signature becomes a read
// pointer, which is never cut.
function briefOf(page, signature, overloads, sentences) {
  const text = sentences.filter(Boolean).join("\n");
  const compact = signature && compactSignature(signature);
  const shown = compact && (overloads > 1 ? `${compact} (+${overloads - 1} overloads)` : compact);
  const head = shown && shown.length <= SIGNATURE_MAX ? shown : null;
  const pointer = shown && !head ? `(signature: mql5_read id=${page.id})` : null;
  const room = BRIEF_MAX - (head ?? pointer ?? "").length - 1;
  return [head, text && shorten(text, room), pointer].filter(Boolean).join("\n");
}

function functionCard(page, blocks, resolveName) {
  const end = introEnd(blocks);
  const intro = blocks.slice(0, end);
  const signatures = intro.filter((block) => block.kind === "code")
    .flatMap((block) => splitDeclarations(block.text)).filter((declaration) => declaration.includes("("));
  const returnValue = blocks.find((block) => block.kind === "paragraph" && block.heading === "Return Value");
  const description = intro.find((block) => block.kind === "paragraph");
  return {
    name: page.title,
    kind: page.member ? "method" : "function",
    full: [...introLines(intro), ...bodyLines(blocks.slice(end), page.id, resolveName)].join("\n"),
    brief: briefOf(page, signatures[0], signatures.length, [
      description && firstSentence(description.text),
      returnValue && `Returns: ${firstSentence(returnValue.text)}`,
    ]),
  };
}

// A row whose cells after the first are empty is a group name, as in the
// method tables: "Setting parameters |" as the header row, then rows such as
// "Operations with orders |".
function groupName(rowText) {
  const [first, ...rest] = rowText.split(" | ");
  return rest.every((cell) => !cell.trim()) ? first.trim() : null;
}

// Class pages: the include line and declaration, the page's prose (its
// description and any Note, such as which positions CExpert manages), then one
// line per method from the method tables, grouped as on the page.
function classCard(page, blocks, resolveName) {
  const code = blocks.filter((block) => block.kind === "code");
  const include = code.find((block) => block.text.startsWith("#include"));
  const declaration = code.find((block) => /^class\s/m.test(block.text));
  const description = blocks.find((block) => block.kind === "paragraph");
  const lines = [include?.text, declaration?.text].filter(Boolean);
  lines.push(...bodyLines(blocks.filter((block) => !CLASS_LAYOUT.test(block.heading)), page.id, resolveName));
  let table = null;
  const methodRows = blocks.filter((block) => block.kind === "row" && block.header && CLASS_LAYOUT.test(block.heading));
  for (const row of methodRows) {
    if (row.tableNo !== table) {
      table = row.tableNo;
      const headerGroup = groupName(row.header);
      if (headerGroup) lines.push(`${headerGroup}:`);
    }
    const group = groupName(row.text);
    if (group) {
      lines.push(`${group}:`);
      continue;
    }
    // Method cells may carry qualifiers, as in "virtual InitSignal".
    const [method, ...rest] = row.text.split(" | ");
    if (/^((virtual|static)\s+)*[A-Za-z_]\w*$/.test(method)) lines.push(`- ${method}: ${rest.join(" | ")}`);
  }
  return {
    name: page.title,
    kind: "class",
    full: lines.join("\n"),
    brief: briefOf(page, declaration?.text, 1, [description && firstSentence(description.text)]),
  };
}

// Struct pages: the definition as printed, each field with its description,
// then the rest of the page's prose. Their titles are descriptive ("Trade
// Request Structure"), so the card takes the struct's name from the definition.
function structCard(page, blocks, resolveName, name, definition) {
  const fields = blocks.filter((block) => block.kind === "row" && block.header?.startsWith("Field"));
  const rest = blocks.filter((block) => block !== definition && !fields.includes(block) && !/^Fields? description$/i.test(block.text));
  const description = blocks.find((block) => block.kind === "paragraph");
  const lines = [definition.text];
  if (fields.length) {
    lines.push("Fields:");
    for (const field of fields) {
      const [name, ...text] = field.text.split(" | ");
      lines.push(`- ${name}: ${text.join(" | ")}`);
    }
  }
  lines.push(...bodyLines(rest, page.id, resolveName));
  return {
    name,
    kind: "struct",
    full: lines.join("\n"),
    brief: briefOf(page, `struct ${name}`, 1, [description && firstSentence(description.text)]),
  };
}

const IDENTIFIER_HEADERS = new Set(["id", "identifier", "constant", "flag"]);
const VALUE_HEADERS = new Set(["value", "code"]);
const CONSTANT = /^[A-Z][A-Z0-9_]+$/;
const ENUM_IN_HEADER = /\bENUM_[A-Z0-9_]+\b/;
const MAX_SIBLINGS = 10;
const MAX_VALUE = 24;

// The authored identifier column of a table: headed "ID", "Identifier",
// "Constant" or "Flag", or a header naming an enum ("The value in
// ENUM_ORDER_TYPE_FILLING"). Other columns never define constants, even when
// their cells look like constants (Direct3D names in a comparison column).
function identifierColumn(headerCells) {
  const exact = headerCells.findIndex((cell) => IDENTIFIER_HEADERS.has(cell.toLowerCase()));
  return exact >= 0 ? exact : headerCells.findIndex((cell) => ENUM_IN_HEADER.test(cell));
}

// The identifier a table row defines, or null when its table has no
// authored identifier column.
export function rowIdentifier(block) {
  if (block.kind !== "row" || !block.header) return null;
  const column = identifierColumn(block.header.split(" | ").map((cell) => cell.trim()));
  return column < 0 ? null : block.text.split(" | ")[column]?.trim() ?? null;
}

// The section a table sits in starts at the nearest heading or anchored
// block above it and ends at the next one below. Anchors on table rows mark
// the rows (each error code, for example), not sections, so they don't count.
const opensSection = (block) => block.kind === "heading" || (block.kind !== "row" && block.anchors?.length > 0);

// Returns the start index, or -1 when the table opens the page, and whether
// another table comes before it in the section.
function sectionStart(blocks, firstRow) {
  let otherTable = false;
  for (let i = firstRow - 1; i >= 0; i--) {
    const block = blocks[i];
    if (opensSection(block)) return { start: i, otherTable };
    if (block.kind === "row" && block.tableNo !== blocks[firstRow].tableNo) otherTable = true;
  }
  return { start: -1, otherTable };
}

export function sectionEnd(blocks, start) {
  for (let i = start + 1; i < blocks.length; i++) {
    if (opensSection(blocks[i])) return i;
  }
  return blocks.length;
}

// Cards for the constants of a page, one per identifier row. Each keeps its
// value (only from a "Value" or "Code" column, never from row order), the
// row's other cells as its description, its enum when the page names it (the
// column header, or the keyword-index anchor that opens the table's section),
// up to ten siblings, and the key of its section's notes: the prose around
// the table, which can change a row's meaning (ORDER_FILLING_RETURN's row
// forbids Market Execution; the notes allow it for pending orders).
export function constantCards(page, blocks, enumOfAnchor) {
  const cards = [];
  const tables = new Map();
  blocks.forEach((block, index) => {
    if (block.kind !== "row" || !block.header) return;
    if (!tables.has(block.tableNo)) tables.set(block.tableNo, []);
    tables.get(block.tableNo).push(index);
  });
  for (const rows of tables.values()) {
    const headerCells = blocks[rows[0]].header.split(" | ").map((cell) => cell.trim());
    const idColumn = identifierColumn(headerCells);
    if (idColumn < 0) continue;
    const valueColumn = headerCells.findIndex((cell) => VALUE_HEADERS.has(cell.toLowerCase()));
    const entries = rows.map((index) => ({ index, cells: blocks[index].text.split(" | ").map((cell) => cell.trim()) }))
      .filter(({ cells }) => CONSTANT.test(cells[idColumn] ?? ""));
    if (!entries.length) continue;

    const { start, otherTable } = sectionStart(blocks, rows[0]);
    const end = sectionEnd(blocks, start);
    // The enum comes from the column header, from the keyword-index anchor that
    // opens the table's section, or, for a table that opens a page wholly about
    // one enum (Chart Timeframes), from the enum the keyword index points at
    // the page itself (enumOfAnchor(null) answers only when there is one).
    const headerEnum = ENUM_IN_HEADER.exec(headerCells[idColumn])?.[0];
    const sectionAnchors = start >= 0 ? blocks[start].anchors ?? [] : [];
    let anchorEnum;
    if (!otherTable && sectionAnchors.length) anchorEnum = sectionAnchors.map((anchor) => enumOfAnchor(anchor)).find(Boolean);
    else if (!otherTable && start < 0) anchorEnum = enumOfAnchor(null);
    // Section notes: the section's paragraphs, without a bare "ENUM_X" label.
    const from = Math.max(start, 0);
    const notes = blocks.slice(from, end)
      .filter((block) => block.kind === "paragraph" && !/^ENUM_[A-Z0-9_]+$/.test(block.text.trim()))
      .map((block) => block.text);
    const notesKey = notes.length ? `${page.id}#${from}` : null;
    const names = entries.map(({ cells }) => cells[idColumn]);

    for (const { index, cells } of entries) {
      const name = cells[idColumn];
      const value = valueColumn >= 0 && cells[valueColumn] && cells[valueColumn].length <= MAX_VALUE ? cells[valueColumn] : null;
      // A "Description" cell reads as is; other cells keep their column's label
      // ("Fill policy: Return", "Match in D3D11_PRIMITIVE_TOPOLOGY: ...").
      const description = cells.map((cell, column) => {
        if (column === idColumn || column === valueColumn || !cell) return null;
        const label = headerCells[column];
        return !label || /^description$/i.test(label) ? cell : `${label}: ${cell}`;
      }).filter(Boolean).join(" — ");
      const siblings = names.filter((other) => other !== name);
      const lines = [description];
      if (siblings.length) {
        const more = siblings.length > MAX_SIBLINGS ? ` (+${siblings.length - MAX_SIBLINGS} more: mql5_read id=${page.id} focus=${names[0]})` : "";
        lines.push(`Other values: ${siblings.slice(0, MAX_SIBLINGS).join(", ")}${more}`);
      }
      lines.push(`More: mql5_read id=${page.id} focus=${name}`);
      cards.push({
        name,
        kind: "constant",
        anchor: blocks[index].anchors?.[0] ?? blocks[start]?.anchors?.[0] ?? null,
        value,
        enum: headerEnum ?? anchorEnum ?? null,
        notesKey,
        notes: notes.join("\n"),
        full: lines.filter(Boolean).join("\n"),
        brief: description ? firstSentence(description) : `More: mql5_read id=${page.id} focus=${name}`,
      });
    }
  }
  return cards;
}

// The card of a whole page, or null for pages that are not a function,
// method, class or struct (find shows their best passage instead). A struct
// page is one whose first code block is the struct's definition.
export function pageCard(page, blocks, resolveName) {
  const firstCode = blocks.find((block) => block.kind === "code");
  const struct = firstCode && /^struct\s+([A-Za-z_]\w*)/.exec(firstCode.text);
  if (struct) return structCard(page, blocks, resolveName, struct[1], firstCode);
  if (!/^[A-Za-z_]\w*$/.test(page.title)) return null;
  const intro = blocks.slice(0, introEnd(blocks));
  if (declares(blocks, new RegExp(`^class\\s+${page.title}\\b`, "m"))) return classCard(page, blocks, resolveName);
  const hasSections = blocks.some((block) => block.kind === "heading" && (block.text === "Parameters" || block.text === "Return Value"));
  if (hasSections && declares(intro, new RegExp(`(^|[\\s:*&])${page.title}\\s*\\(`, "m"))) {
    return functionCard(page, blocks, resolveName);
  }
  return null;
}
