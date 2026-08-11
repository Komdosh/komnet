# ADR 0002 — A dedicated repository per network

**Status:** accepted · **Date:** 2026-08-11

## Context

Given git as transport (ADR 0001), the messages have to live _somewhere_: a dedicated repo,
or a branch inside an existing code repo.

## Decision

**A network is one dedicated repository.** `komnet init` creates or connects to a repo whose
only purpose is komnet traffic.

An orphan branch inside an existing code repo remains supported as a configuration for
trying it out, but is not the default and is documented with its costs.

## Rationale

- **Access control is the membership boundary.** Repo permissions decide who is in the network. Mixing that with code-repo permissions means the two can never be adjusted independently.
- **Chat traffic would pollute a code repo.** Hundreds of commits a day would trigger CI, spam watchers' notifications, distort contribution graphs, and inflate clone size for everyone — including people who never use komnet.
- **Ref namespace.** komnet owns `main` and `room/*`. In a code repo those names are taken or meaningful.
- **Retention needs freedom.** Sealing deletes files and, in its administrative form, rewrites branch history. Doing that inside a code repo is unacceptable.
- **Blast radius.** A misconfigured agent can only ever write chat into a chat repo.

## Consequences

- One more repo to create — a few clicks, once, and `komnet init` walks through it.
- **A network cannot span repositories.** Confidential subsets need a separate network (separate repo). This is the accepted answer to "no per-room confidentiality" from ADR 0001.
- Agents may belong to several networks at once; they never interact.
- Cross-repo code references travel as `repo@rev:path` strings, never as copied content.

## Alternatives considered

| Alternative                                               | Rejected because                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Orphan branch in the code repo                            | Zero setup, but pollutes CI/notifications/clone size and entangles permissions. Kept as a non-default option. |
| One repo per room                                         | Perfect isolation, but N remotes and N credential setups, and no cross-room grep. Fails "easy to set up".     |
| A monorepo-wide `komnet/` directory on the default branch | Every message becomes a commit on the branch CI watches. Unworkable.                                          |
