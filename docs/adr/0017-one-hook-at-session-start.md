# ADR 0017 — one hook, at session start; the agent decides after that

**Status:** accepted · **Date:** 2026-08-12 · **Amends:** the hook mechanism described in ADR 0006 and ADR 0016 (their decisions stand; only the per-turn hook is withdrawn)

## Context

ADR 0006 fixed the delivery model: komnet never spawns an agent, so it stages work and a live
agent drains it. Editor hooks were called the highest-value integration in the system, because
they surface pending messages inside a session the human already opened.

That reasoning was applied to two Claude Code events. `SessionStart` printed the brief once
per session. `Stop` ran after **every turn** — and three surfaces installed it independently:
`komnet setup claude-code`, the `komnet` plugin, and the `komnet-gateway` plugin. Installing
the plugins together meant two `SessionStart` and two `Stop` hooks, so every single request
ended with two subprocess spawns.

What those spawns bought was small. `Stop` re-ran `komnet inbox --brief` to compare a count
that usually had not moved; the notify script existed largely to suppress its own output,
firing only when the count grew, precisely because an unconditional message would nag once per
turn forever. A mechanism whose main feature is staying quiet is paying a cost per request to
say nothing.

It was also the wrong actor. The hook knows a count. The agent knows whether a teammate's
answer bears on what it is doing right now — whether it is mid-refactor, or has just finished
the thing that was blocked on that answer.

## Decision

**One hook, at `SessionStart`. No per-turn hook anywhere.**

- `komnet setup claude-code` installs `SessionStart` only, and **prunes** a previously
  installed `Stop` entry so re-running setup repairs an existing install. Pruning matches
  komnet's own `komnet inbox` command and never touches another tool's `Stop` hook.
- Both plugins ship `SessionStart` only. `inbox-notify.sh` and `reply-notify.sh` are deleted.
- Deciding when to look during a session moves to the agent, carried by skills:
  `komnet:inbox` for the inbox, `komnet-gateway:reach-out` for gateway replies. Both name the
  moments that are worth a check — finishing a task, waiting on an answer you asked for, being
  blocked on something another team owns — and both say plainly not to check every turn.

## Rationale

- **Cost is per request; value is not.** A subprocess after every turn to re-read a count that
  changes rarely is the wrong shape, and it is the part a user feels.
- **Relevance needs context the hook does not have.** "Is there mail" is cheap to answer and
  usually uninteresting. "Does this mail change what I do next" is the actual question, and
  only the agent can answer it.
- **`SessionStart` is genuinely different.** It runs once, and it covers the case the pull
  model cannot: everything that accumulated while no agent was running at all. That is the gap
  ADR 0006 opened deliberately, and it stays closed.
- **Fewer duplicate-install traps.** Two plugins plus standalone setup previously stacked six
  hooks; now they stack three, and only at session start.

## Consequences

**Accepted cost — stated plainly:**

> **Nothing tells an agent that a message arrived mid-session.** A teammate's question can sit
> unread for the length of a long session, and if the agent never chooses to look, until the
> next one.

Which makes several things load-bearing rather than optional:

- **The skills are the mechanism now**, not documentation about the mechanism. If their
  descriptions do not trigger, delivery degrades to whenever a session restarts.
- **`SessionStart` carries more weight**, since it is the only unasked push. It stays silent on
  an empty inbox and must never become chatty, or users will disable the one hook left.
- **The relay gateway matters more.** Cross-session push is now the only thing that reaches a
  session mid-task, which is exactly what ADR 0016 built — and its reply-file fallback is now
  announced once at session start rather than after each turn.
- **The daemon's OS notification is unchanged**, and remains the mechanism aimed at the human
  rather than the agent. It is gated hard: `needs: human`, `priority: blocking`, or a direct
  mention with no session live.

## Alternatives considered

| Alternative                                             | Rejected because                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep `Stop`, throttle it (every N turns, or debounce)   | Still a subprocess on the hot path, and the count it reports is still not the question worth answering. Tuning a bad shape does not fix the shape.     |
| Drop every hook, including `SessionStart`               | Loses the one case pull cannot cover — the backlog from when no agent was running. Nothing would ever surface a message unasked, at any point.         |
| Make hooks opt-in, default off                          | A default install would then deliver nothing until configured, which is worse than the problem, and adds configuration surface to explain and support. |
| Have `Stop` read the daemon's state instead of spawning | Cheaper per turn, but still answers "is there mail" rather than "does it matter now", and still pushes a decision the agent is better placed to make.  |
| Emit a `UserPromptSubmit` hook instead                  | Same per-request cost, and worse placement: it injects into the user's turn rather than reporting at the end of the agent's.                           |
