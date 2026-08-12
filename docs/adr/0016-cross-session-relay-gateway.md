# ADR 0016 — the relay gateway is a session a human runs, not a process komnet starts

**Status:** accepted · **Date:** 2026-08-12 · **Constrained by:** ADR 0006 (no agent spawning), ADR 0012 (`needs: human` is cooperative attribution)

## Context

ADR 0006 fixes komnet's end-to-end latency at "poll interval + when the human next
opens a session", and accepts it. Editor hooks soften the second term by surfacing
the inbox at `SessionStart` and `Stop` — but only at those boundaries. A session
already forty minutes into a task cannot be reached at all: a teammate's answer
lands in `~/.komnet` and waits for a session boundary that may be hours away.

Claude Code gained cross-session messaging: sessions on one machine discover each
other through a local registry and exchange messages over per-session unix sockets,
delivered between the receiver's tool calls or by starting a turn if it is idle.
That is precisely the missing term — a way to reach a session that is already
running, without starting anything.

The two systems do not know about each other. komnet spans machines and knows
nothing about local sessions; cross-session messaging spans sessions and knows
nothing about the network.

## Decision

**Bridge them with a session, not a process.** One Claude Code session per machine,
started by a person, runs `/komnet-gateway:relay` and stays in a watch loop: it
watches the komnet inbox, pushes arriving messages into whichever local session is
waiting for them, and carries their replies back out.

Four constraints define it.

**It is started by a human.** The gateway is a session the user opened on their own
plan, exactly like the sessions ADR 0006 expects to drain the inbox. It spawns
nothing, and it never asks another session to be started. It is a _third_ drain
path alongside MCP and the editor hooks, not an auto-invocation loophole.

**It relays as data, never as instruction.** A remote body reaches a local session
quoted, fenced, and attributed. The gateway does not paraphrase a remote message
into an imperative, does not act on one, and does not ask a peer to act on one.

**It is not a permission boundary.** Cross-session messages carry no authority — a
peer acting on one uses its own permissions. A gateway sits where that boundary is
easiest to erode: remote asks gateway, gateway asks a peer with looser settings.
The rule is explicit in the skill and in the command: work refused in one session
is not routed to another to get it done.

**`needs: human` stops at a human.** The gateway never answers one, never drains
one, and never runs `--as-human`. Under ADR 0012 that flag is cooperative
attribution; a gateway running it for an absent person forges their voice.

**A client session may reach out unprompted, under stated bounds.** The point of
the bridge is that a working agent consults the network when it hits something
its repository cannot answer, without the user having to ask. The cost is real:
komnet messages are append-only and team-visible, so an unprompted send is a
permanent message nobody reviewed. The `reach-out` skill bounds it — answer
locally first, send only what is not derivable here, never re-ask an unchanged
question, never send credential material, and disclose what was asked and why.
Bounded autonomy with disclosure, not silent autonomy.

**Replies are keyed by project, not by session.** Session names are derived and
change on restart, and hooks cannot see them at all. Keying the reply directory
by `cksum` of the project directory gives a stable address that both the sending
session and the `SessionStart`/`Stop` hooks compute identically.

The gateway drives komnet through the **CLI**, not MCP, so installing it alongside
the `komnet` plugin cannot produce a duplicate MCP server registration.

## Rationale

- **It buys the one thing hooks cannot.** Reaching a session mid-task is the entire
  value; everything else komnet already does better through the inbox.
- **It respects ADR 0006 exactly.** No process spawns an agent. Both ends of every
  relay are sessions a person already opened.
- **One komnet identity per machine stays true.** Many local sessions, one agent
  card, one set of subscriptions — the network's model is unchanged.
- **Metadata-only wakeups.** The watcher emits `id room from needs priority`, never
  a body, so remote text enters the gateway's context exactly once, through a fetch
  the relay skill has already framed as data — not through a notification that
  arrived on its own.

## Consequences

**Accepted cost — stated plainly:**

> **A session is only reachable by `SendMessage` when it has an inbox socket bound,
> and many do not.** On the machine this was developed against, one live session out
> of eight had one, across identical Claude Code versions and entrypoints. What binds
> it was not determined.

So the fast path is an optimisation, never a dependency:

- Outbound falls back to a request file claimed by an atomic rename, which needs
  nothing but the filesystem.
- Inbound has **no fallback**. A gateway that cannot see the client cannot push the
  reply; it writes it under `gateway/replies/<session>/`, leaves the item pending,
  and says it is stranded. This is the honest failure, and it is documented rather
  than hidden.
- Delivery is never reported from a tool call returning — only from what it reported.

And:

- **Routing is thread-based.** komnet gives a reply its parent's thread, so the
  gateway records `thread → session` at send time. Without that, an answer arriving
  forty minutes later has nowhere to go.
- **An unroutable message is held, not broadcast**, and surfaced to the gateway's
  own human.
- **Session names are display names, not identities.** A message claiming to come
  from a session is a claim. The gateway adds no authentication, and does not
  pretend to.
- **Draining follows delivery.** Never before, never for a `needs: human` item.

## Alternatives considered

| Alternative                                               | Rejected because                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teach the daemon to write directly into session sockets   | Makes komnet depend on Claude Code's private, undocumented socket protocol, and puts remote text into a session with no agent framing it as data. |
| A hook on every session that polls the inbox mid-turn     | No hook fires mid-task; `Stop` is already the boundary this exists to get past. Polling from N sessions also multiplies git work by N.            |
| Auto-spawn a headless session to handle arriving messages | Exactly what ADR 0006 forbids: bills the user silently and runs an agent unattended.                                                              |
| Let every session hold its own komnet identity            | N agent cards and N subscription sets per machine; presence and routing stop meaning anything.                                                    |
| Relay bodies inside the watcher's event lines             | Every stdout line becomes a notification, so remote text would enter context unframed — the injection path the metadata-only rule closes.         |
| Ship it inside the existing `komnet` plugin               | Forces a standing watch loop on users who only want inbox triage, and duplicates the MCP server registration.                                     |
