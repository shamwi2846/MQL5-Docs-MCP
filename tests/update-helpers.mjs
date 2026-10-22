// Shared by the docs:update and command tests: a data folder, an installed
// index, stub downloads and the stand-in for hh.exe.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, VERSION } from "../src/data.mjs";
import { buildIndex } from "../src/indexer.mjs";

export const unpackOptions = { command: process.execPath, prefix: [join(import.meta.dirname, "fake-hh.mjs")], timeout: 5000 };
export const baseline = { names: [
  { name: "OrderSend", page: "mql5/ordersend", kind: "function" },
  { name: "ORDER_FILLING_RETURN", page: "mql5/orderproperties", kind: "constant", enum: "ENUM_ORDER_TYPE_FILLING",
    phrases: ["Not allowed in Market mode", "regardless of the mode"] },
] };

// The fixture pages as an unpacked book must be: they point to two missing
// pages on purpose (the indexer skips such targets), which the unpack check
// rejects, so books are made from a completed copy. Returns its folder.
export function makeBook() {
  const book = mkdtempSync(join(tmpdir(), "mql5-docs-book-"));
  cpSync(join(import.meta.dirname, "fixtures", "mql5"), book, { recursive: true });
  writeFileSync(join(book, "index.htm"), "<html><head><title>MQL5 Reference</title></head><body></body></html>");
  const keywords = join(book, "mql5.hhk");
  writeFileSync(keywords, readFileSync(keywords, "latin1").replace(/^.*nowhere\.htm.*$/m, ""), "latin1");
  return book;
}

// Builds an index from `sources` into the data folder and points current.json at it.
export function installIndex(dir, name, sources, extra = {}) {
  buildIndex(join(dir, name), sources);
  const sha256 = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  const current = { index: name, sha256, schema_version: SCHEMA_VERSION, chm: {}, downloaded: "2026-10-01", builder_version: VERSION, ...extra };
  writeFileSync(join(dir, "current.json"), JSON.stringify(current));
  return current;
}

// A live index that also holds extra function pages (titles given) which new
// downloads of `book` lack: the "book" source is `book` plus those pages.
export function installWithExtras(dir, book, titles) {
  const extra = mkdtempSync(join(tmpdir(), "mql5-docs-extra-"));
  try {
    cpSync(book, extra, { recursive: true });
    titles.forEach((title, i) => writeFileSync(join(extra, `extra${i}.htm`), `<html><head><title>${title}</title></head><body><div id="help">
<p class="p_Function"><span>Sample ${title} number ${i}.</span></p>
<div><table><tr><td><p class="p_CodeExample"><span>bool ${title}(int value${i});</span></p></td></tr></table></div>
<p class="p_BoldTitles"><span>Parameters</span></p><p class="p_FunctionParameter"><span>value${i}</span></p>
<p class="p_ParameterDesrciption"><span>[in] A value.</span></p></div></body></html>`));
    return installIndex(dir, "index-a.sqlite", [{ source: "mql5", dir: book }, { source: "book", dir: extra }]);
  } finally {
    rmSync(extra, { recursive: true, force: true });
  }
}

// Serves each CHM URL as a JSON plan for the stand-in hh.exe (by file name).
export function stubFetch(book, plans = {}) {
  return async (url) => {
    const name = new URL(url).pathname.split("/").at(-1);
    const body = Buffer.from(JSON.stringify(plans[name] ?? { copy: book }));
    return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
  };
}

export async function withData(check) {
  const dir = mkdtempSync(join(tmpdir(), "mql5 docs update "));
  try {
    await check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const files = (dir) => readdirSync(dir).sort();
