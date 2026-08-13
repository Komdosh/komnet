# ADR 0020: Machine-local policy, and human approval for inbound work

- **Status:** accepted
- **Date:** 2026-08-13

## Context

komnet had no place for a person to say how their own agent must behave. The three files that look
like candidates are all the wrong shape:

- `~/.komnet/config.yaml` is rewritten by komnet itself on `room join`, `room leave`, `repo map`,
  and every daemon subscription change, and rewriting round-trips through the YAML serialiser. Any
  comment or ordering a person adds is destroyed by their next `komnet room join`.
- `.komnet/policy.yaml` **inside the transport repository** is network-wide and shared (spec §8).
- `rooms/<id>/room.yaml` is per-room and shared.

The last two are agreed by the team; a rule about how one person's agent behaves on one person's
machine is not the team's decision to make, and — the load-bearing point — must not be settable by
a remote peer.

Meanwhile the collaborative-task and repository-review features let any agent on the network delegate
work to any other. A peer's request arrived and this agent could claim it and begin, with the human
who owns the machine, the working tree, and the subscription plan finding out afterwards. Work an
agent originates for itself has no such problem: nobody else asked for it.

## Decision

Add `~/.komnet/policy.yaml`: a machine-local file komnet **reads and never writes**, so hand-written
comments survive. `komnet policy` prints the effective values and which files produced them;
`komnet policy --init` writes a commented starting point. Unknown keys are a parse error rather than
being ignored — the file exists to constrain an agent, and silently dropping a misspelled key would
leave a person believing a limit is in force when it is not.

It carries `approvals.inboundWork` (`never` | `remote` | `always`, default `remote`) and
`approvals.localAgents`. Claiming a task, or claiming a delegated repository review, is refused with
`ApprovalRequiredError` (exit code 4, IPC code `APPROVAL_REQUIRED`) when the work was delegated by a
remote agent. A person clears it with `komnet task approve` / `komnet review approve`, which records
the decision in `networks/<id>/approvals.json` — local, per piece of work, never published.

Three boundaries make it coherent:

**Only claiming is gated.** Claiming is where this agent commits to doing something for somebody
else. Answering questions, reporting progress, and finishing work already accepted are not gated: a
control that fired on every message would be switched off within a day, and it would contradict the
north star, where agents answer each other without a human retyping anything.

**Origin is decided from local data only.** `self` is local; anyone else is remote until named in
`localAgents`. The tempting signal — the peer's agent card declaring the same human — is written by
the machine it describes, so a peer could declare itself local and walk through the gate that exists
to keep its requests under a person's control.

**Approving is not reachable from MCP.** The `komnet_policy` tool is read-only so an agent can
explain the rule it just hit; there is no tool to approve or to edit policy. An agent that can
approve its own inbound work is a gate that gates nothing.

## Alternatives rejected

**A section in `config.yaml`.** One fewer file, but komnet rewrites that file, so the user's comments
and structure disappear on the next room join. A file people are told to edit must be one the tool
never writes.

**Storing approvals in `state.db`.** It is already the local index and would have been free. But it
is a cache whose every row is derivable from git, and a `SCHEMA_VERSION` bump discards it wholesale —
so a routine schema change would have silently revoked every decision a person had made. An approval
is derivable from nothing.

**Publishing approvals to the network.** It would make "this was approved" visible to the requester,
which sounds helpful. It also invites other agents to read a local permission as authority, and it
would let a remote peer see — or attempt to satisfy — a gate whose entire purpose is local control.

**Reusing `needs: human`.** That marker routes a _question_ toward a person through the shared log
and is cooperative attribution, not authentication (ADR 0012). This is a local refusal to act, needs
no wire representation, and must not be satisfiable by anything a remote writes. Conflating them
would have put a local access decision on the network.

**A flag on the claim (`--approved-by-human`).** Smaller, and consistent with the `--as-human` relay.
But an agent can add a flag to its own command, so it would have recorded an assertion rather than
enforced a gate. A separate local act is at least an act, and it leaves an auditable record on the
machine that made the decision.

**Defaulting to `never` to preserve existing behaviour.** Rejected because the safe default is the
one a person would choose if asked, and the cost of the other default is unbounded: an agent acting
on a remote request nobody reviewed. `never` remains one line away for teams that want full
autonomy.

## Consequences

- Cross-machine delegation now pauses at the receiving end by default. Teams that had agents claiming
  each other's work autonomously must set `inboundWork: never`, or list their peers in `localAgents`.
- The pause costs latency exactly where the north star says latency is acceptable — a human being in
  the loop — and nowhere else: questions, answers, progress, and decisions are untouched.
- Nothing about this is on the wire, so no protocol change and no spec amendment. A peer running an
  older build is unaffected, and cannot tell whether the gate is on.
