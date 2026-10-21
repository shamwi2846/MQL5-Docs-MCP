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
