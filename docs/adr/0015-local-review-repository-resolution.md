# ADR 0015 — Review repositories resolve through explicit local mappings

**Status:** superseded by [ADR 0024](0024-communication-only-product-boundary.md) · **Date:** 2026-08-11

## Context

A repository-review task carries a canonical repository id and immutable base and head
objects. Those portable coordinates are not enough to safely choose a checkout on another
machine. Automatic filesystem search can select a same-named fork, a clone command received
from a peer can exfiltrate credentials, and checking out the requested revision in an
engineer's working tree can overwrite or hide uncommitted work.

The resolver also needs bounded disk use and deterministic cleanup. A review may be retried,
the requested objects may be absent while the machine is offline, and an agent may leave notes
or edits in its generated checkout that must not be deleted silently.

## Decision

Repository resolution is machine-local and opt-in. `~/.komnet/config.yaml` maps each canonical
`host/owner/repository` id to the absolute root of an existing Git worktree. komnet does not
scan for repositories and does not clone one automatically. Shared messages never select a
path, remote, credential, or command.

When a mapping is created, komnet verifies that the path is a worktree root. If the selected
Git remote has a conventional parseable URL, its canonical identity must match the configured
id. A mapping has no fetch authority by default. Setting `fetchRemote` to a local Git remote
name explicitly authorizes `git fetch --no-tags <name>` when either immutable commit object is
missing; the remote URL still never comes from the review message.

Only the declared reviewer may prepare or release a review checkout. Preparation verifies
both full commit objects, records whether the base is an ancestor of the head, and creates a
detached worktree at `~/.komnet/reviews/<review-id>/checkout`. The checkout is pinned to the
requested head and Git hooks are disabled for worktree creation. The engineer's mapped
worktree, branch, index, and uncommitted files are not changed.

Preparation and release are serialized by a local lock. Repeating preparation for the same
immutable task reuses the verified checkout. `review.maxPreparedWorktrees` bounds concurrent
prepared checkouts and defaults to one. Normal release refuses a dirty generated checkout;
only cleanup of a failed, not-yet-returned preparation may force-remove its generated path.

## Consequences

- A peer can identify code portably without gaining control over another machine's filesystem
  or Git remotes.
- Missing revisions fail closed while fetching is disabled. Enabling fetch is a deliberate
  local configuration change rather than a prompt hidden in a message.
- Reviews inspect the exact head object without disturbing the engineer's current branch or
  uncommitted work.
- Diverged base/head coordinates are reported explicitly instead of silently changing the
  diff target.
- Generated worktrees consume disk until released, so the local cap and clean-only release are
  operationally visible rather than implicit garbage collection.
- A local-path remote cannot prove portable identity. In that case the explicit mapping is the
  trust decision; conventional HTTPS, SSH, or scp-style remotes add an identity cross-check.

## Alternatives considered

| Alternative                         | Rejected because                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Search common workspace directories | Ambiguous repository names and forks can select the wrong code without notice.   |
| Clone a URL carried by the task     | Lets untrusted shared data choose destinations, credentials, and disk use.       |
| Fetch from `origin` automatically   | Unexpected network and credential use; `origin` may not be the intended remote.  |
| Reuse the engineer's current tree   | Checkout or reset would interfere with branches, index state, and local changes. |
| Force-delete every review checkout  | Can destroy reviewer notes or artifacts that were not yet reported.              |
| Copy the repository per review      | Duplicates objects and is slower than a detached Git worktree.                   |
