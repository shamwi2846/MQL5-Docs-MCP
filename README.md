# MQL5-Docs-MCP

A local, read-only MCP server that gives Claude Code and Codex fast, exact answers from the official MQL5 documentation: the MQL5 Reference, the MQL5 book and the neural-networks book. It replaces MQL5-CHM-MCP 1.3.18.

Status: in development. What it will be and why is in [DESIGN.md](DESIGN.md); the evidence and decisions behind it are in [DECISIONS.md](DECISIONS.md).

The documentation itself is MetaQuotes content: it is downloaded from mql5.com onto your own PC and never stored in this repository.

## Development

Requires Node 24.

```
npm ci
npm test
```

`npm run find -- OrderSend "how to read indicator buffer values"` prints exactly what the `mql5_find` tool returns, from the installed index. `npm run docs:update` downloads the documentation again and switches to a new index when it changed; `npm run docs:status` shows the installed version and counts.

The real-docs tests run when `MQL5_DOCS_REFERENCE` points to an unpacked copy of the MQL5 Reference (a folder with `mql5.hhc`, `mql5.hhk` and the pages); otherwise they are skipped.
