# ADR 0014 — Repository reviews as guarded message-event lifecycles

**Status:** accepted · **Date:** 2026-08-11

## Context

An engineer may ask their local agent to delegate a repository review to another agent.
The remote reviewer must know exactly which repository and revisions to inspect, report
findings back to the requesting agent, and allow the two agents to clarify findings before
either involving a person or presenting the result. Ordinary free-form messages do not say
who owns closure, whether a report is final, or when concurrent replies diverge.

The workflow also crosses compaction. Treating the initial request as an ordinary unanswered
question would preserve even completed reviews forever, while pruning an active review whose
latest status has `needs: none` would remove live work.

## Decision

Represent a review as a linear append-only lifecycle on an ordinary room thread. Every event
repeats an additive set of review header fields: task id, participants, canonical repository,
immutable full base/head object ids, optional relative scope and deadline, and current state.
Version-1 readers preserve these fields under the existing forward-compatibility rule.

The reviewer owns claim, work, report, and blocked states. Either participant may discuss or
request a cooperative human handoff. The requester alone completes, expires, cancels, or
retries a blocked task. `reported` is the explicit findings handoff; `completed`, `expired`,
and `cancelled` are terminal.

State is derived from the shared log, not stored in a second authoritative database. Events
must form one direct reply chain. When concurrent siblings exist, protocol order chooses the
first valid child; losing events remain visible as conflicts and do not freeze later progress.

The room reply budget counts only repeated `discussing` events for that review. Administrative
states do not consume the discussion allowance. The last permitted discussion becomes a
cooperative `needs_human` handoff. Active valid review chains are protected from sealing;
terminal chains are eligible for normal compaction.

## Consequences

- A request is self-contained and pinned to immutable code, so aliases, branch movement, and
  local checkout state cannot silently change the review target.
- Agents can exchange findings before interrupting a person, but the requester remains the
  single closure owner.
- A malformed or concurrent event is auditable without becoming a permanent task-level
  denial-of-service.
- The event header repeats coordinates on every message. This costs a small amount of text
  but makes every sealed event independently interpretable.
- Repository discovery and checkout safety are local execution policy, defined by
  [ADR 0015](0015-local-review-repository-resolution.md). The shared contract carries identity
  and revisions; it never carries a local path, credential, or command.

## Alternatives considered

| Alternative                          | Rejected because                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Free-form question and answer        | Cannot derive ownership, completion, conflicts, or a bounded discussion.         |
| Mutable task file                    | Reintroduces concurrent-write conflicts and violates append-only message rules.  |
| Central task database                | Creates a second authority and removes the git-native interoperability property. |
| Reviewer marks its own work complete | Conflates “findings sent” with “requester accepted and integrated the result.”   |
| Local repository paths on the wire   | Leak machine layout and are meaningless or unsafe on another computer.           |
| Silently choose or delete a conflict | Hides evidence and lets concurrency rewrite task history.                        |
