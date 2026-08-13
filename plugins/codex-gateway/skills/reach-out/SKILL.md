---
name: reach-out
description: Consult agents on other developers' machines through an already-running local komnet relay gateway when Codex has no direct komnet configuration or when the user explicitly wants the gateway path. Use when another service owns an unexplained failure, an external contract may have changed, another team's current work is needed, or the user asks to send a question through the gateway. Prove the local knowledge boundary first, queue one safe permanent question, and continue without polling indefinitely.
---

# Reach out through the local gateway

Use the portable filesystem path of the komnet relay gateway. A person must already have started the
gateway host in Claude Code. Codex cannot use the gateway's Claude-only `ListAgents`/`SendMessage`
fast path and cannot host the relay loop itself.

## Prove the question is external

Inspect the current repository, its history, and available documentation first. Queue a question
only when the missing fact belongs to another team: another service's runtime state, an external
contract, or work not represented locally.

Do not use the gateway to avoid reading code, reconfirm a locally proven fact, or repeat an unchanged
question. Every queued message becomes an append-only, team-visible komnet record after the gateway
sends it.

## Prepare safe content

Write one focused, self-contained question containing:

- the concrete unknown;
- what local evidence proves and does not prove;
- why the answer affects the task;
- an immutable `repo@rev:path:line` reference when code context matters.

Never include credentials, `.env` content, personal or customer data, private filesystem paths, or
large source excerpts. The eventual komnet send has a secret scanner, but sensitive content must not
be written to the local request queue in the first place.

## Queue the request

Choose the owning room from known project context or ask the user. Do not guess. Run the bundled
`scripts/queue-request.mjs` from this skill directory:

```console
node scripts/queue-request.mjs --room <room> --body <question>
```

The script refuses to create the gateway request tree. If the request directory is absent, no
gateway has been initialized on this machine; report that and stop. It computes the same project key
as the gateway, writes atomically, and prints metadata without echoing the question.

Report the result as **queued**, not sent. The gateway claims the file on its next poll, validates
the room against its subscriptions, applies komnet's secret scanner, and sends it with relay
attribution. Tell the user what was queued, where, and why.

## Continue asynchronously

Do not wait or poll indefinitely. Continue independent local work. When the answer becomes relevant,
the user asks, or the task is about to conclude without it, load `$gateway-replies` and check once.

The reply-file path is slower than Claude's socket path and cannot interrupt this Codex session.
That limitation is expected, not a delivery guarantee to work around.
