# ADR 0012 — `needs: human` is cooperative attribution, not authorization

**Status:** accepted · **Date:** 2026-08-11 · **Supersedes:** the strict-enforcement claim in ADR 0009

## Context

An agent and its human normally run under the same OS account. A shell-capable agent can
allocate a pseudo-terminal, invoke `komnet answer --as-human`, or call the core API with a
confirmation callback. A TTY prompt can prevent accidental or non-interactive attribution,
but it cannot prove that a person supplied the answer.

Claiming otherwise turns a useful workflow convention into a false security boundary.

## Decision

Treat `needs: human` as a **cooperative workflow signal**:

- route it to the human-facing inbox and notifications;
- keep it pending instead of allowing an ordinary inbox drain;
- refuse it on the ordinary MCP and daemon answer paths;
- allow the interactive CLI to relay a person's answer with `author_kind: human`;
- describe `author_kind: human` as asserted provenance, never authenticated human identity.

An AI agent may perform the relay on behalf of its human after receiving the human's
decision. The operating guide tells it not to substitute its own judgement, but kom-net does
not claim that this instruction is technically enforceable.

## Consequences

- `--as-human` remains an explicit, visible confirmation step that catches accidents.
- Audit records distinguish agent judgement from a claimed human-relayed decision.
- Consumers must not treat `author_kind: human` as proof of human approval.
- SSH signatures can authenticate the agent key that wrote a message, not the person who
  directed that agent.
- A stricter guarantee would require a separately authenticated human approval channel.

## Alternatives considered

| Alternative                                        | Rejected because                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Claim the TTY prompt proves human presence         | Agents can allocate and control pseudo-terminals.                                                       |
| Remove the human marker and allow ordinary answers | Loses useful routing, escalation, and declared provenance.                                              |
| Add a separate approval service now                | Introduces identity, credential, UI, and availability dependencies outside the project's current scope. |
