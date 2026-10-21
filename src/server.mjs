// MCP server entry. The index check starts first, before the MCP library
// loads, so a tool call usually finds it done; initialize and tools/list are
// answered without waiting for it. Nothing here loads the HTML parser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openIndex } from "./data.mjs";

let pending = openIndex();

// Every call waits for the same check. A failed check is dropped once seen,
// so the next call checks again from scratch (setup or an update may have
// switched the index since).
async function useIndex() {
  pending ??= openIndex();
  const check = pending;
  const index = await check;
  if (index.error && pending === check) pending = null;
  return index;
}

const [{ McpServer }, { StdioServerTransport }, { z }, { findText }, { readPage }] = await Promise.all([
  import("@modelcontextprotocol/sdk/server/mcp.js"),
  import("@modelcontextprotocol/sdk/server/stdio.js"),
  import("zod"),
  import("./find.mjs"),
  import("./search.mjs"),
]);

const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));

const INSTRUCTIONS ="Offline MQL5 documentation (MetaTrader 5 Reference and MQL5 books). Call mql5_find first, "
  + "with every name you need in one call. `=` is an exact name match, `~` a search result; either way, base each claim "
  + "on returned text that states it. When an answer is brief or cut, read the rest before relying on what it leaves "
  + "out. Reuse text already read while the index tag is unchanged. If the docs don't support a claim, say \"Not verified "
  + "in the installed MQL5 docs\" instead of guessing, and check mql5.com when the docs lack something or freshness matters.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const text = (value) => ({ content: [{ type: "text", text: value }] });

const server = new McpServer({ name: "mql5-docs", version }, { instructions: INSTRUCTIONS });

server.registerTool("mql5_find", {
  description: "Look up MQL5 docs. Send every name you need in one call: up to 16 queries, each an API name "
    + "(OrderSend, ENUM_ORDER_TYPE_FILLING, CTrade::Buy), an exact page title or a question. Each answer starts with "
    + "`=` (exact name or title), `~` (search result, not a known API) or `none`. A match proves only the name: base "
    + "each claim on returned text that states it. A brief, cut or `more:` answer names the exact call for the rest.",
  inputSchema: { queries: z.union([z.array(z.string()), z.string()]).describe("Names, page titles or questions") },
  annotations: READ_ONLY,
}, async ({ queries }) => {
  const index = await useIndex();
  return text(index.error ?? findText(index.db, queries, index));
});

server.registerTool("mql5_read", {
  description: "Read an MQL5 docs page by its id from mql5_find, about 4,000 characters per page. focus starts at a "
    + "name, heading or phrase on the page (a constant's row; focus=Note). When more follows, the reply ends with the "
    + "exact next call; pages count from the focus. Base each claim on returned text, and read on before relying on "
    + "what a page leaves out.",
  inputSchema: {
    id: z.string().describe("Page id, such as mql5/ordersend"),
    focus: z.string().optional().describe("Name, heading or phrase to start at"),
    page: z.number().int().optional().describe("Page number, default 1"),
  },
  annotations: READ_ONLY,
}, async ({ id, focus, page }) => {
  const index = await useIndex();
  return text(index.error ?? readPage(index.db, { id, focus, page }, index));
});

await server.connect(new StdioServerTransport());
