# MQL5 Docs MCP v2 — decisions and evidence

What the design rests on, how it was reviewed, and what was agreed or declined. The design itself is in DESIGN.md.

## 1. Measured facts behind the design

Measured on this PC on 2026-10-21 against MQL5-CHM-MCP 1.3.18 and its docs (index 2987a6f), and reproduced independently by the Fable 5.1 review.

| Fact | How it was measured | Result |
|---|---|---|
| Claude Code gets no documentation text from 1.3.18 | Parsed every Claude Code transcript and matched each `mcp__mql5-chm__*` call to its result | 45 of 45 results (23 of them reads) were the structured JSON only. The passage exists only in the plain-text part (`src/server.mjs`, `conciseReadOutput` drops `text`) |
| Codex gets the text | Codex session logs (`McpToolCall` results) | The plain-text part with the passage is present |
| Tool usage | Counted `McpToolCall` entries in Codex logs (format exists since 2026-10-14, 23 sessions) and tool calls in Claude transcripts | Codex: read 107, lookup 33, status 29, search 5, image 0; four lookup batches of 11 to 13 names. Claude: no image call. Older Codex logs use a format not counted here |
| Token waste | One 4-name lookup | 4,606 characters, about a quarter of them repeated hashes |
| Code size | Line counts of tracked files | JS about 7,500 hand-written lines, PowerShell about 15,700 lines |
| Install size | Installed 1.3.18 folder | About 205 MB: Node 88, index 78, CHMs 21.5, 7-Zip 1.8 |
| Node | `node --version` and probes | 24.17.0; `node:sqlite` with SQLite 3.53 and FTS5; Windows-1252 decoder works |
| Client commands | `--help` and runs of `claude mcp add/get/remove` and `codex mcp add/get/remove` | All exist with the forms used in DESIGN.md section 9; a missing name exits 1 with a message on both |
| hh.exe | Unpacked all three CHMs from Node (`spawnSync`, work folder with a space as the working directory, relative names) and compared every file with 7-Zip | Identical page files: mql5 4,535 files in 3.8 s, mql5book 819 in 0.9 s, neuronetworksbook 289 in 0.4 s; only the 18 CHM-internal files missing per book, which the indexer does not use. Exit code is always 0; absolute paths produce nothing |
| Page layout | Raw HTML of OrderSend, Order Properties, Trade Server Return Codes, CTrade, MqlTradeRequest, DXPrimiveTopologySet, Trade Operation Types and others | Headings Parameters / Return Value / Note / See also; 2,468 of 4,134 Reference pages have Parameters; constant tables label their identifier column "ID" (about 190 tables), "Identifier" (about 65) or "Constant" (about 18), in any position, with values under "Value" or "Code"; some tables have extra columns of external constant-like names (Direct3D); some identifier cells are links (TRADE_ACTION_*); some enum members have no underscore (SUNDAY); struct field tables use lowercase names; 376 duplicated titles in the Reference; "parameters" appears before the Parameters heading on 215 pages |
| Note sizes | Measured on four pages | Prose / code characters: OnTradeTransaction 3,764 / 7,390; OrderSend 3,156 / 4,490; CopyBuffer 1,303 / 2,815; Print 866 / 2,276 |
| Charsets | Page meta tags | Reference and MQL5 book Windows-1252; neural-networks book ISO-8859-1 (keywords tag on 2 of 112 sampled pages) |
| Keyword index | `MQL5.hhk` | TRADE_RETCODE_DONE → enum_trade_return_codes.htm; OnTick → events.htm#ontick, then ontick.htm; ENUM_ORDER_TYPE_FILLING → orderproperties.htm and its #enum_order_type_filling anchor |
| Open-file locks | Opened an SQLite file read-only in Node, then tried rename, replace by rename, delete and copy-over | Rename, replace and delete refused (EBUSY, EPERM, EPERM); copying over it succeeds, so the switch must never replace a file |
| Start-up hash | SHA-256 of the 81 to 82 MB index, streaming, over several runs | 64 to 135 ms (warm file cache) |
| Enum sections | Raw HTML of Order Properties and `MQL5.hhk` | Anchor `enum_order_type` → heading ENUM_ORDER_TYPE → table "Identifier \| Description" with ORDER_TYPE_BUY ...; same for ENUM_ORDER_STATE. 143 of the 168 `ENUM_*` names in the keyword index point to an anchor |
| Shared names | Page titles and keyword-index names | 104 pages titled "Create", 86 "Type", 32 "Main", 30 each "Save" and "Load"; no two of the 4,405 keyword-index names differ only by letter case |
| Large and unusual pages | Text length of real pages | DynamicModeDecompositionQR: about 6,600 characters of signatures before Parameters plus about 4,250 of parameters; DatabaseExecute: about 27,300 characters, almost all its code example; ontick.htm has Return Value, Note and See also but no Parameters; matrix_copyrates.htm declares `matrix::CopyRates` and `vector::CopyRates` under a category breadcrumb |
| Row versus section notes | Order Properties, filling-policy section | ORDER_FILLING_RETURN's row: "Return orders are not allowed in the Market Execution mode"; the section's prose, after the table: "In case of pending orders, the ORDER_FILLING_RETURN filling type should be used regardless of an execution type"; the section has about 2,000 characters of prose outside its tables |
| Input mistakes | Claude Code transcripts | One lookup sent its list of names as a JSON string and its limit as the text "1" |
| Old fixed cost | `tools/list` and `initialize` of the installed 1.3.18 | 24,944 characters of tool definitions (output schemas 18,193) and 1,298 of instructions |
| Old cost per session | Codex logs, 23 sessions | About 8 calls, 8,075 characters of text plus 17,880 of structured data; reads averaged 1,313 characters (agents asked for 1,000 to 2,500, and for "Return Value" 17 times) |
| v2 card sizes (estimate) | Cards cut from the real pages of the 62 function-style names among the 114 names agents looked up | Median about 1,200 characters, 90% under about 2,950, largest about 3,900 (CopyRates, OnTradeTransaction, CalendarValueHistory, OrderSend); brief cards about 270; code examples left out of cards: median about 1,400, 90% under about 5,550 |
| Batches | The 35 real lookup batches, with those card sizes | Median about 5,400 characters with full cards; 10 pass 8,000, 6 pass 12,000, 2 pass 16,000 |
| Old speed | 1.3.18 over stdio, two runs | `initialize` 130 to 170 ms after start, `tools/list` 8 ms, first tool call 2,300 to 2,770 ms (start-up checks), later lookups 6 ms, a question about 105 ms, a focused read about 20 ms |
| Start-up parts | Import timing on this PC | Node itself about 105 ms; MCP library and zod about 145 ms warm (230 cold); the HTML parser about 150 ms more; `node:sqlite` under 1 ms |
| Database speed | A copy of 1.3.18's 82 MB index | Open about 1 to 5 ms; full-text queries 0.07 to 1.8 ms (warm, repeated) |
| Index build | 5,000 FTS5 rows | Separate commits about 12 s (measured on 500 rows); one transaction 0.13 s |
| Download headers | The three mql5.com CHM URLs | `Last-Modified` but no ETag; `If-Modified-Since` returns 304 in 0.15 s; mql5.chm (8.6 MB) downloads in about 0.75 s |

Measured in step 1 of the build order (2026-10-21, this PC, the same docs):

| Fact | How it was measured | Result |
|---|---|---|
| Index size and build | The step 1 indexer on all three books unpacked by hh.exe (pages, blocks, sections and names; no cards yet) | 50.3 MB (1.3.18: 78 MB); 4,827 pages, 80,160 blocks, 11,456 names; about 12 to 13 s; process memory about 380 MB at the end |
| Text captured | Non-space characters of every page's `#help` content compared with the stored blocks | All of it; the only words not stored as blocks are table header rows, which each row carries |
| Production `node_modules` | `npm install` of @modelcontextprotocol/sdk 1.32.1, cheerio 1.2.0, zod 4.4.3 | 21.4 MB in 4,768 files; `npm audit`: 0 vulnerabilities |
| MCP SDK version | `npm audit` on 1.31.0 (the version 1.3.18 used) | 1.31.0 has four high advisories (session-bound tasks, HTTP redirects, request-size memory use, bearer-token audience), fixed in 1.32.1 (published 2026-10-05) |
| Markup the indexer relies on | Survey of all 4,134 Reference pages | Content in `div#help`; title `p.p_H1`; headings `p_H2`, `p_H3`, `p_BoldTitles`; code in one-cell tables of `p_CodeExample`; data tables with `thead`/`th` header rows; list items (`ul`/`ol` > `li`) holding text directly, including return-value cases; 355 table rows carry their own anchors (each compiler error code, for example) |
| Method owners | Declarations on matrix and vector pages | Owners appear only in declarations (`bool matrix::CopyRates(`, `vector vector::NormalizeDouble(`); 114 matrix and vector method pages get owner names this way; a few pages print a mismatched or no owner (ArgSort declares `matrix::Sort(`), none of them clashing with a global function |
| Baseline names | Names agents looked up in 1.3.x plus the design's hard cases, resolved in the real index and checked by hand | 136 names with their main page in `config/baseline.json` (kinds, values and phrases follow with the cards) |

Measured in steps 2 and 3 (2026-10-21, this PC, the same docs):

| Fact | How it was measured | Result |
|---|---|---|
| Cards | Real build with cards | function 787, method 2,612, class 163, struct 42, constant 3,650 (877 with a value, 1,596 with an enum); 337 section notes; 13,475 names; index about 57.8 MB, built in about 18 to 20 s |
| Class members | Pages marked as methods, real build | 2,713. Owners come from the contents parent's name (CTrade, CiMA, ICollection<T>), from the declarations printed on the page (matrix::CopyRates), or, under a descriptive contents entry ("Arrows with fixed code", "Basic Class CObject", "OpenCL"), from the classes the parent page declares. Shared titles: Create 104, Type 86, Save 30, Load 30, all methods |
| Server fixed cost | `tools/list` and `initialize` of the v2 server | 1,690 characters of tool definitions (1.3.18: 24,944) and 551 of instructions (1.3.18: 1,298) |
| Download and unpack | Node fetch and hh.exe against the three mql5.com URLs (2026-10-21) | The URLs answer 200 directly (mql5.chm 8,566,299 bytes, mql5book.chm 7,680,088, neuronetworksbook.chm 6,322,256) with Content-Length and Last-Modified, no ETag; with `redirect: "manual"` Node reports a redirect as it is (http → 301 to https). hh.exe exits 0 on any input: a 1 MB truncated mql5.chm gives 1,556 pages and no .hhc, but **half** of mql5.chm gives all 4,134 pages and the .hhc, so a download must also match its Content-Length; a garbage or missing file gives nothing |
| Windows file rules for the switch | Node on this PC | A hard link onto an existing name fails (EEXIST); deleting an index a reader has open fails (EBUSY) and works once it closes; renaming a temporary file over current.json works |
| Real docs against the build checks | All three books | All 1,911 anchored names have their anchor on their page; all 4,827 pages have a title and end with `</html>`; every contents and keyword-index target exists |
| docs:update | A real run into a scratch data folder with a space in its path, from a copy of the live index | About 24 to 27 s for three downloads, unpacking, build, checks and the switch; the old index removed; a second run says "already up to date" in about 2.7 s, most of it SQLite's integrity check of the live index |
| Benchmark (`npm run bench`, 99 cases, 19 held out) | One fixed client script over stdio against v2 and the installed 1.3.18, checked to hold the same CHM files (2026-10-22) | v2: 97 complete, rank 1 87, top 3 91, 132 calls, 293,521 characters (about 73,000 tokens); held out 17/19. 1.3.18: 85 complete, rank 1 67, top 3 84, 234 calls, 541,964 characters (about 135,000 tokens); held out 15/19. Absent and ambiguous cases have no rank and count in neither rank total. Every case 1.3.18 completes, v2 completes; the two v2 misses (held out) are misses for 1.3.18 too. Per case, v2 ranks lower than 1.3.18 on two how-to questions: howto-push (rank 3 against 2, both complete) and howto-file-write (outside v2's top 3 against rank 3, neither complete). Three fresh starts each (warm, after the scoring run), to the first answer: v2 323 to 330 ms, 1.3.18 2,543 to 2,617 ms. Tokens are estimated as characters / 4 |
| Server speed | v2 over stdio on the real index, three runs | `initialize` 210 to 232 ms after start, `tools/list` 5 ms later, first find (index check included) 315 to 332 ms (1.3.18: 2,300 to 2,770 ms); later find calls of one to three names 5 to 11 ms, six questions together about 90 ms |

## 2. How this design was reviewed

1. Draft 1: three GPT review rounds plus follow-ups on the fixed lines (23 findings, all fixed).
2. Draft 2 (the owner's changes: no way back to 1.3.18, simplest possible, good ideas in, bad lessons out): a GPT consultation with full context (this design, the 1.3.18 source and skill, the Codex and Claude Code usage logs). 13 recommendations; most adopted, two declined with reasons.
3. Draft 3: an independent review by Claude Fable 5.1 at high effort with the same context plus GPT's advice and the decisions. It reproduced the measured facts, found three rules that would fail on the real pages, and proposed cuts; most adopted, two declined with reasons (the update lock and the start-up hash check stay).
4. Draft 4: a final GPT review and follow-ups on the fixed lines, all findings fixed: setup became one sequence (build, self-test, register, switch) that puts everything back if a step fails; setup rebuilds an index of an older format; a server whose index check fails retries on its next call; struct cards include field descriptions; short forms for batches whose cards don't fit; and this section.
5. Re-review at the owner's request: Claude's own second pass and a second GPT consultation, both checked against the real pages. Neither disagrees with the owner's choices. Adopted: brief blocks that really fit, an oversized-card rule, enum ownership from the enum's own section, names that resolve to their anchors, disambiguation for names shared by many classes, an honest setup recovery promise, splitting of oversized blocks in reads, cards for pages without Parameters, owner-qualified names from declarations, safe search expressions and anchor checks, a ranking boost instead of a strict Reference-first order, forgiving name input, repeated results shown once, summary pages by id, a fewer-calls-no-more-characters switch rule with separate completeness tests, the skill's metadata files, clearer `=`/`~` wording, CI versus local coverage, and a one-time cleanup of the old folders. Dropped: a hint about old docs.
6. Token check at the owner's request, measured on real usage (section 1): size limits for the tool definitions with a test, full cards first and brief blocks only for what doesn't fit within a 12,000-character reply, and sibling lists capped at 10. Ideas that would save tokens by losing facts were rejected (section 3).
7. Speed check at the owner's request, measured on this PC and checked by GPT: the index built in one transaction and compacted once; the HTML parser kept out of the server; the index check started first, shared by all early calls; one connection kept for the server's life; page structure stored at build time; direct name lookups with lazy typo candidates; concurrent downloads; timing and token counts in the benchmark. GPT also corrected the batch estimate, so the budget rule now shows every full card that fits. Four speed ideas were declined (section 3).
8. Final full review by GPT and follow-ups, all clean at the end: constant cards now carry their section notes (a row alone could reverse its meaning, as ORDER_FILLING_RETURN shows), and an index format guard stops a standalone update from building an index format the installed server can't read.

Claude (Opus 5.5) agrees with this design as written.

## 3. Agreed decisions

### Owner decisions

| Decision | Detail |
|---|---|
| No way back to 1.3.18 | No fallback kept and no procedure to return; 1.3.18 is uninstalled once v2 passes DESIGN.md section 13 |
| Works with Claude Code and Codex | Both clients, same tools, same replies |
| Use the installed Node 24, not a bundled Node | Claude's recommendation, written in at the owner's request to record the agreed design. Saves 88 MB; if Node is ever uninstalled, the server stops until Node is reinstalled and `npm run setup` is run again |
| The owner creates the repository | Suggested name `MQL5-Docs-MCP`; public or private is the owner's choice when creating it. This design moves into it before any code is written |

### Adopted from the reviews

From GPT's consultation: cards keep important conditions (introduction, whole Return Value, Note prose); the benchmark fixes (text instead of the image case, top-three reading, held-out set, per-case report, real-client checks); a coherent install (preflight, new app folder, self-test, one data folder); ambiguous names and spelling corrections; questions return the best card or passage; constant cards with values, class include lines, See also ids; batches of 16 with one output-budget rule; a tested Node line with probes; hh.exe checked on all three books, with time limits; evidence rules in the tool descriptions and the skill; build checks against a baseline with a lost-names report; whole-word focus with a not-found notice; a simpler lock.

From the Fable 5.1 review: a tighter constant rule (later replaced by the authored-column rule in DESIGN.md section 5); Note prose kept whole with code cut first; brief cards when full cards don't fit; exact heading first for `focus`; one ranking for ambiguous names; the six loss checks merged into two; the dead "unchanged index" branch removed; the skill's "Not verified" and official-page rules kept; a question whose best page has a card shows the card; section numbers and the `index` input dropped in favour of `focus`; a warning instead of a stop on an untested Node major; the `source` filter dropped; the details an implementer would otherwise guess (CLI launch on Windows, the index tag, charsets).

From GPT's final review: setup as one sequence that puts everything back on failure; an older-format index rebuilt by setup; struct cards with field descriptions; short forms for oversized batches; a server that retries its index check on the next call.

From the re-review (Claude's second pass and GPT's second consultation): the changes listed in section 2, item 5.

From the token check: the changes listed in section 2, item 6.

From the speed check: the changes listed in section 2, item 7.

From the final full review: the changes listed in section 2, item 8.

From benchmark tuning (step 6, using only the cases that are not held out):
- typo suggestions show each name's page id, so the agent can read it at once;
- a book chapter is also found by its title without its number ("1.5.2 Dropout" → "Dropout"), and where such a title differs from a Reference title only by case, the Reference spelling wins;
- a phrase that matches a title only by ignoring case also lists the two best search results ("global variables" → Global Variables, plus Global Variables of the Terminal);
- a question that names a class first offers that class's methods whose name words all appear in the question ("close an open position with CTrade" → CTrade::PositionClose);
- words with two capitals (CTrade) count as API names in questions.

How the benchmark treats 1.3.18 (its adapter is deleted after the switch): names go through `mql5_chm_lookup_identifiers`, other queries through `mql5_chm_search` with its default expansion, both with all books and three results; reads follow its `next_cursor`, which only its structured data carries, while only its plain text is counted. A tool error (it rejects `OrderSend()` and `CTrade.Buy`) counts as that case's answer. The cursor and counting choices favour 1.3.18, so v2's margin is, if anything, understated. The run stops when the two servers hold different CHM files, or when either can't answer an OrderSend lookup. `docs:update` and `setup` timings are measured by their own real runs (above), not by the benchmark.

### Declined, with reasons

| Suggestion | From | Why declined |
|---|---|---|
| A hand-curated list of essential passages per frequently used API | GPT | Ongoing upkeep for every docs update. Whole Note prose in cards covers the measured cases; the benchmark's late-caveat cases check it |
| Keep the downloaded CHM files for offline rebuilds | GPT | More code and 21 MB for a rare case; a repair or upgrade downloads the docs again |
| Drop the ~300-line build steps | GPT | They are the owner's review rule and cost nothing in the product |
| Drop the update lock | Fable | Without it, one update's cleanup could delete another update's fresh or temporary index |
| Drop the start-up SHA-256 check | Fable | 64 to 135 ms, and it stops a damaged index from being served |
| Shorter, reworded documentation text in cards | Token check | Rewording can change facts; cards copy the docs and only leave out code examples |
| Dropping Note prose or See also from cards | Token check | Notes hold the warnings agents most need; See also ids save a later lookup |
| Replying "already shown in this session" for a repeated lookup | Token check | After a client compacts a long conversation, the earlier text may be gone |
| A size limit input on reads | Token check | Agents used one in 1.3.x mostly to fetch Return Value cheaply; cards now include it |
| Bundling the code into one file | Speed check | Estimated to save about 0.1 s once per server start, but brings back the build step and generated license notices 1.3.x needed; reconsider only if real v2 timings show loading or copying matters |
| Downloading the docs only when changed (`If-Modified-Since`) | Speed check | v2 deletes the CHM files after building, so a rebuild needs the bytes anyway; a second path for a rare command isn't worth it |
| SQLite settings that turn off journaling or syncing during the build | Speed check | No measured reason: one transaction already gives the big gain, with normal safety |
| Memory-mapping, caches, worker threads or other SQLite tuning | Speed check | Queries already take under 2 ms; profile the whole find and read path only if it turns out slow |
| A hint in replies when the docs are more than 90 days old | Claude (withdrawn after GPT) | The download date is not the docs' publication date, so the hint could mislead; the date in every reply and the official-page rule already cover freshness |
