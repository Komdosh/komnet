# ADR 0006 — komnet never spawns an agent session

**Status:** accepted · **Date:** 2026-08-11 · **Supersedes:** the auto-invocation model in the initial design sketch · **Amended by:** [ADR 0017](0017-one-hook-at-session-start.md) — the `Stop` hook named below was withdrawn; `SessionStart` is the only hook. The decision here is unchanged.

## Context

The first sketch had the daemon react to an incoming message by invoking a headless agent
(`claude -p`, `codex exec`) so the network could work while humans were away.

This was wrong. **AI coding agents run on interactive subscription plans.** Headless
invocation is billed differently or unavailable, so the design assumed a capability many
users do not have — and would have spent their money without asking.

## Decision

**komnet never spawns an agent session.** No `claude -p`, no `codex exec`, no headless
invocation of anything, by default.

The control flow inverts. komnet does not push work _into_ an agent; it **stages** work
and lets a live agent **drain** it:

- the daemon accumulates an inbox continuously, at near-zero cost, whether or not any agent exists;
- when a human opens their agent, it drains the inbox via MCP or CLI;
- editor hooks (`SessionStart`, `Stop`) surface pending items **inside the session the human already opened**;
- an OS notification tells the _human_ that something is waiting.

Auto-invocation survives only as strictly opt-in per-room configuration for users who have
real API credit, rate-limited, labelled as separately billed. **No feature depends on it.**

## Rationale

- **Cost honesty.** A tool must never incur billing the user did not ask for.
- **Availability.** Headless modes are not universally available; Cursor has no equivalent at all. Depending on them would break "AI-agnostic".
- **Safety.** Auto-spawned agents act with nobody watching. Everything komnet carries — architecture, decisions, production reasoning — deserves a human in the path.
- **Simplicity.** No process supervision, no prompt injection into spawned sessions, no runaway loops between two auto-replying agents.

## Consequences

**Accepted cost — stated plainly:**

> **End-to-end latency is poll interval + when the human next opens a session.** A message
> can sit for hours. This is what human-in-the-loop costs.

Which makes several things necessary rather than optional:

- **Presence** is a real feature: a sender must know whether a peer is live now or asleep until tomorrow.
- **Notification quality matters** — it is the only mechanism that gets a human to open a session. A noisy tool gets muted, and a muted tool is dead.
- **Editor hooks are the highest-value integration**, because they ride a session that already exists.
- **Sealing cannot depend on a model.** Digests are written deterministically, with an optional narrative contributed later by a live agent (`06-retention-and-sealing.md` §5).
- **The inbox is durable and explicit.** Draining is idempotent and acknowledged, so an interrupted session loses nothing.

## Alternatives considered

| Alternative                                      | Rejected because                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Headless invocation as default                   | Assumes API billing many users lack; spends money silently; runs unattended agents.   |
| Bundle a small local model for auto-replies      | Answers would lack the workspace context that makes an agent's reply worth having.    |
| A hosted agent that always listens               | Reintroduces the server and sends company context off-machine — contradicts ADR 0001. |
| Require the daemon to keep an agent session warm | Not possible: editors own their session lifecycle, and a warm session still bills.    |
