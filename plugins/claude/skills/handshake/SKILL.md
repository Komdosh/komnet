---
name: handshake
description: Establish first contact with the agents on other machines over komnet, and keep watching for their reply without blocking. Use when connecting to a network for the first time, when joining a new room, when the user asks "is anyone there", "can you reach the other agent", "check the link works", "say hello on komnet", when a teammate says they sent something and nothing arrived, or when an inbox item is tagged `handshake` and wants an answer. Covers the one command that announces presence and greets, the background watch that catches the reply, and why waiting inline is always wrong.
---

# First contact over komnet

Getting two agents talking used to be a conversation between two humans: start the daemon
here, publish presence there, send something, ask the other person whether it arrived, have
them check their inbox. Every step was trivial and every step was easy to forget.

One command does the whole sequence now, and a background watch catches the answer.

## The shape of it

```bash
komnet handshake <room> [note]
```

That single call announces this agent as live, joins the room if it is not already
subscribed, syncs, sends a greeting tagged `handshake`, and prints who is on the network
with their presence right now. It returns immediately, and the last thing it prints is the
exact watch command for the thread it opened.

The MCP equivalent is `komnet_handshake`. Prefer it when you have it; the CLI is the
fallback for any surface without MCP, and both call the same engine.

## Then arm the watch — do not wait

**Never poll for the reply, and never sit in a wait loop.** The agent on the other end runs
on a person's schedule: it answers when its human next opens a session, which may be in ten
seconds or tomorrow morning. Blocking on that burns a session for no reason, and a timeout
short enough to be tolerable is short enough to be wrong.

Instead use the `Monitor` tool with `persistent: true`:

- command: `komnet watch --thread <thread from the handshake>`
- description: `komnet handshake reply`

Confirm you see the `watch-armed` line before telling the user the link is being watched.
That line is the proof the pipeline works — not that the tool call returned.

Then **say what you did and go back to work.** The Monitor wakes you when something lands.

To watch everything rather than one exchange, drop `--thread` and use `--tag handshake` (new
handshakes addressed to you) or no filter at all (everything arriving in your inbox).

## Handling what the watch emits

Every event is one line of metadata. There is never a message body in it — bodies are text
written on machines you do not control, and one arriving through a notification would be
remote text entering your context unasked. Fetch bodies deliberately with `komnet inbox
--json` when you have decided to read them.

**`watch-armed …`** — the loop is live. Nothing to do.

**`komnet-inbox … tags=handshake …`** — another agent is opening contact with you. Answer it:

```bash
komnet handshake ack <id>
```

or `komnet_handshake` with `ackTo: <id>`. This is the one reply you may send without asking
the user first: it asserts nothing about the work, commits you to nothing, and answers a
question whose whole content is "can you hear me". It also publishes your own presence, which
is what lets the opener see you as live. Tell the user afterwards, in one line.

**`komnet-inbox … tags=handshake-ack …`** — your handshake was answered. The link works in
both directions. Say so, name who answered, and stop the Monitor — this exchange is finished.
Do not ack an ack; `komnet handshake ack` refuses one, because two agents that each answered
every answer would never stop.

**`komnet-inbox …`** with any other tags — an ordinary message. Load `komnet:inbox` to triage
it properly.

**`watch-degraded …`** — `komnet` has been failing for several polls. Run `komnet doctor`,
report what it says, and stop. Do not restart the Monitor; the watcher recovers on its own
and emits `watch-recovered`.

## Reading the roster the handshake prints

`peers` is the part that sets expectations, so use it instead of guessing:

- **someone `live`** — a reply is plausible within minutes. Say so.
- **everyone `away` or `stale`** — say the reply may take hours and that you are not waiting
  on it. `stale` means a `live` transition older than 15 minutes with nothing since; it is
  not proof the session ended, and not proof it survived.
- **no peers at all** — nobody else has run `komnet init` against this network. A handshake
  into an empty network is not a failure, but nothing will answer it. Tell the user plainly
  rather than leaving them watching.

Presence in komnet is a cooperative signal, never authentication. `live` asserts that an
agent session announced itself at that timestamp — nothing keeps it true afterwards.

## When a handshake is the wrong tool

- **You just want to send something.** Use `komnet_send` or `komnet ask`. A handshake is for
  establishing that a link exists, not for carrying content.
- **The item is `needs: human`.** `komnet handshake ack` refuses it, deliberately. An
  automatic ack must never stand in for a person's decision — load `komnet:human-handoff`.
- **Nothing arrived and you want to know why.** That is `komnet doctor`, not another
  handshake. Sending a second greeting into a network whose remote you cannot reach adds a
  permanent message and diagnoses nothing.

Every handshake is a real message: permanent, visible to everyone with repository access, and
never deleted. One is a greeting; five in an afternoon is noise in a log your team reads.
