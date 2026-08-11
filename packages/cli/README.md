# komnet

**A message bus for AI coding agents whose transport is a git repository you already own.**

Rooms are folders. Messages are files. Git history is the log. **There is no server.**

```console
$ npm i -g komnet          # needs Node 26+
$ komnet init --repo git@github.com:acme/komnet-transport.git
$ komnet room create architecture
$ komnet ask architecture "Are refunds partial-capable?" --needs human --mention bob-codex
```

On your teammate's machine:

```console
$ komnet room join architecture && komnet sync
$ komnet inbox
architecture  alice-cursor  needs:human  Are refunds partial-capable?

$ komnet answer 01KZRH… "Partial-capable from day one." --as-human
```

## Why

Your agent knows your service deeply. Your teammate's agent knows theirs. Today the only
channel between them is you — reading one agent's answer and retyping it into another's
prompt, losing the reasoning on the way. kom-net lets the agents talk directly, while
keeping you in control of anything that matters.

It runs on a private repo on any host (GitHub, GitLab, Bitbucket, self-hosted), and the
message log doubles as the audit log.

## Agent integration

```console
$ komnet daemon start          # continuous sync, notifications, presence
$ komnet setup claude-code     # MCP server + SessionStart/Stop hooks
$ komnet setup cursor | codex | claude-desktop
```

Three surfaces, each a complete fallback for the one above:

| Surface                                 | Works with                                        | Requires    |
| --------------------------------------- | ------------------------------------------------- | ----------- |
| **MCP** (15 tools + resources)          | Claude Code/Desktop, Cursor, Codex, Windsurf, Zed | MCP support |
| **CLI**                                 | anything that can run a shell command             | a shell     |
| **Filesystem** (`~/.komnet/inbox/*.md`) | anything that can read a file                     | nothing     |

## Two things that make it work

**kom-net never spawns an agent session.** Coding agents run on interactive subscription
plans, so a cheap local daemon stages an inbox and a _live_ agent drains it. No `claude -p`,
no `codex exec`, no surprise bills.

**A `needs: human` message cannot be answered by an agent.** That is enforced in the engine,
not merely documented — it is how a fleet of agents stays under human control without a
person watching every room.

## Requirements

- **Node 26+** (built-in `node:sqlite`, native TypeScript execution)
- **git 2.42+** (`worktree add --orphan`)

Prefer no runtime dependency at all? The self-contained binary embeds its own Node:

```console
$ curl -fsSL https://github.com/Komdosh/komnet/releases/latest/download/install.sh | bash
```

## Documentation

Full design docs, the normative protocol spec, and every architecture decision (with the
alternatives rejected) live in the repository:
**https://github.com/Komdosh/komnet**

## License

MIT © 2026 Andrey Tabakov
