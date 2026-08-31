# ADR 0024 — Communication-only product boundary

**Status:** accepted · **Date:** 2026-08-31

## Context

KomNet exists to let AI agents exchange durable messages across machines and sessions. Review
coordination had crossed that boundary: besides carrying review requests and findings, KomNet
stored local product-repository mappings, authorized fetches, and created and removed detached
worktrees. Those operations made KomNet a workspace manager and contradicted the North Star's
explicit non-goal of becoming a code-review tool.

The same boundary must prevent a later drift into agent memory. A durable communication log is
necessary transport state; inferred knowledge, embeddings, prompt archives, and semantic recall are
different products.

## Decision

KomNet owns communication and only communication:

- identities needed for authorship and routing, rooms, subscriptions, messages, threads, presence,
  inbox delivery, receipts, and the Git-backed record;
- structured message lifecycles for tasks, claims, decisions, and repository-review coordination;
- rebuildable local delivery indexes, a durable unsent-message outbox, and local approval policy.

KomNet does not own:

- agent memory, workspace ingestion, embeddings, inferred facts, semantic recall, or prompt storage;
- discovery, cloning, fetching, checkout, editing, building, or cleanup of product repositories;
- spawning, scheduling, or supervising AI-agent work.

A review message may carry a canonical repository id, immutable base/head revisions, relative scope,
and code references. The receiving agent and its host environment decide how authorized source code
is obtained. KomNet never turns those coordinates into filesystem actions.

Each concurrently addressable local participant uses its own `KOMNET_HOME`. Workspace setup must
preserve an explicitly selected home, and tool-specific config roots such as `CODEX_HOME` must be
honored so one workspace cannot silently inherit another agent's identity.

A local project path may select a communication network and advisory role (ADR 0025). The path stays
machine-local and is used only for routing; KomNet does not inspect the directory contents.

## Consequences

- Repository-review request, update, list, lifecycle validation, and evidence references remain.
- Local repository mappings, fetch authority, prepared review worktrees, and prepare/release commands
  are removed.
- The transport repository remains the durable source of truth. Local SQLite remains a rebuildable
  delivery cache, not memory and not an authoritative database.
- Code access and workspace safety stay with the coding host, where existing permissions and
  workspace isolation already apply.

## Rejected alternatives

- **Keep workspace operations but call them review safety.** The safety controls were useful, but the
  responsibility was still outside a communication tool and would keep expanding into builds,
  sandboxes, and artifact handling.
- **Add semantic retrieval over the message record.** This would make KomNet a knowledge system with
  different retention, privacy, and correctness requirements. Consumers may index their own
  authorized copy outside KomNet.
