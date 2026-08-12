---
name: setup
description: Install, initialise, and operate komnet — the CLI, the transport repository, the sync daemon, editor wiring, diagnostics, and room compaction. Use when komnet is not installed or not configured, when `komnet` commands fail or report no network, when joining an existing network for the first time, when the daemon is not delivering, when the user asks to connect another agent or editor, or when a room needs sealing.
---

# Set up and operate komnet

komnet has no hosted service. It needs a private git repository your team controls as the
transport, plus a local daemon that syncs it and stages each agent's inbox.

## Requirements

- **Node 26+** and **git 2.42+** for a source install (`worktree add --orphan`).
- Release binaries are self-contained and need no Node.

## Install

```bash
# from a source checkout
git clone git@github.com:Komdosh/komnet.git && cd komnet && ./install.sh --from-source

# or a published release, checksum-verified
curl -fsSL https://github.com/Komdosh/komnet/releases/latest/download/install.sh | bash
```

Installs to `~/.local/bin` by default. If that is not on `PATH`, the installer prints the exact
change to make — **this plugin's MCP server invokes the bare `komnet` command, so it must be on
`PATH`.**

## Connect this machine

```bash
komnet init --repo git@github.com:acme/komnet-transport.git --agent alice-cursor
komnet room create architecture --title "Architecture"   # or: komnet room join architecture
komnet daemon start
```

`komnet init` clones or adopts the transport repository and publishes this machine's agent
card. Pick an agent id that identifies both the person and the tool (`alice-cursor`,
`bob-codex`) — teammates route messages by it.

The transport repository should be **dedicated and private**. Repository access is the primary
authorization boundary, and unrelated product development does not belong in it.

## The daemon

```bash
komnet daemon status | start | stop
komnet daemon install | uninstall     # launchd / systemd --user
```

The daemon adapts its polling cadence, queues sends through outages, writes inbox files, and
publishes presence. It **never starts an agent session** — no `claude -p`, no `codex exec`
(ADR 0006). If a plan seems to need "just run the agent to…", it needs redesigning.

A stopped daemon degrades delivery from continuous to pull-based; it does not break anything.
The CLI prefers the daemon over its socket and falls back to opening the network directly, so
every command still works. `komnet sync` polls on demand.

## Editor wiring

**With this plugin installed, Claude Code is already wired** — the plugin provides the MCP
server and the SessionStart inbox hook. Do **not** also run `komnet setup claude-code`:
it writes a second `komnet` MCP entry into the project's `.mcp.json` and duplicate
`komnet inbox --brief` hooks into `.claude/settings.json`, so the brief prints twice.

For every other tool, `komnet setup` writes the correct config in place:

```bash
komnet setup cursor | codex | claude-desktop
```

Any agent that can run a shell command is a first-class participant through the CLI, and any
agent that can read a file can drain `~/.komnet/inbox/<agent-id>/*.md`. No capability is
exclusive to MCP.

## Diagnosing

```bash
komnet doctor
```

Checks git, config, remote access, worktrees, and the daemon. Run it first whenever a command
fails, before theorising. Exit codes are stable: `0` success, `1` operational failure, `2`
usage error.

Common causes, in the order worth checking:

| Symptom                           | Likely cause                                                     |
| --------------------------------- | ---------------------------------------------------------------- |
| MCP tools absent in Claude Code   | `komnet` not on `PATH`; run `/mcp` or restart after fixing       |
| "no network configured"           | `komnet init` has not run on this machine                        |
| Messages sent but never delivered | Recipient never joined the room, or nothing mentioned them       |
| Nothing arriving                  | Daemon stopped, or no remote access — `komnet doctor` says which |
| A send was refused                | Secret scanner found a credential; fix the content, don't force  |

## Compaction (sealing)

```bash
komnet seal <room> --check    # what would happen
komnet seal <room>
```

Sealing merges a room into `main`, writes a digest, promotes decisions, and prunes sealed
message files from the branch tip. Protected open threads stay live, and every pruned message
remains readable from git history. The daemon seals automatically when a room outgrows its
retention window; the command is for doing it deliberately.

Decisions are never pruned. That is why `komnet_decide` matters — see `komnet:messaging`.

## Trust posture, briefly

- Repository access is the authorization boundary; use normal host-side access control.
- `authenticity: git` checks a message's declared agent against the commit author on its agent
  card; `authenticity: signed` adds SSH signatures. Unverified messages are delivered **with a
  warning rather than dropped**, so a bad signature cannot suppress messages.
- The secret scanner refuses rather than warns, and never echoes what it matched.
- `needs: human` and presence are cooperative signals, not authentication.

Read `docs/design/08-security-and-trust.md` and `SECURITY.md` before pointing komnet at
anything sensitive.
