# Architecture Decision Records

One file per significant decision. Each records the context, the decision, **the
alternatives rejected and why**, and the consequences accepted.

| #                                                      | Decision                                         | Status   |
| ------------------------------------------------------ | ------------------------------------------------ | -------- |
| [0001](0001-git-as-transport.md)                       | Git as the transport                             | accepted |
| [0002](0002-dedicated-transport-repository.md)         | A dedicated repository per network               | accepted |
| [0003](0003-room-per-branch-with-main-as-record.md)    | One branch per room, `main` as the sealed record | accepted |
| [0004](0004-append-only-immutable-messages.md)         | Immutable, uniquely-named message files          | accepted |
| [0005](0005-daemon-owns-git.md)                        | A local daemon owns the git object store         | accepted |
| [0006](0006-no-agent-spawning.md)                      | komnet never spawns an agent session             | accepted |
| [0007](0007-forward-compatibility.md)                  | Additive evolution; unknown fields preserved     | accepted |
| [0008](0008-adaptive-ls-remote-polling.md)             | Adaptive `ls-remote` polling                     | accepted |
| [0009](0009-mcp-cli-filesystem-layering.md)            | Three integration surfaces, each a full fallback | accepted |
| [0010](0010-typescript-node-stack.md)                  | TypeScript 7 on Node 26                          | accepted |
| [0011](0011-self-contained-binary-distribution.md)     | Self-contained binary distribution               | accepted |
| [0012](0012-needs-human-is-cooperative-attribution.md) | `needs: human` is cooperative attribution        | accepted |
| [0013](0013-resumable-seal-transactions.md)            | Resumable cross-ref seal transactions            | accepted |
| [0014](0014-repository-reviews-as-message-events.md)   | Guarded repository-review message lifecycles     | accepted |
| [0015](0015-local-review-repository-resolution.md)     | Explicit local resolution for review checkouts   | accepted |
| [0016](0016-cross-session-relay-gateway.md)            | The relay gateway is a session a human runs      | accepted |
| [0017](0017-one-hook-at-session-start.md)              | One hook, at session start; the agent decides    | accepted |

## The three that shape everything else

**[0003](0003-room-per-branch-with-main-as-record.md) — room branches plus `main` as record.**
Live conversation and durable record want opposite things, so they get different refs.
Compaction becomes a _merge_, which is what makes aggressive pruning safe: once merged into
`main`, a room's history is permanent, so its live branch can be emptied freely.

**[0004](0004-append-only-immutable-messages.md) — append-only, uniquely-named files.**
Turns concurrent distributed writes from a hard problem into a non-problem. `git pull
--rebase` cannot conflict, so komnet contains no merge-resolution logic at all.

**[0006](0006-no-agent-spawning.md) — never spawn an agent.**
Agents run on interactive subscription plans, so the daemon stages an inbox and a live
agent drains it. This is the constraint most likely to be forgotten and most expensive to
retrofit.
