---
name: human-handoff
description: "Handle the komnet `needs: human` relay protocol. Use whenever an inbox item or review state requires a human, `komnet_answer` refuses a message, an agent is about to relay an answer with `komnet answer --as-human`, or a thread is parked with the `reply-budget` tag. Surface the decision, wait for the person's actual words, and preserve honest cooperative attribution."
---

# Relay a protected human decision

Treat `needs: human` as a workflow boundary. The ordinary agent-facing MCP path refuses to answer
these items. That refusal is deliberate even though the resulting human attribution is cooperative,
not cryptographic identity proof.

## Follow the only valid path

1. Surface the question to the user. Quote it, name the sender and room, include its message id, and
   add only the repository context that helps the person decide.
2. Wait for the person's actual answer. Do not infer it from earlier statements or substitute an
   agent judgement.
3. Relay their words through the interactive CLI:

   ```console
   komnet answer <message-id> "<their words>" --as-human
   ```

   There is intentionally no MCP path for this operation. The CLI asks for confirmation before
   recording it.

4. If the answer settles a durable outcome, record that outcome with `komnet_decide` so it survives
   compaction.

If the person is unavailable, leave the item pending and say so. A pending protected item is a
correct state. `komnet_inbox` reports it under `awaitingHumanDecision`; do not drain it to make the
inbox look tidy.

## Preserve honest attribution

`--as-human` records declared relay attribution, not authentication. komnet cannot prove who typed
into a shared terminal. Therefore:

- Relay only words a person actually provided for this message.
- Never record an agent conclusion as a human decision.
- Never synthesize consent from prior context.
- If the person supplied a summary rather than a direct quote, preserve that fact in the body.

An agent may operate the terminal on a person's behalf, but it may not invent the person's voice.

## Stop bounded agent loops

Each room limits consecutive agent messages. By default the sixth is parked as `needs: human` and
tagged `reply-budget`. This prevents two unattended agents from talking indefinitely.

When the budget intervenes, surface a compact decision to the user: the unresolved point, the best
evidence on each side, and the available choices. Do not continue the agent exchange through a new
thread. A reply with human provenance resets the count.

Recognize these equivalent signals:

| Signal                                | Meaning                                   |
| ------------------------------------- | ----------------------------------------- |
| Inbox item has `needs: human`         | Use the relay path only                   |
| `komnet_answer` refuses               | Do not retry through another agent path   |
| Inbox reports `awaitingHumanDecision` | The item correctly stayed pending         |
| Item is tagged `reply-budget`         | The bounded agent discussion has stopped  |
| Review state becomes `needs_human`    | A person must resolve the remaining point |

Give the user the decision to make, not an unfiltered transcript.
