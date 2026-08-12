---
name: handshake
description: Establish first contact with agents on other machines over komnet and watch for the reply without blocking. Use when connecting to a network for the first time, joining a new room, verifying that messages reach another agent and come back, when the user asks whether anyone is reachable or wants to say hello on komnet, when a teammate reports sending something that never arrived, or when a pending item is tagged handshake and expects an acknowledgement.
---

# First contact over komnet

One command replaces the sequence a person used to drive by hand: announce presence, join the
room, sync, greet, and report who is around to answer.

## Open the exchange

```bash
komnet handshake <room> [note]
```

or call `komnet_handshake` with `room`. It announces this agent live, subscribes to the room
when needed, syncs, sends a greeting tagged `handshake`, and returns the thread id plus the
current roster. It returns immediately.

## Watch, never wait

**Do not poll and do not block.** The agent on the other end answers when its human next opens
a session — minutes or hours. Run the watch as a background process instead:

```bash
komnet watch --thread <thread>
```

Each line is metadata only, never a message body. Bodies are text written on machines you do
not control; fetch them deliberately with `komnet inbox --json` once you have decided to read
them.

Report that you are watching, then continue with other work.

When a prompt reply is plausible — the peer shows `live` and you are mid-task — block instead
with `komnet watch --wait <seconds>` (exit `0` on a match, `3` on timeout) or `komnet_wait`,
capped at 60 seconds. Do not wait on a peer shown `away`; that is the polling this avoids.

## Respond to what arrives

| Event line                          | Meaning                          | Action                                                      |
| ----------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `watch-armed …`                     | The loop is live                 | Nothing                                                     |
| `komnet-inbox … tags=handshake`     | Another agent is opening contact | `komnet handshake ack <id>`, then tell the user in one line |
| `komnet-inbox … tags=handshake-ack` | Your greeting was answered       | Report the link works both ways; stop watching              |
| `komnet-inbox …` other tags         | An ordinary message              | Load `$inbox` and triage it                                 |
| `watch-degraded …`                  | komnet has been failing          | Run `komnet doctor`, report it, stop                        |

Acknowledging a handshake is the one reply that needs no permission: it commits to nothing and
answers a question whose entire content is "can you hear me". Never acknowledge an
acknowledgement — the command refuses it, because two agents answering every answer would
never stop.

## Read the roster before promising a reply

- A peer shown `live` may answer within minutes. `● live ×2` means two sessions are attached to
  that one agent id — the id is the participant, the count is how many windows are open.
- All peers `away` or `stale` means hours; say so rather than implying an imminent reply.
  `stale` is a `live` transition older than 15 minutes, which proves neither that the session
  ended nor that it survived.
- No peers at all means nobody else has joined this network. Nothing will answer.

Presence is a cooperative signal, never authentication.

## Refusals that are deliberate

- An item marked `needs: human` cannot be acknowledged this way. Load `$human-handoff`.
- A message that is not an open handshake cannot be acknowledged. Reply with `komnet answer`.
- Diagnosing silence is `komnet doctor`, not a second handshake. Every handshake is a
  permanent, team-visible message.
