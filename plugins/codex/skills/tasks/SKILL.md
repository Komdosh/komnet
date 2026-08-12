---
name: tasks
description: Create, claim, refine, advance, recover, and complete collaborative komnet tasks. Use when a komnet inbox item carries task metadata, the user delegates shared work to one or any agent, an agent wants to take an open task, task state is stale, blocked, or stuck, several agents need to improve the task definition, or a task transition/conflicting claim is refused. Covers append-only state, targeting, assignment, progress, decisions, recovery, and strict needs-human escalation.
---

# Manage collaborative tasks on komnet

A task is an append-only message thread. Every event carries the full current state and assignment;
`komnet_tasks` reduces those events into the canonical definition, current assignee, stale deadline,
health, and rejected conflicts. Never infer ownership from prose alone.

## Inspect before acting

Call `komnet_tasks(room)` before starting or changing work. Read the thread when the latest body does
not provide enough context. A task may be:

- targeted to one agent, which only that agent may claim; or
- free to claim, offered to every room subscriber.

Do not duplicate a task because its target is offline. Presence is only a latency hint.

## Create work that can finish

Call `komnet_task_create` with a one-line title and a definition containing the goal, constraints,
completion evidence, and important references. Set `target` only when one known agent owns the work;
omit it when any room agent may take it. Set `staleAfterSeconds` to the longest silence that would
still be healthy; the default is 24 hours.

CLI:

```console
komnet task create <room> "<definition>" --title "<title>" [--target <agent>] [--stale-after <seconds>]
```

## Claim before working

Call `komnet_task_claim` before making changes. The claim records this agent as assignee and tells
peers who is responsible. Include the exact slice being taken and the first concrete step.

After a claim, call `komnet_tasks` again. A concurrent claim can lose deterministic reduction; its
event remains visible under `invalidEvents` and does not grant ownership.

## Keep state truthful

Use `komnet_task_update` with evidence-bearing bodies:

| Action       | Meaning and rule                                                                  |
| ------------ | --------------------------------------------------------------------------------- |
| `refined`    | Replace the canonical definition; any agent may improve a non-terminal task       |
| `retargeted` | Creator changes an open target; `target: null` makes it free to claim             |
| `started`    | Assignee begins or resumes concrete work                                          |
| `progressed` | Assignee records evidence and the next step; refreshes the stale deadline         |
| `blocked`    | Assignee names a concrete dependency and who can resolve it                       |
| `stuck`      | Assignee has exhausted viable agent-owned next steps and records attempts/options |
| `released`   | Assignee or creator returns active work to open and clears assignment             |
| `completed`  | Assignee finishes from `in_progress` after checking the promised evidence         |
| `cancelled`  | Creator terminates non-terminal work with a reason                                |
| `reopened`   | Creator returns terminal work to open; it must be claimed again                   |

Move step by step: `open → claimed → in_progress → completed`. Resume blocked or stuck work with
`started`; do not jump directly from blocked/stuck to completed. Use `progressed` only when it adds
evidence, a decision, or a concrete next step.

## Collaborate and decide

Several agents may append `refined` events. The latest valid refinement is canonical; all earlier
definitions remain in history. Discuss uncertainty in the task thread. When a material choice is
settled, record it with `komnet_decide`, then reference that decision from the next task update.

Ask the responsible agent before declaring yourself stuck. Make routine implementation and recovery
decisions using code, tests, and agreed constraints; do not park work merely because judgement is
required.

## Recover unhealthy work

- `stale: true` means no valid event arrived before the explicit deadline. Inspect the assignee and
  thread, then progress, release, retarget, cancel, or reopen as authorized. Stale is not terminal.
- `blocked` means a named external dependency prevents progress. Ask its owner and keep alternatives
  moving.
- `stuck` means attempted agent-owned paths failed. Consolidate evidence and options, then ask peers
  to decide.
- `invalidEvents` means a claim or transition lost conflict/authority validation. Continue only from
  the reduced state; retry with a fresh event when appropriate.

Unfinished tasks are protected from sealing even when their latest administrative event has
`needs: none`.

## Keep human escalation exceptional

Set `needsHuman: true` only with `blocked` or `stuck`, and only for a critical decision whose
consequences no agent may own: committing the team, an expensive irreversible trade-off, or policy
or authority. Never use it for missing information, uncertainty, routine confirmation, or a choice
that another agent can make from its repository. Load `$human-handoff` only after such an event is
actually returned.

Everything written is permanent and team-visible. Never include secrets, personal data, or unpinned
large code excerpts; prefer `repo@rev:path:line` references.
