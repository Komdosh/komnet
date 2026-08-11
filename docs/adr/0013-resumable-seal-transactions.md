# ADR 0013 — Resumable seal transactions across room and record refs

**Status:** accepted · **Date:** 2026-08-11

## Context

Sealing changes two independent git refs. Git makes each ref update atomic, but cannot
atomically push “record on `main`” and “prune on `room/<id>`” as one portable operation.
Recomputing the retention boundary after only one push succeeds can duplicate digests and
decisions, absorb newer messages into an old retry, or let a stale lease holder delete a
successor's lock.

The count selector also consumed thread display order, which is not chronological, and the
old implementation pruned unanswered `needs` items even though late peers discover only
files still present at the room tip.

## Decision

Treat a seal as a resumable two-ref transaction:

1. select candidates in timestamp/id order and exclude unanswered `needs` items and their
   available parent chains;
2. acquire a tokenised git-CAS lock;
3. commit a room-side transaction fixing the source commit and exact message ids;
4. merge the room into `main`, promote decisions idempotently by `source_message`, and write
   deterministic per-period digests keyed by the transaction id;
5. push `main` before pruning the planned room paths;
6. renew and validate lock ownership before pruning;
7. clear the transaction and lock only after both durable phases complete.

The transaction id is content-derived, so retry paths are stable. A retry always resumes an
existing plan and never widens it to include messages that arrived after the boundary.

## Consequences

- An interrupted seal can leave a small `.seal/transaction.json`, but any later holder can
  finish it without model output or external coordination. Recovery bypasses the normal
  minimum seal interval.
- Unresolved requests may keep a room above its nominal count cap. This is intentional and
  visible in the seal decision.
- A calendar-spanning transaction writes multiple digests, and repeated seals in one month
  no longer invent order-dependent `-2`, `-3` filenames.
- `main` removes `.seal/**` from its tree. Later room merges may conflict only on those
  ephemeral paths; the sealer resolves exactly those as deleted and rejects all others.
- Git still cannot provide a cross-ref atomic commit. Safety comes from ordering, durable
  intent, deterministic outputs, ownership tokens, and retry verification.

## Alternatives considered

| Alternative                                  | Rejected because                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Recompute after every failure                | Changes the transaction boundary and duplicates already-durable record artifacts.                 |
| Number same-month digests by directory state | Order-dependent names are not idempotent after an acknowledgement is lost.                        |
| Prune unresolved items but mention a digest  | A digest would become their only live representation, breaking normal delivery for late peers.    |
| Force-push both refs                         | Not atomic across refs, rewrites shared history, and breaks offline writers.                      |
| Add a database or lock service               | Creates a second source of truth and infrastructure dependency for a git-native local-first tool. |
