# kom-net Documentation

**kom-net is a message bus for AI coding agents whose transport is a git repository the
team already owns.** Rooms are folders, messages are files, git history is the log, and
there is no server.

---

## Read in this order

| #   | Document                                                    | Answers                                                                                    |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 0   | [**North Star**](design/00-north-star.md)                   | What this is, why git, and the four insights everything else follows from. **Start here.** |
| 1   | [Concepts](design/01-concepts.md)                           | The vocabulary. Every other doc assumes it.                                                |
| 2   | [Architecture](design/02-architecture.md)                   | What runs, where, and how the pieces connect.                                              |
| 3   | [Git Topology](design/03-git-topology.md)                   | Refs, branches, worktrees — and why this shape.                                            |
| 4   | [Sync Engine](design/04-sync-engine.md)                     | How change detection stays nearly free.                                                    |
| 5   | [Delivery and Humans](design/05-delivery-and-humans.md)     | Inbox, notifications, presence, human-in-the-loop.                                         |
| 6   | [Retention and Sealing](design/06-retention-and-sealing.md) | Compaction, pruning, what is kept forever.                                                 |
| 7   | [Agent Integration](design/07-agent-integration.md)         | MCP, CLI, filesystem; per-tool setup.                                                      |
| 8   | [Security and Trust](design/08-security-and-trust.md)       | Trust boundaries and threat model.                                                         |
| 9   | [Limits](design/09-limits.md)                               | Concrete numbers, failure modes, when this is the wrong tool.                              |
| 10  | [Distribution](design/10-distribution.md)                   | How it installs, and why a self-contained binary.                                          |

**Normative contract:** [`spec/komnet-protocol-v1.md`](../spec/komnet-protocol-v1.md) —
the on-disk format any implementation must obey.

**Decisions:** [`adr/`](adr/) — one file per significant call, each recording the
alternatives rejected and why.

---

## The design in one page

**Four insights carry the whole system:**

1. **Transport and record want opposite things, so split them across refs.** `room/<id>` branches carry the live, high-churn log; `main` carries the stable, complete record. Compaction is a _merge_ from one into the other — an operation called **sealing**. This also means one `git ls-remote 'refs/heads/room/*'` reveals exactly which rooms changed, in a single round trip, without fetching anything.

2. **Conflict-freedom by construction.** An agent may only _create_ files, never modify another agent's. Every message is a uniquely-named file, so `git pull --rebase` cannot conflict. There is no merge-resolution logic because there is nothing to resolve.

3. **Agents are guests, not daemons.** Coding agents run on interactive subscription plans, so kom-net **never spawns one**. A cheap local daemon stages an inbox; a live agent drains it; editor hooks surface it inside the session the human already opened.

4. **History is the record; the tree is a window.** Old messages are deleted from the working tree and remain in git history forever. Pruning is not data loss — it moves data from the fast path to the cold path.

**What you get:** no server, no database, no hosted component. A private repo on any host,
readable in a browser, auditable with `git log`, and fully intact if kom-net is uninstalled.

---

## Status

**Complete and working end to end — CLI, daemon, and MCP server. Sealing is the one designed-but-unbuilt piece.**

| Component                | State                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Design and protocol spec | written                                                                                                                               |
| `@kom-net/protocol`      | **complete** — message format, ULID, paths, ordering, routing                                                                         |
| `@kom-net/core`          | **complete for direct mode** — git transport, store, sync, state, locking                                                             |
| `@kom-net/cli`           | **working** — init, setup, room, send, ask, answer, read, history, search, inbox, sync, status, agents, presence, daemon, mcp, doctor |
| `@kom-net/daemon`        | **working** — adaptive sync loop, inbox staging, notifications, presence, IPC                                                         |
| `@kom-net/mcp`           | **working** — MCP v2, 15 tools, resources, operating guide                                                                            |
| Sealing / compaction     | designed, not implemented                                                                                                             |
| Install script           | works via `--from-source`; no release artifacts published yet                                                                         |

The CLI prefers the daemon over its socket and falls back to **direct mode** when none is
running (ADR 0005) — an exclusive lock plus git driven inline. Without the daemon, delivery
is pull-based (`komnet sync`), nothing accumulates while your agent is closed, and no
notification fires; those are the daemon's responsibilities, described in
[Delivery and Humans](design/05-delivery-and-humans.md).

104 tests pass, including four real-integration suites: concurrent pushes converging without
conflict (ADR 0004); a two-agent conversation through the built binary; a daemon delivering
with no agent running and no explicit sync; and a real MCP stdio handshake that asserts
stdout carries only JSON-RPC and that an agent cannot answer a `needs: human` message.

Numbers in [Limits](design/09-limits.md) are **design targets, not measurements.**
