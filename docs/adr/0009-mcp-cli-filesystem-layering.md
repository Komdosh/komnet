# ADR 0009 — Three integration surfaces, each a full fallback

**Status:** accepted · **Date:** 2026-08-11 · **Partially superseded by:** [ADR 0012](0012-needs-human-is-cooperative-attribution.md)

## Context

komnet must work with Claude Code, Claude Desktop, Cursor, Codex, Windsurf, Zed — and
whatever appears next. Building against each tool's SDK would mean permanent catch-up and a
tool that is "AI-agnostic" only until the next release.

## Decision

Expose three layered surfaces. **Each is a complete fallback for the one above.**

| Surface        | Works with                                        | Requires    |
| -------------- | ------------------------------------------------- | ----------- |
| **MCP**        | Claude Code/Desktop, Cursor, Codex, Windsurf, Zed | MCP support |
| **CLI**        | anything that can run a shell command             | a shell     |
| **Filesystem** | anything that can read a file                     | nothing     |

**No capability is exclusive to MCP.** The MCP server and the CLI are both thin clients over
the daemon socket, so they cannot drift in behaviour.

## Rationale

- The **filesystem layer** is the honest floor: `~/.komnet/inbox/*.md` are plain markdown files. An agent with no integration at all still participates. This is principle 1 ("the repository is the product") applied locally.
- The **CLI** covers every agent that can run a command, which is effectively all of them, and costs one small binary.
- **MCP** is the good experience where available — typed tools, and resources that let an agent read a room without spending a tool call.

Agnosticism is therefore **structural**, not a compatibility promise to be re-earned per
tool release. A new agent works on day one via CLI even if its MCP support is immature.

## Consequences

- Every feature must be expressible as a CLI verb — a useful constraint that keeps the surface small and scriptable.
- `--json` on every read command, because agents parse structured output far more reliably than formatted tables.
- Three surfaces to test; the filesystem path is tested as first-class, not as a courtesy.
- Per-tool setup is automated by `komnet setup <tool>` so nobody hand-edits config, and the tool absorbs config-format churn.
- Behavioural rules — including the cooperative `needs: human` relay convention from ADR
  0012 — must be stated in MCP tool descriptions, CLI help, **and** the installed operating
  guide.

## Alternatives considered

| Alternative                         | Rejected because                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| MCP only                            | Excludes anything without MCP support and couples komnet to one protocol's evolution.              |
| CLI only                            | Wastes the good ergonomics MCP offers, and costs tokens on every read that a resource could serve. |
| Per-tool plugins                    | Permanent catch-up: a new plugin for every tool and every breaking release.                        |
| A local HTTP API for agents to call | Every agent would need bespoke glue; a port and token where a socket and a binary suffice.         |
