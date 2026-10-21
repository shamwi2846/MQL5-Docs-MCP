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
