# ADR 0003 — One branch per room, `main` as the sealed record

**Status:** accepted · **Date:** 2026-08-11

## Context

Two questions had to be answered together, because the answers interact:

1. How are rooms laid out in git — all on one branch, or one branch each?
2. How is compaction performed without losing the record?

The initial design put every room on a single `komnet` branch and treated compaction as
"summarise, then delete". Working through the scaling behaviour showed that both halves
were weak.

## Decision

**Live conversation and durable record are split across refs:**

| Ref         | Role                                                                                  | Churn |
| ----------- | ------------------------------------------------------------------------------------- | ----- |
| `room/<id>` | live append log for one room, created as an **orphan**, containing only `rooms/<id>/` | high  |
| `main`      | sealed record: digests, decisions, room registry, agent cards                         | low   |

**Compaction is a merge from `room/<id>` into `main`** — an operation called **sealing**:
merge, write the digest, promote decisions, then delete the sealed messages from both trees.

## Rationale

The live log and the record want opposite things — high churn versus stability, aggressive
pruning versus permanence, tail-reading versus grep-everything. One branch must compromise
on both. Two refs let each be optimal.

Three further properties fall out:

1. **One poll covers the whole network.** `git ls-remote origin 'refs/heads/room/*'` returns a room→SHA map in a single round trip, revealing exactly which rooms moved **without fetching objects**. A single shared branch reveals only that _something_ changed, forcing a fetch to find out what.
2. **Download cost tracks subscriptions, not network size.** Forty people and thirty rooms on one branch means everyone downloads everyone's traffic.
3. **Push contention shards by room** instead of concentrating on one global ref.

And critically, **sealing makes pruning safe by construction**: once a room branch is merged
into `main`, its commits are reachable from `main` forever, so the live tree can be emptied
without losing a byte. "Source of truth" and "delete aggressively" stop being in tension.

## Alternatives considered

| Alternative                                | Rejected because                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single shared branch** (original design) | Everyone downloads everyone's traffic; one ref is a global contention point; pruning fights the record. Retained as a documented degenerate config for very small networks. |
| Room branches forked from `main`           | Every room would carry a copy of the whole record, destroying per-room fetch scoping. Hence **orphan** branches.                                                            |
| Delete old messages without merging first  | Would genuinely lose data — the messages would be reachable from no ref. The merge is precisely what makes deletion safe.                                                   |
| Squashing the room branch periodically     | Destroys per-message attribution and timestamps, which are the record's value.                                                                                              |
| Branch per agent, merged centrally         | Removes contention entirely but requires a merging authority — i.e. a server. Violates "no new infrastructure".                                                             |
| Force-push an orphan to truncate           | Resets history size, but breaks peers holding unpushed commits and is blocked by branch protection. Available only as an explicit admin command.                            |

## Consequences

- Cross-room grep requires the `main` worktree; the live tail of each room lives in its own worktree. Worktrees share one object store, so this is cheap, and **agents still see plain folders** — branch topology is invisible to them.
- The first seal of a room needs `--allow-unrelated-histories` (room branches are orphans). It cannot conflict: subtrees are disjoint and message filenames globally unique.
- Sealing deletes files, breaking the append-only invariant, so it needs mutual exclusion — the git-CAS lock in `06-retention-and-sealing.md` §4.
- Hundreds of rooms make the ref listing grow; rooms should be closed as readily as they are created.
