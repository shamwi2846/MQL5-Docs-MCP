# MQL5 Docs MCP v2 — design

Status: agreed design, 2026-10-21. The measured facts behind it, its review history and the agreed and declined decisions are in DECISIONS.md.

A local, read-only MCP server that gives Claude Code and Codex fast, exact answers from the official MQL5 documentation: the MQL5 Reference, the MQL5 book and the neural-networks book. It replaces MQL5-CHM-MCP 1.3.18 completely; there is no way back to the old version.

## 1. Why a v2

Measured on 2026-10-21 (details in DECISIONS.md, section 1):

- **Claude Code never sees the documentation text.** 1.3.18 puts the passage only in the plain-text part of each reply, and the structured part leaves it out. Claude Code shows the model only the structured part. Every one of the 45 results in past Claude Code sessions was metadata without a single line of documentation. Codex gets the text.
- **Too many calls per answer.** Codex logs since 2026-10-14 show 107 reads, 33 lookups, 29 status calls, 5 searches and 0 image reads. The rules start every task with a status call, and a lookup never answers anything by itself.
- **Wasted tokens.** A 4-name lookup returned about 4,600 characters. About a quarter of that was the same 64-character revision hashes repeated for every result.
- **Too much code.** About 7,500 lines of JavaScript plus 15,700 lines of PowerShell for install, staged updates, recovery and packaging, tested under two PowerShell versions. CI took 25 to 45 minutes.
- **Large install.** About 205 MB: a bundled Node (88 MB), a 78 MB index, the CHM files and a bundled 7-Zip.

## 2. Goals and non-goals

Goals:

1. Works the same in **Claude Code and Codex**.
2. Most API questions answered in **one call**: an exact name returns a ready-made answer card, and a question returns the best card or passage.
3. Every reply contains the documentation text itself.
4. As simple as possible: about 2,000 lines of JavaScript (a target, not a rule), no PowerShell, three dependencies, CI in a few minutes.
5. Few tokens without losing facts: small tool definitions (section 4's size limits), cards that leave out code examples but keep every warning, and fewer calls per answer.
6. A docs update can never leave a broken index: the current one stays until the new one passes its checks.
7. Proven before it replaces 1.3.18: no question 1.3.18 answers may get worse, with fewer calls and no more characters overall.

Non-goals: images (the one 1.3.x benchmark case that checks an image is replaced by a text check; this capability is given up on purpose); other languages of the docs; online search; MQL4; any write or trading action; macOS or Linux; keeping 1.3.18 as a fallback; working offline after the index is lost (a repair, or a v2 upgrade that changes the index format, downloads the docs again).

## 3. Lessons from 1.3.x

Kept, because they worked:

- Exact versus near match is always stated, so a near match is never taken for the API.
- Constant names find their page (ENUM_ORDER_TYPE_FILLING → Order Properties), and exact page titles work as names.
- Up to 16 names in one call (real batches had 11 to 13).
- Phrase expansions for common questions and a typo fallback.
- `tools/list` answered at once, before anything slow (Codex takes its tool list at the start of a turn).
- Evidence rules in the tool descriptions and server instructions; tools marked read-only.
- Focus matching on whole words, and a clear notice when a focus is not found.
- Reusing a passage already read while the docs version is unchanged.
- The skill's rules: say "Not verified in the installed MQL5 docs" when the docs don't support a claim, check the official mql5.com page when the docs lack something or freshness matters, and never substitute remembered facts.
- The skill's health check telling apart "the server answers" from "its tools are loaded in this chat", and Claude Code's disabled or shadowed entries.
- Downloads only from fixed official URLs, with limits, and nothing activated before it is checked.
- A benchmark of hand-checked cases (the 32 cases in 1.3.x).

Dropped, because they hurt:

| Dropped | What it cost | Replaced by |
|---|---|---|
| Passage only in the plain-text part, beside structured output | Claude Code never saw the docs | Plain text only, no structured output |
| Status call at the start of every task | An extra call every time | Version shown in every reply |
| Lookups that return only metadata | A read for every answer | Answer cards and best passages |
| 64-character hashes and 24-character hex ids in every result | About a quarter of the characters | Readable page ids, a 7-character index tag once per reply |
| Section ids by number, and signed cursors that expire on restart | Ids that change meaning between docs versions; failed continuations | Page ids plus `focus`; page numbers |
| Hard errors for harmless over-limit input | Retries and wasted calls | Extra items skipped and named in the reply |
| A `source` filter on search | 5 searches ever, all with the default | Questions search all books, with a ranking boost for the Reference, results labelled |
| Image tool | Code and tests for 0 recorded calls | Nothing |
| Bundled Node, bundled 7-Zip, esbuild bundle, generated license notices, packaging checksums | 88 MB plus build machinery | The installed Node 24, Windows `hh.exe`, plain `node_modules` |
| Staging, recovery and rollback in about 15,700 lines of PowerShell, tested on two PowerShell versions | Most of the code and the long CI | One Node update command with a lock and a pointer file |
| Commit pins between the MCP and skill repositories | Two-repository releases for every change | The skill states a minimum MCP version |

## 4. Tools

Two tools. Both return **plain text only** (no structured output and no output schema), so both clients show the same thing. Both are marked read-only and closed-world. Each tool's description carries its own evidence and continuation rules, so they reach the agent even without the skill.

**Size limits for what clients carry in every session**, enforced by a test: the whole `tools/list` reply (both tools' names, descriptions and input schemas) at most 3,000 characters, and the server instructions at most 800. Measured on 1.3.18: 24,944 characters of tool definitions (18,193 of them output schemas) and 1,298 of instructions, about 6,500 tokens before any question was asked.

### `mql5_find`

Input:
- `queries`: a list of strings, or a single string. Each is an API name (`OrderSend`, `ENUM_ORDER_TYPE_FILLING`, `CTrade::Buy`), an exact page title (`Order Properties`) or a question (`how to read indicator buffer values`). The first 16 are answered; any more are counted and the first three named as skipped.
- Forgiving input, kept narrow: a list sent as JSON text (a real Claude Code call once sent `"[\"REASON_RECOMPILE\", ...]"` as one string) is parsed once; a name written `OrderSend()` or `OrderSend(...)` is read as `OrderSend`, and `CTrade.Buy` as `CTrade::Buy`, with the canonical name shown in the reply. Questions are never rewritten.

Output: one header line with the docs version, then one block per query, in order:

```
MQL5 docs downloaded 2026-10-14 · index 2987a6f

= OrderSend · function · mql5/ordersend
The OrderSend() function is used for executing trade operations by sending requests to a trade server.
bool OrderSend(MqlTradeRequest& request, MqlTradeResult& result);
Parameters:
  request [in]   Pointer to a structure of MqlTradeRequest type describing the trade activity of the client.
  result  [in,out] Pointer to a structure of MqlTradeResult type describing the result of trade operation ...
Returns: In case of a successful basic check of structures (index checking) returns true. However, this is not a sign of successful execution of a trade operation. ...
Note: The trade requests go through several stages of checking on a trade server. ... (the whole Note text)
  [code example cut, 4,490 characters: mql5_read id=mql5/ordersend focus=Example]
See also: OrderSendAsync (mql5/ordersendasync), OrderCheck (mql5/ordercheck), MqlTradeRequest (mql5/mqltraderequest)

= TRADE_RETCODE_DONE · constant, value 10009 · mql5/enum_trade_return_codes
Request completed
Section notes: ... (the prose around the table, if any)
More: mql5_read id=mql5/enum_trade_return_codes focus=TRADE_RETCODE_DONE

= OnTick · function · mql5/ontick
... card ...
Also named OnTick: CExpert::OnTick (mql5/cexpertontick)

= ordersend → spelling corrected to OrderSend · mql5/ordersend · (card shown above)

~ how to read indicator buffer values · no exact name; best match:
CopyBuffer · Timeseries and Indicators Access · mql5/copybuffer
(CopyBuffer's card, because the best page has one; otherwise a passage of about 800 characters around the matching words)
Other pages: SetIndexBuffer (mql5/setindexbuffer), Indicator buffers (book/...)
```

- `=` means the query matched a name or page title exactly; it proves the match, not every claim about that API. `~` means it did not, so the pages are a search result, not a known API. Either way, a claim needs returned text that states it. `none` means nothing matched, with a hint to rephrase or check mql5.com.
- **Ambiguous names**: when one name belongs to several pages, a page titled exactly with the name comes first, then a global API before a class member. If that leaves one page, it is shown, and the others are listed as `Also named ...` (at most 5, then "+N more"). If two or more class members remain and no global API wins (104 pages are titled "Create", 86 "Type", 30 each "Save" and "Load"), no card is shown: the reply says how many pages share the name, lists the first 5 as `Class::Method (id)` in keyword-index order, and asks for `Class::Method`. (OnTick: the global event handler wins over CExpert::OnTick. TRADE_RETCODE_DONE also appears on the "List of MQL5 Constants" summary page, which is never a constant's main page; section 5.)
- **Case corrections**: a name found only by ignoring case is shown with its canonical spelling and the words "spelling corrected", because the exact spelling matters for compiling. (No two of the 4,405 keyword-index names differ only by case, so this can't pick between two real APIs.)
- **Repeated results**: a query that resolves to the same card or anchor target as an earlier query in the same reply keeps its own outcome line (with any spelling correction) and says "shown above" instead of repeating the text. Two different constants on one page are different targets and are both shown, but section notes they share are shown once per reply ("section notes shown above").
- **Output budget**, within 12,000 characters, checked on the final rendered text (8,000 if the real-client checks in section 13 show either client cutting a 12,000-character reply):
  1. The header, one outcome line for every query, and the skipped-query notice are always shown. A query is echoed only up to 100 characters.
  2. If every full block (card or passage, with its `Also named` and sibling lists) fits, they are all shown.
  3. If not, each query in order gets its full block if that still leaves room for a brief block for every query after it, and otherwise its **brief block**: outcome line, brief text and marker together at most 480 characters (16 brief blocks fit in 8,000). So one large card early in a batch doesn't turn every later card brief. A brief card (section 5) is marked `(brief; full card: mql5_find <name>)`; a card too big for any single reply is marked with the `mql5_read` arguments instead, so the agent is never sent in a circle; a result without a card (a book page, for example) shows the start of its passage and the complete `mql5_read` arguments for the rest. The agent asks again only for the ones it needs. Estimated with card sizes cut from the real pages, on the 35 real lookup batches: 10 pass 8,000 characters with full cards; making a whole batch brief at 8,000 would leave 109 names brief, while this rule at 12,000 leaves 15, with 41 instead of 58 calls and 13% fewer characters if the agent then fetches every brief one. (This compares two rules for v2; how v2 compares with 1.3.18 is measured by the benchmark.)
  4. If even the brief blocks don't fit, the remaining queries keep only their outcome line plus the complete `mql5_find` or `mql5_read` arguments to get them.
  5. Inside a full card, code examples are cut first, each replaced by a marker with its size and the read arguments. Note and Return Value prose is kept whole; it is cut, at a sentence boundary with a marker, only when the card alone would pass the budget. Nothing is ever cut in the middle of a line of a signature or declaration.
  6. **Oversized cards**: a few cards may pass the budget even without code and with cut prose (DynamicModeDecompositionQR comes close, with four typed signatures and long parameters, about 10,800 characters). Such a card is shown in order up to the budget, split between signatures or lines, and ends with the complete `mql5_read` arguments to continue from the next part.
- (The card text above is illustrative; real cards are copied from the page.)

### `mql5_read`

Input:
- `id`: a page id (`mql5/ordersend`).
- `focus` (optional): a name, heading, word or phrase, matched on whole words, in this order: a name with an anchor on this page (from the keyword index, for example `ENUM_ORDER_TYPE_FILLING`, which is mentioned earlier on Order Properties than where it is defined) goes to that anchor; else a heading that matches exactly (so `focus=Note` lands on the Note heading, not on an earlier sentence that mentions a note); else the first paragraph, table row or code block that contains it (an exact identifier first). The heading above and, for a table row, the table's header row are printed first. If the focus is not found, the reply says so on its first line and shows the start of the page.
- `page` (optional, default 1): pages are about 4,000 characters, cut at paragraph, table-row or code-block boundaries. A single block longer than a page is split: code at line boundaries, prose at sentence boundaries (word boundaries if a sentence is longer than a page), each split marked "continues". A table split across pages repeats its header row. (DatabaseExecute's code example alone is about 27,000 characters.)

Output: one header line (`OrderSend · MQL5 Reference > Trade Functions > OrderSend · mql5/ordersend · page 1 of 3 · index 2987a6f`), then the text. Code stays as code; tables become `a | b | c` rows. When there is more, it ends with the complete arguments for the next call, for example `next: mql5_read id=mql5/ordersend focus=Note page=2`. With `focus`, pages count from where the focus starts.

The index tag is the first 7 characters of the index file's SHA-256. A running server keeps the same index for its whole life, so paging within a session is always consistent; an agent that sees a different tag (a new session after a docs update) starts paging again.

### Ids

Page ids only: `<source>/<page file name without .htm>`, lowercased, with sources `mql5`, `book` and `nn`. There are no file-name collisions in the current 4,827 pages. A position inside a page is given by `focus`, never by a number, so an id keeps its meaning across docs updates while MetaQuotes keeps the file name. An id that disappeared after an update gets "not in the current docs; use mql5_find again".

### Server instructions

Sent once when a client connects, a few lines long: call `mql5_find` first with every name you need; `=` is exact, `~` is a search result; read the cut part when a card marks one before relying on what it doesn't say; reuse text already read while the index tag is unchanged; say "Not verified in the installed MQL5 docs" rather than guessing, and check mql5.com when the docs lack something or freshness matters. These repeat the tool descriptions on purpose.

## 5. The index

One SQLite file (built-in `node:sqlite`, FTS5 full-text search) holding:

- **pages**: id, source, title, breadcrumb.
- **blocks**: each page's structure, stored once when the index is built: page id, position, kind (heading, paragraph, code or table row), text, the heading it sits under, for a table row its table and header row, and any anchors at that position. `mql5_read`, `focus`, passages and the cutting rules work from these, so nothing at run time parses HTML. Indexed by page and position.
- **sections**: page id, heading and text, in page order, built from the blocks. Used for full-text search; never exposed as ids.
- **names**: every name that should find a page, with its kind, whether it is a global API or a class member, and an optional anchor target. Taken from page titles, the CHM keyword index (.hhk, whose anchors such as `orderproperties.htm#enum_order_type_filling` become anchor targets; an anchored target beats an unanchored one on the same page), each page's keywords tag (common in the Reference, rare in the books), constant rows, struct names, and `Owner::Method` names. Owners come from breadcrumbs (`Trade Classes > CTrade > Buy` → `CTrade::Buy`) and from the declarations printed on the page, because some breadcrumbs name only a category (`matrix_copyrates.htm` declares `matrix::CopyRates` and `vector::CopyRates`; the global `CopyRates` is a different page). Ordinary indexes on the exact name and on its lower-case form make a name lookup a single index read.
- **Summary pages**: a short list of page ids in `config/summary-pages.json` (for example the "List of MQL5 Constants") whose tables repeat constants defined elsewhere. They stay searchable by title, but never produce cards and are never a constant's main page.
- **cards**: the full card text, and its brief form, for each function, method, class, constant and struct.
- **meta**: schema version, builder version, the three CHM hashes, download date.

How cards are cut from a page. Function pages share one layout, measured on the current docs: bold headings "Parameters", "Return Value", "Note", "See also", parameter names in their own style; 2,468 of 4,134 Reference pages have a Parameters heading.

- **Function or method**: the introduction (all text before the first of the Parameters, Return Value, Note or See also headings; OnTick, for example, has no Parameters heading, and CopyBuffer explains its element order in this part), every signature (all overloads; declaration blocks are the code blocks in the introduction, told apart from examples, which come later), each parameter with [in]/[out] and its description, Return Value whole, Note prose whole with its code examples cut (section 4), and See also names with their ids. Measured: Note prose runs up to about 3,800 characters (OnTradeTransaction, whose key "is not guaranteed" warning sits 2,256 characters in), so most full cards stay under about 5,500 characters; the few larger ones use the oversized rule in section 4.
- **Errors**: the docs have no separate errors section. Failure conditions and error codes live in Return Value and Note (for example "call GetLastError()", or OrderSend's "this is not a sign of successful execution"). Both are in the card. A page with its own heading about errors gets that section in the card too.
- **Class**: the include line and declaration, then its method table, one line per method with its description (for example CTrade: SetExpertMagicNumber, Buy, PositionClose ...).
- **Constant**: comes only from a table's authored identifier column: the column headed "ID", "Identifier", "Constant" or "Flag" (about 270 tables in the Reference; "Flag" is used for the font constants such as FONT_ITALIC), or a column whose header names an enum ("The value in ENUM_ORDER_TYPE_FILLING"). Its cells must be upper-case identifiers (capital letters, digits and underscores, so `SUNDAY` and `TRADE_RETCODE_DONE` both count); links in them are fine (the TRADE_ACTION_* names are links). Other columns never define constants, even when their cells look like constants: the DirectX topology table's "Match in D3D11_PRIMITIVE_TOPOLOGY" column stays description text. Tables headed "Method", "Class method", "Function" or "Field" are therefore never constant tables, and summary pages are skipped. The card shows the identifier, its numeric value from the same row's "Value" or "Code" column when there is one (TRADE_RETCODE_DONE = 10009; never inferred from row order), the row's other text as its description, a `focus` pointer to its row, and the **section notes**: the prose of the section the table sits in (from the heading or anchor before it to the next heading or anchor, tables left out), under the usual cutting rules. A row alone can be misleading: ORDER_FILLING_RETURN's row says it is not allowed in Market Execution mode, while the section's notes add that pending orders should use it regardless of the execution type. It names its enum in one of two authored ways: the column header names it ("The value in ENUM_ORDER_TYPE_FILLING"), or the table is the first table in that enum's own section, which starts at the anchor the keyword index gives for an `ENUM_*` name and ends at the next heading or anchor (ENUM_ORDER_TYPE's section holds the "Identifier | Description" table of ORDER_TYPE_BUY ...; 143 of the 168 `ENUM_*` names have such an anchor). Sections are found in document order, because tables sometimes sit inside wrapper elements. It never guesses from other nearby text. Up to 10 other constants of the same table are listed as siblings; a longer list ends with "+N more" and the `mql5_read` arguments for the table. (Colour names such as `clrRed` are not constants by this rule; their page is still found by its title.)
- **Struct**: the definition block as printed in the docs, then the field-description table (for MqlTradeRequest: each field with what it means and when it is required), then any prose about usage, under the same cutting rules as functions; a cut part gets a marker with the read arguments. Only a page that documents the struct gets one: its first code block defines a struct whose name is the page's title or one of its keyword-index names (13 Reference pages). Book chapters that open with an example struct (Pair, MqlTick on "Working with real tick arrays in MqlTick structures") and "Structures, Classes and Interfaces" (the `structure_name` template) get no card, so their passage answers.
- **Brief card**: the identifier line, the first signature (with "+N overloads" when there are more) or, for a struct or class, its name line, then the first sentence of the description and, for functions, of Return Value, kept within the 480-character brief block (section 4). A first signature too long for that is left out and replaced by the `mql5_read` arguments to see it.
- Anything else: no card. Find shows the best passage instead.

**Build checks**, all before the new index can go live:

1. SQLite's own integrity check and FTS5's integrity check pass. Every page id is unique, and every keyword-index anchor used as a target exists on its page.
2. **Baseline names**: `config/baseline.json`, reviewed by hand once in step 1 of the build order, lists about 200 names that must exist with the right kind and main page (OrderSend function; TRADE_RETCODE_DONE constant on Trade Server Return Codes with value 10009 and description "Request completed"; ORDER_TYPE_BUY constant of ENUM_ORDER_TYPE; SUNDAY, TRADE_ACTION_DEAL and FONT_ITALIC constants; CTrade class; MqlTradeRequest struct; matrix::CopyRates method ...). About 20 of them also carry a phrase their card must contain (OrderSend: "not a sign of successful execution"; iMA: all six parameter names; OnTradeTransaction: "is not guaranteed"; CTrade: "Buy"; ORDER_FILLING_RETURN: both "not allowed in the Market Execution mode" and "regardless of an execution type"). All must pass.
3. **Lost names**: a report lists every name and card the current index has and the new one lacks. More than 2% lost stops the update unless `--accept-loss` is given. If the current index is damaged or missing, this check is skipped and the baseline alone decides, so a damaged index never blocks its own repair.

## 6. How find works

For each query:

1. **Names** (after the input normalization in section 4): exact name (case-sensitive), else the same name ignoring case (shown as spelling corrected). Page titles are names, so exact titles work here. A name hit goes straight to its stored card through the name index, without running full-text search. A hit gives its card; a name without a card but with an anchor target (an enum such as ENUM_ORDER_TYPE_FILLING) gives the passage starting at that anchor, so its value table comes in one call; any other page gives its best passage. Ambiguous names follow section 4.
2. **Questions** (no name hit): full-text search over sections in all three books, weighted title 10, heading 5, body 1, results labelled by book. The Reference gets a modest ranking boost, tuned with the benchmark, rather than always coming first, so a book chapter that answers a how-to question better can still reach the top three. Section hits are merged per page before the top three pages are picked. The search expression is built from the question's words, each quoted, so punctuation in a question can't break the search syntax. Phrase expansions (`config/expansions.json`, the five groups from 1.3.x, for example "open a trade" → OrderSend, CTrade::Buy) add candidates; they never replace the original words. A class page's method catalogue (its layout headings) counts half, since it shares a trading question's words without answering it; a page titled with a word the question writes with one capital ("Print in the strategy tester log") counts double when no other non-member page has that title. A question that names an API in a context its page never covers is answered by the best result with one prose paragraph naming the API and holding all the question's other words (its heading may add those other words; headings alone, code and class method catalogues never count), and the API's page is listed next ("CopyTicks in the Strategy Tester" → Testing Trading Strategies); when a paragraph of the API's page holds them, its page stays first, and when another page the question names holds them, that page comes first ("OnDeinit when I use ExpertRemove in optimization" → ExpertRemove). If the top page is a function or method, its card is shown; otherwise a passage of about 800 characters starting at the paragraph that covers the question best, printed by the same code as `mql5_read` (a class card is a method catalogue and a struct card the whole page). The next two pages are listed with their ids.
3. **Typo fallback**: when neither finds anything, names within 2 edits are offered as "did you mean". The candidate list is loaded only the first time a fallback is needed, so normal lookups never pay for it.

Once the first real index exists, the main queries (name lookup, blocks by page, full-text search) are checked once with SQLite's `EXPLAIN QUERY PLAN` to confirm they use their indexes.

## 7. Getting and updating the docs

All commands use one data folder: `%LOCALAPPDATA%\mql5-docs-mcp\data\` (tests point the `MQL5_DOCS_DATA` variable elsewhere). The installed server reads the same folder, so an update always reaches it.

One command, `npm run docs:update`:

1. **Lock.** Create `data/update.lock` exclusively (it fails if one exists), writing the process id and time into it for the message. The command removes its own lock when it finishes, whether it succeeded or failed. A command never removes a lock it did not create: when one exists, it stops and says "another docs update may be running (process N, started at T); if none is, delete data/update.lock and try again". Only a crash leaves a lock behind. The lock is what keeps one update's cleanup from deleting another update's fresh index.
2. **Download** the three CHM files from the fixed www.mql5.com URLs used by 1.3.x, all three at the same time, each hashed while it is written. HTTPS only, at most 3 redirects and only within www.mql5.com, at most 50 MB and 3 minutes per file, into a new work folder. If any download fails, the update stops.
3. If the three hashes and the builder version match the current index **and** the current index passes its checks (schema, SHA-256, SQLite integrity), stop: "already up to date". Otherwise carry on, so a damaged or missing index is rebuilt, and a newer v2 rebuilds the index automatically.
4. **Unpack** each CHM with Windows' own `hh.exe -decompile`, started from inside the work folder with plain relative names (`hh.exe -decompile mql5-out mql5.chm`), so spaces elsewhere in the path don't matter, with a 2-minute limit per file. Measured from Node on all three books: identical page files to 7-Zip in 0.4 to 3.8 s. It always exits with 0, so the result is checked before anything is built:
   - the table of contents (.hhc) and the keyword index (.hhk) exist and parse;
   - every entry in both points to a page that exists;
   - every page is complete: it has a title and ends with `</html>`;
   - no file landed outside the work folder (the CHM is downloaded data).
   If any check fails, the update stops and the current index stays active.
5. **Build** into a brand-new temporary file in `data/`, one page at a time to keep memory low, all inside **one database transaction** with SQLite's normal safety settings (measured: separate commits would take about 12 s per 5,000 rows, one transaction 0.13 s). After the last page, the full-text index is compacted once (FTS5 `optimize`), then the transaction is committed and the checks run. Each page is decoded with the charset it declares (Windows-1252 for the Reference and the MQL5 book, ISO-8859-1 for the neural-networks book today). Only the indexer loads the HTML parser. A temporary file left behind by an interrupted build is deleted, never reused.
6. **Check** the new index (section 5's build checks).
7. **Switch**: close the checked file and move it to `index-<UTC build time to the millisecond>.sqlite`. The move never replaces a file (hard link, then delete the temporary name); if that name somehow exists, the update stops. This matters because Windows does let a file be copied over an open index. Then write `data/current.json` (index file, its SHA-256, schema version, CHM hashes, download date, builder version) to a temp file and rename it into place, retrying for a few seconds if Windows reports it busy (a server reading it; lesson from 1.3.16).
8. **Clean up**: delete the work folder and every index file that `current.json` does not name. Skip any file still open; it goes at the next update.

Why a pointer file and versioned index names: measured on this PC, Windows refuses to rename or delete an SQLite file that a running server has open. Running servers keep their index until they restart; new sessions get the new one.

Setup (section 9) runs the same steps 2 to 8 under its own hold on the lock, and delays the switch until both clients are registered.

**Index format guard**: a standalone `docs:update` runs only when `current.json` can be read and records the same schema version as the update code's own (the index file itself may be missing or damaged; that is what a repair is for). If `current.json` is missing, unreadable or records a different schema, older or newer, the update stops before downloading and says to run `npm run setup`, which installs the matching server and builds its index together. The schema is checked on `current.json` as read after taking the lock, so a setup that switched formats a moment before never gets its index replaced. So running the update from an old checkout or a newer one can never leave the installed server with an index it can't read.

`npm run docs:status` prints the version and counts for humans. `npm run find -- <query>` prints exactly what `mql5_find` returns (same code), for quick checks and tests.

## 8. Server start

1. The entry file first starts the index check (step 2) without waiting for it, then loads the MCP library with a dynamic import (a static import would load before the check could start) and answers `initialize` and `tools/list` at once. The server never loads the HTML parser (about 150 ms per start, measured), not even indirectly through shared code.
2. The check: read `current.json`, hash the index file as a stream (measured: 64 to 135 ms on an 82 MB file), open it read-only and check its schema version and SHA-256 against `current.json`. If the index file is missing because an update just switched and cleaned up, read `current.json` again once. There is one shared check: tool calls that arrive while it runs all wait for the same one, never start their own.
3. Tool calls wait for that check. If it fails (no index yet, a damaged one, or one of another schema version), the call returns one clear line saying what is wrong and to run `npm run docs:update` (or `npm run setup` when the update says the format differs or `current.json` is missing), and the next tool call repeats steps 2 and 3 from scratch. So a server that starts a moment before setup or an update switches `current.json` (section 9, steps 6 and 7) works from its first call after the switch. A failed check closes anything it opened. A server never answers from an index whose schema version it doesn't know.
4. Once the check passes, the server keeps that one read-only connection, and prepares each query the first time it is used, for its whole life. It never reopens the index or rereads `current.json` between calls.

Expected first answer: about 0.35 s after the server starts on a warm PC (an estimate from the measured parts; 1.3.18 takes 2.3 to 2.8 s, mostly because its start-up checks are heavier). The benchmark measures the real figure (section 13).

## 9. Install

From a fresh checkout, run `npm ci` once (there are no development-only dependencies), then `npm run setup`, a Node script. Everything that can fail is checked before anything changes:

1. **Preflight**:
   - Node: checks that `node:sqlite`, FTS5 and the Windows-1252 and ISO-8859-1 decoders work, and stops if not. The tested line is Node 24 (24.17.0 today); another major version gets a warning, not a stop.
   - Clients: finds the `claude` CLI (a native program) and the `codex` CLI (an npm `.cmd` launcher, which must be run through the Windows shell with paths quoted). Asks each for an existing `mql5-docs` entry (`claude mcp get`, `codex mcp get`; `claude mcp get` connects to the server, so this can take a few seconds). An entry that runs anything other than a v2 installation stops setup with a conflict message.
2. **Copy** `src/`, `config/`, `package.json` and the production `node_modules` into a new folder `%LOCALAPPDATA%\mql5-docs-mcp\app\<version>-<time>\`. The live app is never overwritten, so a half-finished setup can't leave a mixed install.
3. **Lock** the data folder with the docs lock (section 7) and hold it until setup ends. Setup calls the update code's build and switch steps directly, under this one lock; only a standalone `docs:update` takes the lock itself.
4. **Build** if needed: unless the current index is healthy and was built by the same builder version as the new copy, run steps 2 to 6 of section 7 with the new copy's code. The new index gets its final name, but `current.json` is not touched yet, so the working installation keeps its own index. (A first install builds the index; an upgrade that changes the index format rebuilds it.)
5. **Self-test** the new copy: run its `find OrderSend` against the new index (or the current one, if none was built) and check the card.
6. **Register** the new copy with each client found, using the absolute path of the Node that ran setup:
   - `claude mcp add -s user mql5-docs -- <node.exe> <app>\src\server.mjs`
   - `codex mcp add mql5-docs -- <node.exe> <app>\src\server.mjs`
   An existing v2 entry is removed first, and its full settings (scope, command, arguments, environment) are remembered until setup ends. Other servers are never touched. The tests cover an install path containing spaces.
7. **Switch** `current.json` to the new index, if one was built (section 7, step 7).
8. **Finish**: clean up as in section 7, step 8, delete older app folders that are not in use, and release the lock. Only folders setup made (named `<version>-<stamp>` and holding this package's `package.json` and `src/server.mjs`) are ever deleted, because a data folder set by `MQL5_DOCS_DATA` can put the app folder among other files; a data folder named `app`, which would be its own app folder, is refused before anything changes. The data folder is registered as an absolute path, and `--accept-loss` passes through to the index build as in `docs:update`. Setup says to restart Claude Code and Codex; running sessions keep their copy until then.

**If any step from 4 to 7 fails**, setup puts back the remembered entries in both clients and leaves `current.json` as it was, then deletes the new index and the new app folder unless some client entry still refers to them, and releases the lock. Two client registrations and a pointer file can't be changed in one atomic step, so this is a best effort, not a guarantee: if putting an entry back also fails (or setup is killed midway), setup keeps every app folder and index that any entry or `current.json` still refers to, and prints the actual state of each client with the commands that fix it. Running `npm run setup` again repairs that state. The tests cover a failure at the second registration, at the switch, and while putting entries back.

`npm run setup -- --uninstall` removes only entries that run a v2 installation (for Claude Code, again after each removal, since a local entry can hide a user one), then the app folders setup made, and the app folder itself only when nothing else is in it. When a client can't be checked or shows an entry that isn't v2 (which may hide one that is), the app folders stay; `--purge` also deletes the data.

## 10. Safety rules

- Tools are read-only and accept no file paths or URLs. Ids are checked against a strict pattern and looked up in the index.
- The only network access is `docs:update`, to three fixed URLs, with size and time limits.
- Downloaded pages are treated as data: text is extracted, nothing is run.
- Nothing becomes active before it passes its checks. A failed update changes nothing that is in use; a failed setup puts the previous entries back, or reports exactly what it could not put back (section 9).
- No secrets anywhere. The CHM files and the index are MetaQuotes content and never go into the repository.

## 11. Fixes from 1.3.x that v2 must keep

Each becomes a test where v2 has code for it.

1. `tools/list` answered before the index check (Codex, 1.3.13).
2. Constant names find their page: ENUM_ORDER_TYPE_FILLING → Order Properties.
3. Exact page titles work as names (1.3.16).
4. Exact versus near match always stated.
5. `focus` finds the right place inside long pages: a name's own anchor first, then an exact heading, whole words, with a not-found notice.
6. Phrase expansions and typo fallback.
7. Pages decoded by their declared charset.
8. An open index is never renamed, deleted or overwritten (measured; section 7).
9. Download limits: fixed URLs, HTTPS, redirect, size and time limits, hash compare.
10. Install paths with spaces and long paths work. CI runners use short 8.3 temp paths, so resolve paths before comparing them.
11. The indexer works one page at a time (memory limits, 1.3.10).
12. Tool names differ per client: Claude `mcp__mql5-docs__mql5_find`, Codex `mcp__mql5_docs__mql5_find`.
13. The skill's health check respects servers disabled or shadowed in Claude Code (`disabledMcpServers`, 1.3.17) and Codex tool filters, and tells "server answers" apart from "tools loaded in this chat".
14. Brief "file busy" errors on Windows are retried (1.3.16).
15. Documentation text always travels in the plain-text reply (the Claude Code finding in section 1).
16. Batches of up to 16 names.

## 12. Changes in the mql5-coding skill

Made in the skill's repository, released together with v2:

- New tool names (both spellings, item 12). The how-to-use rules now come from the tool descriptions and server instructions, so the skill only says when to use the tools.
- Keep its evidence rules, worded like section 4: every API claim needs returned text that states it, whatever the marker (`~` never identifies an API; `=` proves only the name match); say "Not verified in the installed MQL5 docs" when the docs don't support a claim; check the official mql5.com page when the docs lack something or freshness matters; never substitute remembered facts.
- Citing: page title and id, plus the docs version once per answer.
- Remove the status-first rule, image instructions, cursor and section-id instructions, and the commit pins to the MCP.
- Update or remove every file that still names the old server, not only the prose: `agents/openai.yaml` (which names `mql5-chm`), the old MCP consumer contract and the approved-peer data. Keep one small real check that starts the new server over stdio and calls both tools.
- Health check: keeps the distinctions in item 13; checks that `mql5-docs` answers and is at least the minimum version.

## 13. Benchmark and the switch

`bench/cases.json`, about 100 cases:

- the 32 hand-checked cases from 1.3.x (`tests/fixtures/documentation-quality.json`), with the one image check replaced by a text check;
- about 60 names and questions from real Claude Code and Codex sessions, with the right page checked by hand in the HTML;
- harder kinds on purpose: caveats deep in a Note (Print, OnTradeTransaction), overloads, ambiguous names (OnTick, Create), constants with values (TRADE_RETCODE_*, ERR_*), constants whose enum comes from its section (ORDER_TYPE_BUY → ENUM_ORDER_TYPE), enum names (ENUM_ORDER_TYPE_FILLING), owner-qualified methods (matrix::CopyRates), names written `OrderSend()` or `CTrade.Buy`, an oversized card (DynamicModeDecompositionQR), common lowercase words that must not match struct fields (`symbol`, `price`), batches of 13 and 16, and about 10 "how do I" questions, some answered best by a book.

Each case lists the expected page or pages and one or more facts: short exact phrases from the documentation that a correct answer needs. The 4 "absent" cases from 1.3.x (made-up names such as `CopyBufferFake_7391`) list no page and no facts. About 20 cases are set aside as a **held-out set**, frozen before any tuning and never used to tune.

**Completion rule, the same for both servers:** a normal case is complete when the expected page was named and every expected fact appeared in a card or passage that belongs to the expected page. A fact found in some other page's text does not count. An absent case is complete when the server reports no exact match. A fixed script plays the client: it runs the lookup, then reads the top three candidates in order, following their next pages, and stops when the case is complete or after 6 calls. It counts every call and every character until then. This measures retrieval; it is not a simulation of an agent.

`npm run bench` reports every case (completed or not, calls, characters), the totals, and every case that got worse. Alongside calls and characters it counts the tokens the model sees and the number of rounds that must happen one after another. It also records timing: from start to `initialize`, to `tools/list` and to the first complete answer; typical find and read times; and how long `docs:update` and `setup` take, keeping cold and warm runs apart and showing the spread over repeated runs. `npm run bench -- --server <command>` scores any MCP server over stdio; both servers are scored on the same CHM files. A small adapter for 1.3.18's tool names reads the plain-text part of its replies, as Codex does; it is deleted after the switch.

**Completeness tests**, separate from the benchmark, because a shortened card could still contain every benchmark phrase: extraction tests on hand-made pages and on about 10 real pages (OrderSend, OnTick, CopyBuffer, Print, OnTradeTransaction, MqlTradeRequest, Order Properties, CTrade, DynamicModeDecompositionQR, DatabaseExecute) check that cards keep every parameter, all Return Value and Note prose, and a constant's section notes (ORDER_FILLING_RETURN keeps its pending-order exception), and that reads split oversized blocks correctly.

**Real-client checks**, separate from the benchmark, in both Claude Code and Codex: the tools appear on the first turn of a new session; a 12,000-character reply arrives whole (if either client cuts it, the find budget becomes 8,000 and an 8,000-character reply is checked instead); and 5 real coding tasks give correct answers based on returned text.

**Switch when** all of these hold:
- every case 1.3.18 completes, v2 also completes, in the held-out set too;
- v2 is at least as good on rank 1 and top 3;
- v2 needs fewer calls in total, and no more characters in total, so cards are never cut down just to win on size;
- the completeness tests and the real-client checks pass.

Then the new skill is installed in both clients, and 1.3.18 is uninstalled from both with its own uninstall scripts. No fallback is kept. Those scripts remove the registrations but keep the package folders, so once no old session is running, the old folders (`%LOCALAPPDATA%\MQL5-CHM-MCP\1.3.17` and `1.3.18`, 205 MB each) are moved once to the owner's cleanup archive for the owner to delete. This one-time step is not part of v2's installer. Archiving the old GitHub repository is the owner's call at that time.

## 14. Project layout and size targets

```
mql5-docs-mcp/
  package.json            dependencies: @modelcontextprotocol/sdk, zod, cheerio
  src/server.mjs          entry: starts the index check, then loads the MCP
                          library; the two tools and instructions             ~250 lines
  src/search.mjs          find and read over the index, one text renderer    ~500
  src/indexer.mjs         pages, blocks, sections and names from HTML        ~500
  src/cards.mjs           card extraction, full and brief                    ~300
  src/docs-update.mjs     lock, download, unpack, build, check, switch        ~300
  src/setup.mjs           install and uninstall for both clients              ~200
  src/cli.mjs             docs:status and find for humans                     ~50
  config/expansions.json  phrase expansions from 1.3.x
  config/baseline.json    the hand-reviewed baseline names
  config/summary-pages.json  page ids of summary pages (section 5)
  bench/                  cases.json and run.mjs                              ~200
  tests/                  node:test, small hand-made HTML pages (oversized blocks,
                          tables inside wrapper elements, pages without Parameters,
                          enum sections), the completeness tests, and a test of
                          the tool-definition and instructions size limits
  .github/workflows/ci.yml  Windows, Node 24: npm ci, tests (target: under 5 minutes)
```

About 2,300 lines of code plus tests, against about 23,000 today. The production `node_modules` size is measured in step 1. CI runs on small hand-made HTML pages, because the real docs can't go into the repository. CI also tests the `hh.exe` call itself (its arguments, the time limit, and rejecting empty or incomplete output) with stand-in files; unpacking a real CHM can't run in CI, because no CHM may be committed. That part is covered on this PC by a real-docs run that starts from the downloaded CHMs and builds the index (benchmarking an existing index would skip unpacking). Any change to the indexer or cards must pass that run, the completeness tests and the full benchmark before it is merged.

## 15. Build order

Steps of about 300 changed lines, each a coherent piece. Each gets its GPT review and a local commit; the whole job goes up as one pull request at the end.

1. Repository skeleton; indexer for pages, blocks, sections and names; tests on fixture pages. Measure index size and `node_modules` size; draft and hand-review `config/baseline.json`.
2. Cards (full and brief) with the completeness tests.
3. Search, the server with both tools and its instructions, `npm run find`.
4. `docs:update` and `docs:status`.
5. `setup` (install and uninstall), CI.
6. Benchmark: freeze the held-out set, score 1.3.18 and v2, then tune ranking and cards.
7. Skill update in the skill repository, real-client checks in both clients, then the switch.
