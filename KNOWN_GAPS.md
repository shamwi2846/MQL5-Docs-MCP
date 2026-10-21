# Known gaps

Findings left unfixed on purpose. Entries are never deleted, only marked fixed.

## G1 · fixed · 2026-10-21 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: DECISIONS.md:41
- Problem: F3: Record the required step-one size measurements
- Trigger: Complete the repository-skeleton and indexer step.
- Fix: Measure the real-docs index and production node_modules, then record their sizes and measurement method in DECISIONS.md.
- Log: 20261021220104-467260
- Why skipped: labelled GAP by the reviewer; harm: The project lacks the agreed measurements needed to assess index and installation size.

## G2 · fixed · 2026-10-21 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: tests/cards.test.mjs:132-142
- Problem: F5: Add the required card completeness tests
- Trigger: Validate this card-extraction increment against DESIGN.md sections 13 and 15.
- Fix: Add HTML-through-indexer completeness tests and a local real-docs suite for the required sample pages, without committing MetaQuotes content.
- Log: 20261021222224-ca39c3
- Why skipped: labelled GAP by the reviewer; harm: The tests pass despite confirmed failures on real documentation pages.

## G3 · fixed · 2026-10-21 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: tests/helpers.mjs:10
- Problem: F1: Check declarations instead of skipping every code block
- Trigger: A card loses a function signature, overload, class declaration, include line or struct definition.
- Fix: Skip example code only; verify introduction signatures and required class and struct declaration blocks.
- Log: 20261021224216-bb0de8
- Why skipped: labelled GAP by the reviewer; harm: The completeness tests can approve cards missing required declarations.

## G4 · fixed · 2026-10-21 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: tests/helpers.mjs:17
- Problem: F2: Check every retained table cell
- Trigger: A card drops a method or field name from a header-bearing row, or drops later cells from a headerless row.
- Fix: Check each nonempty cell separately, including the identifier cell, allowing only the intended formatting changes.
- Log: 20261021224216-bb0de8
- Why skipped: labelled GAP by the reviewer; harm: The completeness tests can accept incomplete or incorrectly associated table content.

## G5 · fixed · 2026-10-21 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: tests/real-docs.test.mjs:25-34
- Problem: F3: Exercise the current extractor in the real-docs tests
- Trigger: Run the documented command against an index built before a change to card extraction.
- Fix: Generate the tested cards with the current extractor from the real index's stored pages and blocks, and run these assertions against those generated cards.
- Log: 20261021224216-bb0de8
- Why skipped: labelled GAP by the reviewer; harm: The real-docs regression tests can remain green despite regressions in the current extractor.

## G6 · fixed · 2026-10-21 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: src/find.mjs:253
- Problem: F3: Budget reservation can exceed the final output limit
- Trigger: Query CopyBuffer, CalendarValueHistory, and fourteen copies of CheckTrailingStopShort.
- Fix: Reserve each future block's actual rendered length instead of capping the reservation at BRIEF_BLOCK.
- Log: 20261021232039-5e5962
- Why skipped: labelled GAP by the reviewer; harm: Callers cannot rely on the promised 12,000-character response limit.

## G7 · fixed · 2026-10-21 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: src/find.mjs:259-265
- Problem: F8: Repeated brief results are rendered repeatedly
- Trigger: Force OnTradeTransaction into a brief, then repeat it and its lowercase spelling later in the same batch.
- Fix: Mark the result key as seen after emitting a brief, without marking unprinted section notes as seen.
- Log: 20261021232039-5e5962
- Why skipped: labelled GAP by the reviewer; harm: Repeated text consumes the response budget and can displace other answers.

## G8 · fixed · 2026-10-21 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: -
- Problem: F9: The new find implementation has no test coverage
- Trigger: Run the project's existing tests for this increment.
- Fix: Add find tests covering module loading, names/questions, input normalization, final size limits, preserved signatures, deduplication, and actionable continuations, including regressions for the confirmed defects.
- Log: 20261021232039-5e5962
- Why skipped: labelled GAP by the reviewer; harm: The import failure and the new budgeting, signature, and continuation defects are not detected.

## G9 · fixed · 2026-10-21 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: src/find.mjs:158-159
- Problem: F10: Expansion priority excludes an explicitly requested API
- Trigger: Ask "open a trade using CTrade::Sell" against the current Reference.
- Fix: Rank expansion candidates together with search hits using the original question before selecting the top three.
- Log: 20261021233728-893eb8
- Why skipped: labelled GAP by the reviewer; harm: The requested Sell documentation is excluded from all three results, while Buy is listed instead.

## G10 · fixed · 2026-10-21 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: src/data.mjs:38-46
- Problem: F1: Malformed pointer metadata can reject the startup check
- Trigger: A manually edited or damaged current.json contains JSON null, or an index array such as ["index-a.sqlite"] with schema_version 1.
- Fix: Validate that parsed metadata is a non-null object and index is a string before accessing or joining it; return the existing setup error for invalid metadata.
- Log: 20261021235203-0c8067
- Why skipped: labelled GAP by the reviewer; harm: The server can terminate instead of returning recovery instructions and retrying after setup.

## G11 · fixed · 2026-10-21 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: src/server.mjs:55-57
- Problem: F2: The read tool lacks its required evidence rule
- Trigger: A client presents the mql5_read tool description to the agent.
- Fix: Add a short sentence requiring claims to be supported by returned text and continuation before relying on omitted content.
- Log: 20261021235203-0c8067
- Why skipped: labelled GAP by the reviewer; harm: That description does not independently instruct the agent to ground claims in returned text, as DESIGN.md section 4 requires.
