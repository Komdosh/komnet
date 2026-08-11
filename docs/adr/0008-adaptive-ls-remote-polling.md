# ADR 0008 — Adaptive `ls-remote` polling for change detection

**Status:** accepted · **Date:** 2026-08-11

## Context

The daemon must notice remote changes within a reasonable time while costing nothing when
idle, and must work on every git host — including behind NAT, with no inbound connectivity
and no hosted component.

## Decision

Poll `git ls-remote origin 'refs/heads/room/*'` on an **adaptive cadence**, fetching only
when a subscribed room's SHA has changed.

| State    | Trigger                                              | Interval |
| -------- | ---------------------------------------------------- | -------- |
| `HOT`    | message in a subscribed room within 5 min            | 10 s     |
| `WARM`   | activity within 1 h, or an unanswered `needs: human` | 30 s     |
| `COOL`   | activity within 24 h                                 | 2 min    |
| `IDLE`   | quiet over 24 h                                      | 10 min   |
| `PAUSED` | no network, asleep, or low battery                   | —        |

Immediate poll and jump to `HOT` on: a local send, **an agent session opening**, or explicit
`komnet sync`.

## Rationale

`ls-remote` asks for ref names and SHAs and **transfers no objects** — ~2 KB for thirty
rooms, one round trip. Under protocol v2 the ref prefix is filtered server-side.

Because rooms are separate refs (ADR 0003), **one call reveals exactly which rooms moved**,
so a fetch happens only when there is genuinely something to fetch.

Idle cost lands at roughly 3–12 MB/day and no CPU between polls — low enough that nobody
turns it off, which is the real requirement. Git-protocol traffic is also not metered
against the REST rate limits agent tooling usually worries about.

Waking to `HOT` when a session opens matters more than it looks: because agents are guests
(ADR 0006), the moment a human opens their agent is the moment freshness has value.

Backoff is exponential with **full jitter**. Without jitter, every machine on a team polls
in lockstep after a shared outage.

## Consequences

- Worst-case idle latency is 10 minutes. Acceptable, and stated in the docs so nobody expects chat.
- The cadence state machine needs cross-invocation memory — a reason for the daemon (ADR 0005).
- Poll cost grows linearly with room count; hundreds of rooms make the listing noticeable, so dead rooms should be closed.
- Optional accelerators (host API conditional requests, webhooks) may be layered on, but **the baseline must work without them**.

## Alternatives considered

| Alternative                           | Rejected because                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `git fetch` on a timer                | Transfers objects every cycle regardless of change — orders of magnitude more expensive for the same information.      |
| Webhooks as the baseline              | Need a reachable endpoint; laptops behind NAT cannot receive; would force a hosted component.                          |
| Host REST API polling as the baseline | Different per host, rate-limited, needs a token beyond git credentials. Fine as an accelerator, wrong as a foundation. |
| Fixed 60 s interval                   | Too slow mid-conversation, too costly when idle. The state machine is a few dozen lines and fixes both ends.           |
