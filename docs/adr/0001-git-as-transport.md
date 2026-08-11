# ADR 0001 — Git as the transport

**Status:** accepted · **Date:** 2026-08-11

## Context

AI coding agents on separate developer machines need to exchange messages. Each agent holds
deep local context that never leaves its machine, so today the humans act as a lossy relay:
they read one agent's answer and retype it into another's prompt.

Constraints from the outset: the storage must be **privately controlled by the team**, work
across GitHub / GitLab / Bitbucket / self-hosted, be **easy to set up**, and serve as the
durable **source of truth** for decisions.

## Decision

**Use a git repository as the message transport.** Messages are files, rooms are folders,
git history is the log. No server, no broker, no database, no hosted component.

## Rationale

Git is not chosen for elegance but because it is _already present and already trusted_:

- **Already authenticated** — every dev machine already has push access to a private remote; the credential problem is solved.
- **Already private and self-controlled** — the team picks the host; nothing leaves infrastructure they chose.
- **Already replicated** — every participant holds a full copy; the network survives host outages.
- **Already has history** — immutable, attributable, timestamped. The message log _is_ the audit log, not a second system to keep in sync.
- **Already has a UI** — any member can read a room in a browser without installing anything.
- **Already understood by agents** — every coding agent can read files and run git, so the fallback path needs no integration at all.

## Alternatives considered

| Alternative                            | Rejected because                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted coordination service            | Someone must run, secure, pay for, and trust it. Company context would leave team-controlled infrastructure. Explicit non-starter.               |
| Slack / Discord bridge                 | Not durable as a record; agents read it poorly; needs a bot and tokens; history is a vendor's asset.                                             |
| Direct agent-to-agent over MCP/network | Requires reachability between laptops (NAT, VPN, always-on peers). Agents are not always on, and messages sent to a closed peer are simply lost. |
| Shared filesystem / Dropbox            | No history, no atomicity, no review, no granular access control.                                                                                 |
| Database (hosted or embedded)          | Unreadable without the tool; not diffable or reviewable; needs hosting.                                                                          |
| Matrix / XMPP                          | Real protocols, but need a server and give no durable, greppable record of decisions.                                                            |

## Consequences

**Accepted costs:**

- **Latency is seconds-to-minutes, never milliseconds.** komnet is explicitly not real-time chat.
- **Read access is all-or-nothing per repository** — no per-room confidentiality (see ADR 0002).
- **Erasure is hard** — history is append-only, so personal data must be kept out entirely.
- **Repo growth must be actively managed** — hence sealing (ADR 0003, `06-retention-and-sealing.md`).

**Gained:**

- Zero infrastructure to operate.
- Audit, attribution, and review for free.
- The record survives the tool: uninstall komnet and the repository still reads as a complete conversation.
