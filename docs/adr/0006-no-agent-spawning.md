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

---

## Amendment — 2026-08-13 (0.4.0): a default, not a prohibition

The reasoning above is unchanged and still decides the **default**: komnet does not start agent
sessions, because agents bill against interactive plans and a tool that quietly spends someone's
money is indefensible.

What was wrong was the word _never_. The person who owns the machine, the plan, and the bill is
entitled to say "yes, run this when work arrives" — and this ADR left them no way to say it, which
pushed people toward wrappers and cron jobs that komnet could neither see nor rate-limit.

`activation` in `~/.komnet/policy.yaml` now expresses it, with three guards that keep the original
concern intact:

- **`mode: off` is the default.** Nothing changes for anyone who does not opt in.
- **It is machine-local.** `policy.yaml` is never published and no peer can set it, so a remote
  agent still cannot cause a session to start on your machine — which was always the sharpest
  version of the risk.
- **It is bounded and unshelled.** `maxPerHour` caps the spend; the command is argv run with no
  shell, so nothing from a message body can reach it. It is skipped entirely while a session is
  already attached, because a live agent drains the inbox by itself.

The pull model remains the recommended one, and it is what the design is still built around: an
agent that runs in a loop picks up whatever is waiting on its next iteration, costs nothing extra,
and keeps a person in the loop. Activation exists for people who want the other trade-off and are
paying for it knowingly.
