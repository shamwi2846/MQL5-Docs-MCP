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

## G12 · fixed · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: src/docs-update.mjs:144-149
- Problem: F3: Check escaped files even when unpacking fails
- Trigger: Unpacking creates a sibling file, then validation of that book or a later book fails.
- Fix: Run the sibling-file detection and removal in a finally block around unpacking.
- Log: 20261022000957-d3a8b8
- Why skipped: pair: both

## G13 · fixed · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: src/docs-update.mjs:242-247
- Problem: F5: Check SQLite integrity before reporting an unchanged index
- Trigger: The downloaded hashes and builder version match the current metadata.
- Fix: Require PRAGMA integrity_check to return ok before taking this return path; otherwise rebuild.
- Log: 20261022000957-d3a8b8
- Why skipped: pair: both

## G14 · fixed · 2026-10-22 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: src/docs-update.mjs:173
- Problem: F6: Report every lost name and card
- Trigger: A candidate loses more than twenty names or cards while passing the baseline checks.
- Fix: Print the complete lost list instead of slicing it.
- Log: 20261022000957-d3a8b8
- Why skipped: pair: both

## G15 · fixed · 2026-10-22 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: tests/docs-update.test.mjs:183-189
- Problem: F1: Exercise losses beyond the former 20-entry cutoff
- Trigger: The loss reporter regresses to printing only the first 20 lost entries.
- Fix: Increase the extra titles from six to at least 21; the existing assertion for every title will then detect the cutoff.
- Log: 20261022004347-9d6bb7
- Why skipped: labelled GAP by the reviewer; harm: Incomplete loss reports can pass the suite, leaving users without the full information needed to accept an update.

## G16 · fixed · 2026-10-22 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: src/setup.mjs:228-234
- Problem: F5: Failed first installation leaves its newly built index behind
- Trigger: A first installation builds its index, then registration fails before current.json exists.
- Fix: Explicitly remove this run's built index when rollback leaves it unreferenced, including when current.json is missing. — test: Fail registration during a first installation and assert that no candidate index, work folder, app folder or owned lock remains.
- Log: 20261022005619-23cb58
- Why skipped: pair: confirmed by B

## G17 · fixed · 2026-10-22 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: .github/workflows/ci.yml:33-39
- Problem: F6: Windows CI implicitly uses PowerShell
- Trigger: GitHub Actions executes the Windows job's run steps.
- Fix: Set defaults.run.shell to cmd for the job.
- Log: 20261022005619-23cb58
- Why skipped: pair: both

## G18 · fixed · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: src/setup.mjs:204-206
- Problem: F9: Check SQLite integrity before reusing an index
- Trigger: Setup evaluates a same-builder index whose hash and schema match but whose SQLite integrity check fails.
- Fix: Require PRAGMA integrity_check to return ok before reusing the index; rebuild if it fails or throws.
- Log: 20261022005619-23cb58
- Why skipped: pair: confirmed by A

## G19 · fixed · 2026-10-22 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: README.md:18
- Problem: F1: Describe registration rollback as best effort
- Trigger: Registration fails and restoring a previous client entry also fails, as exercised by tests/setup.test.mjs:259-271.
- Fix: Say setup attempts to restore previous registrations and reports any restoration failure with instructions to rerun setup.
- Log: 20261022011840-1f77c6
- Why skipped: labelled GAP by the reviewer; harm: The installation instructions promise recovery that setup cannot guarantee.

## G20 · fixed · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: tests/package.test.mjs:26-46
- Problem: F1: Complete the planned npm acceptance scenarios
- Trigger: Use these tests as verification of T1–T4.
- Fix: Add npm cases with both client stand-ins: install from a temporary checkout with spaces and network blocked; run uninstall and purge against separately seeded installations; reject Codex registration after Claude succeeds and verify both previous entries, old files and protected sentinels.
- Log: 20261022012712-18db04
- Why skipped: pair: both

## G21 · open · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: bench/run.mjs:115-151
- Problem: F3: Required benchmark measurements are missing
- Trigger: Run npm run bench as specified by DESIGN.md section 13.
- Fix: Report the required per-case results and measurements, and record first-complete-answer timing when the completion rule succeeds.
- Log: 20261022021247-7897d9
- Why skipped: labelled GAP by the reviewer; harm: The benchmark does not provide the agreed evidence for evaluating the replacement.

## G22 · fixed · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: bench/run.mjs:158-170
- Problem: F4: The comparison does not verify matching documentation versions
- Trigger: Run the default comparison after v2 documentation has been updated independently of the installed legacy corpus.
- Fix: Compare the three source hashes from v2's current metadata and the legacy active manifest before comparing runs; stop on a mismatch.
- Log: 20261022021247-7897d9
- Why skipped: labelled GAP by the reviewer; harm: Documentation changes can be presented as retrieval improvements or regressions.

## G23 · fixed · 2026-10-22 · LOW
- Task: Implement MQL5 Docs MCP v2
- Where: bench/cases.json:76-87
- Problem: F5: The benchmark omits specified hard-case coverage
- Trigger: Use this suite to assess the hard cases required by DESIGN.md section 13.
- Fix: Add hand-checked Create and price cases and an expectation covering ORDER_TYPE_BUY's enum relationship.
- Log: 20261022021247-7897d9
- Why skipped: labelled GAP by the reviewer; harm: The benchmark cannot detect regressions in the omitted behaviors.

## G24 · open · 2026-10-22 · LOW
- Task: -
- Where: DESIGN.md:298
- Problem: The switch rule compares rank 1 and top 3 only in total, so one case can drop from rank 1 to rank 3 while the totals improve (CodeRabbit, PR #1).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: The switch rule is the owner's agreed design; changing it is the owner's call. The bench already reports every case's rank for both servers, and a lower rank costs calls and characters, which the rule caps in total. Raised with the owner.

## G25 · open · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: bench/run.mjs:227-231
- Problem: F1: Complete the remaining benchmark measurements
- Trigger: Run npm run bench to evaluate v2 against DESIGN.md section 13.
- Fix: Include repeated setup/update timings and separately identified cold/warm measurements in the benchmark report.
- Log: 20261022082710-c08a9f
- Why skipped: pair: confirmed by B

## G26 · open · 2026-10-22 · MEDIUM
- Task: Implement MQL5 Docs MCP v2
- Where: bench/run.mjs:175-203
- Problem: F3: Required benchmark timing measurements remain missing
- Trigger: Use npm run bench to evaluate the replacement against DESIGN.md:290.
- Fix: Include repeated setup and docs:update timing measurements and identify cold and warm measurements separately.
- Log: 20261022084215-98a011
- Why skipped: labelled GAP by the reviewer; harm: The report lacks the agreed evidence for assessing installation, updates, and cold versus warm performance.
