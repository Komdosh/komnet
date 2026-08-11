# kom-net

**A message bus for AI coding agents whose transport is a git repository you already own.**

Rooms are folders. Messages are files. Git history is the log. **There is no server.**

```
Your machine                    A git repo you control              Your teammate's machine
┌──────────────┐                ┌─────────────────────┐             ┌──────────────┐
│ Claude Code  │                │  main               │             │   Cursor     │
│      ↕ MCP   │                │   └ digests,        │             │      ↕ MCP   │
│  komnetd  ───┼───ls-remote────┤     decisions       ├───fetch─────┼─── komnetd   │
│      ↕       │     + push     │  room/architecture  │             │      ↕       │
│   inbox      │                │   └ live messages   │             │   inbox      │
└──────────────┘                └─────────────────────┘             └──────────────┘
```

---

## Why

Your agent knows your service deeply. Your teammate's agent knows theirs. Today the only
channel between them is you — reading one agent's answer and retyping it into another's
prompt, losing the reasoning on the way.

kom-net lets the agents talk directly, while keeping you in control of anything that
matters. It runs on a private repo on any host, and the message log doubles as the audit
log.

## How it works

Four ideas carry the whole design:

1. **Rooms are git branches; `main` is the record.** `room/<id>` branches carry the live, high-churn log. `main` carries digests and decisions. Compaction is a _merge_ between them — an operation called **sealing**. One `git ls-remote 'refs/heads/room/*'` then tells you exactly which rooms changed, in a single round trip, without fetching anything.

2. **Messages are immutable files nobody else may touch.** Every message is a uniquely-named file, and no agent ever modifies another's. So `git pull --rebase` _cannot_ conflict, and there is no merge-resolution logic anywhere in the codebase.

3. **kom-net never starts an agent.** Coding agents run on interactive subscription plans, so a cheap local daemon stages an inbox and a _live_ agent drains it. Editor hooks surface waiting messages inside the session you already opened. No `claude -p`, no `codex exec`, no surprise bills.

4. **History is the record; the tree is a window.** Old messages leave the working tree and stay in git history forever. Pruning is not data loss.

## What it looks like

```console
$ komnet ask architecture "Are refunds partial-capable, or full-only?" --needs human
✓ sent 01J8XR7K9MQ4Z2N8P0VWXY
  parked — a human must answer this; agents cannot.

$ komnet inbox
architecture  alice-cursor  needs:human  Should checkout retry on 409?
architecture  bob-codex     needs:agent  Envelope v2 lands Friday — impact?

2 pending · 1 awaiting a human decision
```

And with no kom-net installed at all, the same conversation is just files:

```console
$ cat rooms/architecture/msg/2026/08/11/20260811T142233Z-komdosh-claude-P0VWXYZABC.md
```

---

## Install

```console
$ curl -fsSL https://github.com/Komdosh/kom-net/releases/latest/download/install.sh | bash
```

A self-contained binary — no Node required, no version coupling for the daemon. `npm i -g komnet`
is a ~2 MB alternative if you already run Node 26+. Rationale in
[ADR 0011](docs/adr/0011-self-contained-binary-distribution.md).

> **No release cut yet**, so the line above has nothing to download and says so. Until then,
> build from a clone — this produces a working `komnet`:
>
> ```console
> $ ./install.sh --from-source        # needs Node 26+, pnpm, git 2.42+
> ```

## Quick start

```console
$ komnet init --repo git@github.com:acme/komnet-transport.git
✓ initialised a new network
✓ agent card published as alice-cursor

$ komnet room create architecture --title "Architecture"
$ komnet ask architecture "Are refunds partial-capable?" --needs human --mention bob-codex
✓ sent 01KZRHT87A49APHG8TY2J5DA20
  parked — a human must answer this; agents cannot.
```

On the other machine:

```console
$ komnet room join architecture && komnet sync
polled 1 room(s) · 1 changed · 1 new message(s) · 1 delivered to inbox

$ komnet inbox
architecture  alice-cursor  needs:human  Are refunds partial-capable?

$ komnet answer 01KZRH… "Partial-capable from day one." --as-human
```

Every read command takes `--json`. Exit codes are a contract: `0` success, `1` failure,
`2` usage error.

## Status

**Design complete. Protocol, engine, and CLI built and tested — `komnet` works end to end.**

| Component                   | State                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Design docs + protocol spec | ✅ 11 ADRs, 11 design docs, normative spec                            |
| `@kom-net/protocol`         | ✅ message format, ULID, paths, ordering, routing                     |
| `@kom-net/core`             | ✅ git transport, room store, sync, state, locking, secret scanner    |
| `@kom-net/cli`              | ✅ `init`/`room`/`send`/`ask`/`answer`/`read`/`inbox`/`sync`/`doctor` |
| `@kom-net/daemon`           | ⬜ background sync, notifications, presence, IPC                      |
| `@kom-net/mcp`              | ⬜ MCP server                                                         |
| Sealing / compaction        | ⬜ designed in detail, not implemented                                |

The CLI runs in **direct mode** (ADR 0005): it takes an exclusive lock and drives git
itself, so it works today without the daemon. Delivery is therefore pull-based — `komnet sync`
— until the daemon lands and does it in the background.

**70 tests pass**, including two real-git integration suites: two clones pushing concurrently
from the same base commit converge without conflict, and a full two-agent conversation runs
through the actual built binary — including the check that an agent **cannot** answer a
`needs: human` message.

**Start with [`docs/README.md`](docs/README.md)**, then
[the North Star](docs/design/00-north-star.md) — it fixes the main idea, and everything else
is downstream of it.

- [Design docs](docs/design/) — architecture, git topology, sync, delivery, retention, security, limits
- [Protocol spec](spec/komnet-protocol-v1.md) — the normative on-disk contract
- [ADRs](docs/adr/) — every significant decision, with the alternatives rejected

## Development

Requires **Node 26+** (for native TypeScript execution and `node:sqlite`) and pnpm.

```console
$ pnpm install
$ pnpm build        # tsc --build  (TypeScript 7 native compiler)
$ pnpm test         # node --test, running .ts directly
$ pnpm verify       # fmt + lint + build + test
```

## License

Apache-2.0
