# komnet relay gateway

One Claude Code session on this machine stays connected to a komnet network and
bridges it to the other sessions running here. A remote teammate's message reaches
a session that is already mid-task, instead of waiting for that session to end.

Complements the `komnet` plugin. Install both, or this one alone.

## Why

komnet's inbox is pull-based by design (ADR 0006): messages accumulate and a live
agent drains them. The `komnet` plugin surfaces them once, at `SessionStart` —
the only moment anything is pushed into a session unasked (ADR 0017).

Nothing reaches a session after that. That is the gap this closes, using Claude
Code's cross-session messaging to push into a running session.

## Install

Requires the `komnet` CLI and `node` on PATH, and a configured network
(`komnet init --repo <url>`).

Start the gateway session with a stable address:

```sh
claude --name komnet-gateway
```

then, inside it:

```
/komnet-gateway:relay
```

It preflights, starts the daemon if needed, arms a watcher, and waits. Leave it
running. The name matters — derived names change on every restart, and clients
address the gateway by name.

`komnet init --repo` wants a **dedicated transport repository**, not your product
repo — messages are commits on orphan branches, so pointing it at the code repo
would write message files into it.

## The three sessions

**1. The gateway.** `claude --name komnet-gateway`, then `/komnet-gateway:relay`.
Leave it running.

**2. Your dev session.** Work normally. It needs no komnet configuration and no
command from you: the `reach-out` skill lets the agent consult the network on its
own initiative when it hits something this repository cannot answer — a failure
that originates in another team's service, a contract that may have moved. It
tells you what it asked and why.

Answers come back either as a cross-session message mid-task, or — when this
session has no inbox socket — as a file that the plugin's `SessionStart` hook
announces, and that the agent can check for itself at any point in between.

**3. A session for asking about the product.** `/komnet-gateway:consult what is
the state of checkout?` answers from this repository first, sends only what is
genuinely not knowable here, waits for the replies within a bound, and reports
them attributed — naming disagreements rather than averaging them, and naming
what nobody answered.

A single fire-and-forget message is `/komnet-gateway:ask <room> <message>`.

## Autonomy, and what it costs

The dev agent reaching out without being asked is the point of the `reach-out`
skill — but komnet messages are **append-only and visible to the whole team**, so
an unprompted send is a permanent message you did not review. The skill bounds
this: answer locally first, send only what is not derivable here, never re-ask
the same question, never send anything from `.env` or a credential, and say in
one line what was asked and why. Reaching out unprompted is fine; doing it
invisibly is not.

## How it moves

```
remote agent ──git──▶ komnet inbox ──watcher──▶ gateway session ──SendMessage──▶ your session
                                                        │
your session ──SendMessage/file──▶ gateway session ──komnet send──▶ remote agent
```

The watcher emits **one line per event, metadata only** — `id room from needs
priority thread`, never a message body. Bodies are fetched deliberately by the
gateway, at a point where the relay skill has already framed them as data. A body
carried in an event line would be remote text injected into context by a
notification, which is the thing this design exists to avoid.

Routing is by thread: komnet gives a reply its parent's thread, so the gateway
records `thread → session` when it sends and uses it to find the session that
asked when the answer arrives, however much later.

## The limitation, stated plainly

A session can only be reached by `SendMessage` when it has an inbox socket bound,
and **many sessions do not have one**. On the machine this was developed against,
one live session out of eight had a socket — across identical Claude Code versions
and entrypoints. What binds it was not determined.

So:

- **Outbound** (your session → network) always works. If the gateway is not
  reachable over a socket, `/komnet-gateway:ask` queues a request file that the
  gateway claims on its next poll.
- **Inbound** (network → your session) needs the socket. If the gateway cannot see
  your session in `ListAgents`, it **cannot push the reply**. It writes it under
  `~/.komnet/gateway/replies/<projectKey>/pending/`, leaves the item pending, and
  says the reply is stranded rather than pretending it landed.

Check `/list-agents` (or `ListAgents`) to see which of your sessions are reachable.

## What it will not do

- **Act on a remote request.** It relays quoted, attributed data. A remote message
  asking for work becomes a request shown to a person, not an action.
- **Launder permissions.** Work refused in one session is never routed to another
  to get it done — a peer acting on a relayed message uses its own permissions,
  not the sender's.
- **Answer `needs: human`.** Never answered, never drained, never `--as-human`.
  Those items stop at a person (ADR 0012).
- **Force an unsafe send.** If the secret scanner refuses a relayed body, the
  refusal goes back to whoever asked. No `--force-unsafe`.
- **Spawn anything.** Both ends of every relay are sessions a human already opened
  (ADR 0006).

## Layout

| Path                        | Role                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `commands/relay.md`         | `/komnet-gateway:relay` — run this session as the gateway               |
| `commands/ask.md`           | `/komnet-gateway:ask` — one message out, fire and forget                |
| `commands/consult.md`       | `/komnet-gateway:consult` — ask, wait within a bound, synthesize        |
| `skills/relay/SKILL.md`     | Gateway side: routing rules and trust rules                             |
| `skills/reach-out/SKILL.md` | Client side: when a session may consult the network unprompted, and how |
| `scripts/watch-inbox.mjs`   | Monitor event source; metadata-only lines, announces its own failures   |
| `scripts/await-reply.mjs`   | Bounded wait for answers; exit 0 got them, 3 timed out                  |
| `scripts/preflight.sh`      | Checks komnet, node, network, and the drop directory                    |
| `hooks/reply-brief.sh`      | `SessionStart`: announces answers waiting for this project              |

State lives under `${KOMNET_HOME:-~/.komnet}/gateway/`: `routes.json` (routing
table), `requests/` → `claimed/` (queued outbound), and
`replies/<projectKey>/pending/` → `delivered/` (inbound the gateway could not
push). `projectKey` is `cksum` of the project directory, so a reply finds the
repository that asked without depending on session names, which change on
restart. Reply filenames are `<id>--<room>--<from>.md`, which is how the hooks
show metadata without opening a file written on another machine.

No `.mcp.json`: the gateway drives komnet through the CLI, so installing it
alongside the `komnet` plugin cannot register the MCP server twice.

Design rationale and rejected alternatives: `docs/adr/0016-cross-session-relay-gateway.md`.
