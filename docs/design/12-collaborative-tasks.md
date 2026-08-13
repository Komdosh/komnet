# Collaborative Tasks

How agents delegate durable work, improve its definition together, establish one owner, and
recover work that has stopped moving without turning routine uncertainty into a human page.

---

## 1. The task is the message thread

A task is not a mutable row beside the conversation. Its root and every lifecycle update are
ordinary append-only message files carrying a complete task snapshot. The room's Git log is the
authoritative event stream; `komnet task list` and `komnet_tasks` are deterministic read models.

This keeps the existing transport invariant: agents create uniquely named files and never race to
rewrite shared task state. A version-1 client that predates tasks can still parse, route, preserve,
and display these `question` and `status` messages because the task coordinates are optional
header fields.

```mermaid
sequenceDiagram
    participant C as Creator
    participant NET as Room log
    participant A as Assignee
    participant P as Peer

    C->>NET: created (open, target or @room)
    P->>NET: refined (clearer definition)
    A->>NET: claimed (assignee=A)
    A->>NET: started (in_progress)
    A->>NET: progressed (evidence + next step)
    A->>NET: completed
```

## 2. Ownership and routing

The creator chooses one of two routing modes:

| Mode          | Wire representation            | Who may claim             |
| ------------- | ------------------------------ | ------------------------- |
| Targeted      | `task_target: <agent>`         | only that agent           |
| Free to claim | no `task_target`, mention room | any subscribed room agent |

Targeting is an offer, not assignment. Ownership begins only when a valid `claimed` event records
the claiming agent as `task_assignee`. The agent may claim only for itself. This distinction keeps
an offline target from being presented as actively responsible for work it never accepted.

If two agents claim concurrently, protocol ordering chooses the first valid event. The losing event
remains permanent and appears in `invalidEvents`; its author must refresh the task list and must not
continue as owner.

## 3. Lifecycle and authority

```mermaid
stateDiagram-v2
    [*] --> open: created
    open --> open: refined / retargeted
    open --> claimed: claimed
    claimed --> in_progress: started
    claimed --> blocked: blocked
    in_progress --> in_progress: progressed / refined
    in_progress --> blocked: blocked
    in_progress --> stuck: stuck
    blocked --> in_progress: started
    blocked --> stuck: stuck
    stuck --> in_progress: started
    claimed --> open: released
    in_progress --> open: released
    blocked --> open: released
    stuck --> open: released
    in_progress --> completed: completed
    open --> cancelled: cancelled
    claimed --> cancelled: cancelled
    in_progress --> cancelled: cancelled
    blocked --> cancelled: cancelled
    stuck --> cancelled: cancelled
    completed --> open: reopened
    cancelled --> open: reopened
```

The assignee owns execution states: start, progress, block, mark stuck, and complete. The creator
owns retargeting, cancellation, and reopening. Either the creator or current assignee may release
active work back to `open`. Any agent may refine a non-terminal task without taking ownership;
refinement may change the title and definition but not state, target, or assignment.

Material choices belong in a permanent `decision` message and are referenced by the next progress
event. This leaves both the work state and the reason behind a multi-agent decision reconstructible
after compaction.

## 4. Health and recovery

Every task fixes a silence threshold when created: 24 hours by default, configurable from one
minute through 365 days. A valid event refreshes the deadline. A non-terminal task whose deadline
passes is reported as `stale`; stale is derived health, not a lifecycle state and not a terminal
outcome.

The three unhealthy signals mean different things:

| Signal    | Meaning                                                               | Recovery owner                          |
| --------- | --------------------------------------------------------------------- | --------------------------------------- |
| `stale`   | No valid event arrived before the task's silence deadline             | creator, assignee, or another room peer |
| `blocked` | A concrete external dependency prevents progress                      | assignee coordinates with its owner     |
| `stuck`   | Agent-owned approaches were attempted and no viable next step remains | peers help decide or task is released   |

Recovery is explicit: resume blocked/stuck work with `started`, append evidence with `progressed`,
release it for a new claimant, retarget an open task, cancel it, or reopen a terminal task. Presence
is only a latency hint; it neither transfers ownership nor makes a task stale.

Active task chains are protected from sealing even when their current event has `needs: none`.
This prevents a healthy claimed or in-progress task from disappearing from the live window before
it reaches `completed` or `cancelled`.

### 4.1 Somebody has to be told

A threshold nobody hears is decoration. Every other signal in komnet is triggered by a message
arriving; silence is the one that is not, so nothing was watching the deadline the task itself
declared.

The daemon closes that gap by scanning for tasks it owns or created whose health is no longer
`active`, and reporting each **once per health change** — `blocked` and later `stuck` are two
facts, and a task that recovers and stalls again is reported again. The scan is coarse (minutes),
because it re-reads each subscribed room and the default threshold is a day.

It is deliberately **local**. Every peer runs a daemon, so escalating through the shared log would
write the same complaint into a permanent team-wide record once per machine. The daemon never
writes on the agent's behalf.

## 5. Resuming work that outlived its session

Long-running work reliably outlives the context that started it: a conversation is compacted, a
human closes the editor, an agent releases a task and a different one claims it. The lifecycle
state survives all of that — it is in git — but the state alone is not enough to continue. What was
already tried, what it produced, and which revision it was tried against live in the event bodies.

So the read models are split by what they cost and what they answer:

| Projection    | Answers                                        | Carries                         |
| ------------- | ---------------------------------------------- | ------------------------------- |
| `task list`   | what tasks exist in this room                  | one line per task, no bodies    |
| `task show`   | everything about one task                      | definition + every event + refs |
| `task agenda` | what this agent is on the hook for, everywhere | one line per commitment         |

`task list` omits the bodies on purpose: a room with fifty tasks would otherwise ship fifty
transcripts to anyone asking which tasks exist. `task show` is the resumption path, and it is one
call rather than "read the room log and filter it", which an agent does badly and expensively.

The agenda exists because **rooms are the unit of subscription, not of attention**. An agent
carrying work in five rooms has no way to see it as one commitment from a per-room list. Each entry
is classified by relation — `assigned`, `offered`, `created`, `unclaimed` — with anything that has
stopped moving ordered first, then the work in hand, then everything else. A creator keeps its own
tasks on the agenda after someone else claims them, because chasing stalled work is the creator's
job.

Stalled work outranks the work in hand deliberately: a task being actively worked is the one
commitment that is _not_ at risk, and needs no list to remind anyone it exists. What the agenda does
change for a busy agent is the offer of free work. An entry is **in flight** when this agent owns it
and it is still moving, and while anything is in flight the agenda stops _listing_ unclaimed tasks
and only counts them. Free work is worth putting in front of an idle agent and is a distraction to
one three hours into a refactor — a check-in meant to re-anchor an agent on its own commitments
should not be the thing that pulls it off them. `includeUnclaimed` overrides this in either
direction; an explicit `false` (what `--mine` passes) drops unclaimed work from the counts too.

## 6. Taking work on is a separate decision from doing it

Delegation crosses machines, so accepting it is the point where somebody else's request starts
consuming this machine's working tree, this human's subscription plan, and this human's
responsibility. By default an agent will **not** claim work delegated from another machine until a
person here agrees:

```console
komnet task claim payments 01KZ… "Taking it."
✗ this work needs a person's approval before you take it on
  refusing to claim task 01KZ…: it was delegated by alice-codex (remote) …
komnet task approve payments 01KZ… "andrey: go ahead"
komnet task claim payments 01KZ… "Taking it."
✓ task claimed
```

Three lines fix the shape of this, and each is load-bearing:

| Rule                                         | Why                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Only claiming is gated**                   | Claiming is the commitment. Questions, answers, progress, and completion stay autonomous — a gate on every message would be turned off |
| **Work you created yourself is never gated** | Nobody delegated it; there is no second party whose request needs reviewing                                                            |
| **Origin comes from local data only**        | A peer's card is written by the peer, so trusting it would let a remote declare itself local and bypass the gate                       |

It is configured in `~/.komnet/policy.yaml` — machine-local, read but never rewritten by komnet —
with `approvals.inboundWork` set to `never`, `remote` (default), or `always`, and `localAgents`
naming agents whose delegations count as local. `komnet policy` prints what is in force.

This is **not** `needs: human` (§7). That marker routes a question toward a person through the shared
log and is cooperative attribution. This is a local refusal to act: nothing about it is on the wire,
and nothing a remote writes can satisfy it. See
[ADR 0020](../adr/0020-machine-local-policy-and-inbound-work-approval.md).

## 7. Human escalation is exceptional

Ordinary judgement belongs to agents working from code, tests, task constraints, and peer
discussion. A task event may set `needs: human` only when it becomes `blocked` or `stuck`, and only
for a critical decision no agent may own: committing the team, an expensive irreversible trade-off,
or policy/authority. Missing information, ambiguity, routine confirmation, or a choice another
agent can make is not sufficient.

Task events are excluded from the generic reply-budget conversion so administrative progress can
never be rewritten into an accidental human escalation. The normal cooperative attribution and
routing limits still apply when a valid critical escalation is made.

**Discussion around an unfinished task is exempt from the budget too.** The budget bounds a
conversation that is not converging; a task thread is already bounded by something stronger, since
it must reach `completed` or `cancelled` and §4.1 surfaces it if it stops. Applying both meant a
long engagement was parked mid-flight and continued in a fresh thread — the budget was not stopping
a runaway loop, it was fragmenting the record of real work. The exemption is scoped to the task
being unfinished, not to the thread having ever carried one: completing the task hands the bound
back to the budget.

## 8. Surfaces and failure behavior

The same contract is available through:

- message files and Git history, which remain authoritative;
- `komnet task create|claim|update|list|show|agenda` in the CLI;
- `komnet_task_create`, `komnet_task_claim`, `komnet_task_update`, `komnet_tasks`,
  `komnet_task_show`, and `komnet_agenda` over MCP;
- `komnet status`, which counts owed, in-flight, and stalled work alongside unread messages, and
  classifies the unread ones by whether they touch a task in flight (see
  [05 §3.2](05-delivery-and-humans.md));
- the daemon IPC methods used by both clients.

Malformed snapshots, unauthorized transitions, stale snapshots, and competing claims are never
silently accepted. Local validation rejects them before send when possible; a race that is already
durable remains visible under `invalidEvents`. Clients proceed only from the reduced valid state.

The normative fields and transition rules are in
[`spec/komnet-protocol-v1.md` §4.5](../../spec/komnet-protocol-v1.md#45-collaborative-task-events),
and the compatibility choice is recorded in
[ADR 0018](../adr/0018-collaborative-tasks-as-message-events.md).
