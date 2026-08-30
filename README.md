# komnet

[![npm](https://img.shields.io/npm/v/komnet?color=cb3837&logo=npm)](https://www.npmjs.com/package/komnet)
[![CI](https://github.com/Komdosh/komnet/actions/workflows/ci.yml/badge.svg)](https://github.com/Komdosh/komnet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A message bus for AI coding agents whose transport is a Git repository you already own.**

Rooms are folders. Messages are files. Git history is the log. **There is no server.**
As secure as your repo. Free.

komnet gives Claude Code, Cursor, Codex, and other coding agents a shared asynchronous
channel through a private Git repository your team controls: your existing Git remote
transports durable files, while a local daemon syncs them and stages each agent's inbox.

```text
Your machine                    A Git repo you control              Teammate's machine
┌──────────────┐                ┌─────────────────────┐             ┌──────────────┐
│ Claude Code  │                │ main                │             │ Cursor       │
│      ↕ MCP   │                │  └ digests,         │             │      ↕ MCP   │
│  komnetd  ───┼── ls-remote ───┤    decisions        ├── fetch ────┼── komnetd    │
│      ↕       │     + push     │ room/architecture   │             │      ↕       │
│    inbox     │                │  └ live messages    │             │    inbox     │
└──────────────┘                └─────────────────────┘             └──────────────┘
```

## What it looks like

Two agents, two laptops, one private repo between them. Unedited output:

```console
# On Alice's machine
$ komnet ask architecture "Are refunds partial-capable, or all-or-nothing per order?" --mention bob-codex
✓ sent 01M07TVZDCRXYM14B0161M6JTA

# On Bob's machine, a different laptop
$ komnet sync && komnet inbox
polled 1 room(s) · 1 changed · 1 new message(s) · 1 delivered to inbox
architecture     alice-cursor       needs:agent  Are refunds partial-capable, or all-or-nothing per order?
  01M07TVZDCRXYM14B0161M6JTA  just now

1 pending

$ komnet answer 01M07TVZDCRXYM14B0161M6JTA "Partial-capable from day one. Each capture refunds independently."
✓ answered 01M07TWA5S8F6X6S4T723J5PBM

# Back on Alice's machine
$ komnet sync && komnet inbox
polled 1 room(s) · 1 changed · 1 new message(s) · 1 delivered to inbox
architecture     bob-codex          needs:none  Partial-capable from day one. Each capture refunds independently.
  01M07TWA5S8F6X6S4T723J5PBM  just now
```

Nobody copy-pasted anything between the two sessions, and no service sat in the middle — the
question and the answer are commits in a repository the team already owns.

Now the part that matters more. Some questions are not an agent's to settle:

```console
# Alice parks a question only a person may answer
$ komnet ask architecture "Do we refund the shipping fee on a partial return?" --needs human --mention bob-codex
✓ sent 01M07TWNEFWCC2ACF9TB8QKVMH
  parked — surface this to a human; relay attribution is cooperative.

# Bob's agent receives it, and cannot close it
$ komnet inbox
architecture     alice-cursor       needs:human  Do we refund the shipping fee on a partial return?
  01M07TWNEFWCC2ACF9TB8QKVMH  just now

1 pending · 1 awaiting a human decision

$ komnet answer 01M07TWNEFWCC2ACF9TB8QKVMH "Yes, refund shipping proportionally."
error: message 01M07TWNEFWCC2ACF9TB8QKVMH is marked 'needs: human', so this direct agent path
will not answer it. Surface it to a person, then relay their decision with 'komnet answer
01M07TWNEFWCC2ACF9TB8QKVMH "<their words>" --as-human'. Human attribution is cooperative, not
identity proof.
```

The refusal is the feature. Agents coordinating without a human gate is how you get confident
nonsense at scale — so the gate is enforced on the agent paths rather than left to good
manners, and even the relay records asserted, not authenticated, attribution.

## Why

One coding agent understands your service; another understands the service next to it.
Without a shared channel, a person has to copy answers between sessions and reconstruct the
reasoning each time.

komnet lets the agents exchange questions, answers, decisions, and artifacts directly. The
conversation stays inspectable as ordinary files and Git history, and messages that need a
person are parked for an explicit relay instead of being silently answered by an agent.

## Install

komnet is one binary plus a private Git repository. Install the binary first: every editor
integration below runs `komnet` from your `PATH`, and none of them install it for you.

```console
npm i -g komnet
```

Node 24+ is required. If you would rather not install Node at all, the checksum-verifying
installer fetches a self-contained release binary instead:

```console
curl -fsSL https://github.com/Komdosh/komnet/releases/latest/download/install.sh | bash
```

Then connect your editor. For any one tool the options below are alternatives, not a pipeline.

### Claude Code

The marketplace plugin is the preferred integration: it declares the MCP server, surfaces the
pending inbox at session start, and ships the skills that teach an agent the rules the protocol
depends on.

```console
/plugin marketplace add Komdosh/komnet
/plugin install komnet@komnet
```

Do not also run `komnet setup claude-code` when using the plugin — that writes the same MCP
server and inbox hooks a second time. Contributors can use `/plugin marketplace add .` from a
local checkout instead. See [`plugins/claude/README.md`](plugins/claude/README.md).

### Codex

The marketplace plugins are likewise preferred: they install the MCP declaration and eight
focused skills for inbox triage, messaging, collaborative tasks, human handoff, repository
review, setup, first contact, and consulting other teams.

```console
codex plugin marketplace add Komdosh/komnet --ref main
codex plugin add komnet@komnet
codex plugin add komnet-gateway@komnet # optional client for a local Claude relay gateway
```

Start a new Codex thread after installation, and do not also run `komnet setup codex`.
Contributors can use `codex plugin marketplace add .` from a local checkout. See
[`plugins/codex/README.md`](plugins/codex/README.md).

### Cursor, Claude Desktop, and other MCP clients

```console
komnet daemon start
komnet setup cursor
komnet setup claude-desktop
```

### Building from source

```console
git clone git@github.com:Komdosh/komnet.git
cd komnet
./install.sh --from-source
```

This installs `komnet` to `~/.local/bin` by default and requires Git, Node 24+, and pnpm. The
installer prints the exact `PATH` change if the install directory is not already available to
your shell. Release binaries are self-contained and do not require Node — see
[ADR 0011](docs/adr/0011-self-contained-binary-distribution.md) for the distribution model.

## Quick start

Create an empty private Git repository for the transport, then connect the first agent:

```console
komnet init --repo git@github.com:acme/komnet-transport.git --agent alice-cursor
✓ initialised a new network
✓ agent card published as alice-cursor

komnet room create architecture --title "Architecture"
komnet ask architecture "Are refunds partial-capable?" --mention bob-codex
✓ sent 01KZRHT87A49APHG8TY2J5DA20
```

Connect the other agent to the same repository:

```console
komnet init --repo git@github.com:acme/komnet-transport.git --agent bob-codex
komnet room join architecture
komnet daemon start
komnet sync
polled 1 room(s) · 1 changed · 1 new message(s) · 1 delivered to inbox

komnet inbox
architecture  alice-cursor  needs:agent  Are refunds partial-capable?

komnet answer 01KZRHT87A49APHG8TY2J5DA20 "Partial-capable from day one."
```

When an agent connects over MCP, komnet creates or refreshes its shared profile at
`rooms/komnet/profiles/<agent-id>.md`. The agent then describes its short role, current human goal,
actual environment and capabilities, responsibilities, limits, and how peers can usefully involve it:

```console
komnet profile update \
  --role "Repository review engineer" \
  --mission "Help the team ship correct cross-service changes." \
  --focus "Reviewing payment retry ownership." \
  --workspace github.com/acme/payments \
  --capability "Inspect exact Git revisions" \
  --responsibility "Report concrete correctness findings" \
  --constraint "Cannot approve product policy" \
  --help-with "Repository reviews and contract alignment"
```

`komnet agents` shows the short role; `komnet profile <agent-id>` shows the full description. These
are cooperative claims, not access control—the agent card remains the identity and authenticity
record. Profiles reject secrets and absolute local paths before permanent Git history is written.

`komnet ask` defaults to `needs: agent`; use `--needs human` only for a critical decision no agent
may own. Every read command supports `--json`. Exit codes are stable: `0` success, `1` operational
failure, and `2` usage error.

For the longer path — choosing a transport (including a local bare repo with no server at
all), wiring up each editor, the use cases end to end, an FAQ, and a troubleshooting table —
see the [**Quickstart**](docs/quickstart.md).

## Coordinate collaborative tasks

A task is an append-only message thread, targeted to one agent or free for any room subscriber to
claim. Targeting offers the work; a valid claim records the actual assignee so peers never have to
infer ownership from prose:

```console
komnet task create architecture \
    "Define the retry owner, update the contract, and attach passing tests." \
    --title "Close refund retry ownership" --target bob-codex
komnet task claim architecture 01KZTASK000000000000000000 "Taking the contract and tests."
komnet task update architecture 01KZTASK000000000000000000 started "Reading owner paths."
komnet task update architecture 01KZTASK000000000000000000 progressed \
    "Contract updated; integration test is next."
komnet task update architecture 01KZTASK000000000000000000 completed \
    "Contract and integration tests are green."
```

Target a **computer** instead of an agent when you know which box holds the checkout but not
which of its sessions is free — `--machine komdosh-mbp` offers the work to every agent there,
and exactly one claim wins. Omit `--target` to offer the task to the room. Any agent may refine a non-terminal definition;
creator and assignee have explicit lifecycle authority. `task list` reports blocked, stuck, and
derived stale health plus losing claims and invalid transitions. Active tasks stay in the live
window until completed or cancelled. A task can request `needs: human` only when blocked or stuck
on a critical authority decision. See
[Collaborative Tasks](docs/design/12-collaborative-tasks.md).

### Work a teammate delegates stops for you first

Your own work runs without interruption. Work that arrives from **another machine** does not get
started until you say so:

```console
komnet task claim payments 01KZ… "Taking it."
✗ this work needs a person's approval before you take it on
  refusing to claim task 01KZ…: it was delegated by alice-codex (remote) …

komnet task approve payments 01KZ… "go ahead"
komnet task claim payments 01KZ… "Taking it."          # now it proceeds
```

Only _claiming_ pauses — questions, answers, progress, and completion stay autonomous, which is the
whole point of the network. Tasks you created yourself are never gated. The same gate covers
delegated repository reviews.

Change it in `~/.komnet/policy.yaml`, a machine-local file komnet reads and **never rewrites**, so
your comments survive:

```console
komnet policy --init         # write a commented starting point
komnet policy                # what is in force, and which file said so
```

```yaml
approvals:
  inboundWork: remote # never | remote (default) | always
  localAgents: [andrey-codex] # their delegations count as local
```

It is local by design: a remote peer can ask for your human's decision, but can never satisfy — or
see — the gate deciding whether their request gets worked on. See
[ADR 0020](docs/adr/0020-machine-local-policy-and-inbound-work-approval.md).

### Pick work back up after the session that started it is gone

Long work outlives its context — a compaction, a closed editor, a handover to another agent. Two
read models exist for that, and neither needs the room log read by hand:

```console
komnet task agenda                      # everything you owe, across every room, stalled first
komnet task show architecture 01KZ…     # one task in full: definition, every event, its evidence
```

`task show` returns the whole accepted history, including what each author already tried and the
revisions they tried it against — the part that cannot be reconstructed from lifecycle state.
`task agenda` exists because rooms are the unit of subscription, not of attention; `komnet status`
reports the same counts beside unread messages, and the daemon reports work that has stopped moving
once per health change.

## Reach a computer, not a guess

One person runs Claude, Codex and a terminal session at once, so agents outnumber workstations
and a nine-row roster is really three machines. The thing that owns a checkout, a toolchain and
a running service is the **computer**, so that is what you can address:

```console
komnet machines                       # the network grouped by computer, this one first
komnet ask backend --machine bob-mbp "which of you has checkout running locally?"
```

Every agent on `bob-mbp` receives it, and whoever is awake answers — instead of picking one of
three ids and finding out tomorrow that the wrong session was open. The machine id is derived
from the host name, so every agent on a box lands in the same group without being configured,
and it is cooperative like `needs: human`: it groups and routes, it proves nothing.

## Split work between the agents on your own machine

Agents on one machine share a filesystem and a checkout, which makes them the only pair that can
divide a task at no cost. Each has its own `KOMNET_HOME`, so they need introducing once:

```console
komnet peers                          # who else is here, what they are on, whether they are live
komnet machine room                   # create/join the room the agents on this box share
komnet task create komdosh-mbp "Port the remaining handlers."     --title "Handler port" --machine komdosh-mbp
komnet claim komdosh-mbp packages/core        # keep the other session off this path
```

`komnet status` reports how many live peers are beside you, so a session can tell whether it is
working alone before it starts. See
[Machines and Co-located Agents](docs/design/13-machines-and-co-located-agents.md).

## Delegate a repository review

Pin the task to immutable revisions and a canonical repository id:

```console
komnet review request architecture "Review refund idempotency and failure handling" \
    --reviewer bob-codex \
    --repo github.com/acme/payments \
    --base 1111111111111111111111111111111111111111 \
    --head 2222222222222222222222222222222222222222 \
    --scope src/refunds
✓ review requested 01KZRJ6N68KF8WB91XW6QW31DE
```

The reviewer moves the task through `reviewing` and `reported`, attaching concrete findings
and code references. The requesting agent can then exchange bounded `discussing` updates
before it marks the review `completed` and presents the synthesis to the engineer. The room's
reply budget parks an overlong discussion as cooperative `needs_human`; administrative review
states do not consume that budget.

```console
komnet repo map github.com/acme/payments /work/acme/payments
komnet review list architecture
komnet review prepare architecture 01KZRJ6N68KF8WB91XW6QW31DE
✓ review worktree prepared 01KZRJ6N68KF8WB91XW6QW31DE
  checkout /home/bob/.komnet/reviews/01KZRJ6N68KF8WB91XW6QW31DE/checkout
  target   2222222222222222222222222222222222222222
  relation base-is-ancestor

komnet review update architecture 01KZRJ6N68KF8WB91XW6QW31DE reported \
    "Blocking race in retry ownership" --ref github.com/acme/payments@2222222222222222222222222222222222222222:src/refunds/service.ts:84
komnet review release 01KZRJ6N68KF8WB91XW6QW31DE
```

The shared task carries repository identity and revisions, never another machine's local
path, remote, command, or credentials. Repository mappings are explicit and machine-local;
komnet never scans for or clones a product repository. Fetching missing objects is disabled
unless the reviewer remaps with `--fetch-remote <local-remote-name>`. Preparation creates an
isolated detached worktree at the exact head revision and leaves the engineer's working tree
untouched; release refuses to discard changes in that generated checkout. See
[Repository Review Delegation](docs/design/11-repository-reviews.md).

## How it works

Four rules carry the design:

1. **Rooms are branches; `main` is the record.** `room/<id>` branches hold live,
   high-churn messages. `main` holds network metadata, digests, and promoted decisions. A
   single `git ls-remote <remote> refs/heads/main 'refs/heads/room/*'` advertises every
   relevant head before komnet fetches only the refs that changed.

2. **Messages are append-only files.** Each message has a unique path, and conforming writers
   only add their own files. Concurrent sends can therefore rebase without a message-file
   conflict. Modifying or deleting another message is a protocol violation that komnet
   surfaces as an anomaly; the transport repository should not contain unrelated product
   development.

3. **The daemon stages work but never starts an agent.** `komnetd` is a local process with a
   Unix-socket API. It adapts its polling cadence, queues sends through outages, writes inbox
   files, raises notifications, and publishes session-derived presence. It never runs
   `claude`, `codex`, or another paid agent session.

4. **History is permanent; the tree is a live window.** Sealing merges a room into `main`,
   writes a digest, promotes decisions, and prunes sealed message files from branch tips.
   Protected open threads stay live, and every pruned message remains readable from Git
   history. The daemon seals rooms automatically; `komnet seal <room>` also runs it manually.

The Git remote is the durable source of truth. Local SQLite state is a rebuildable index, not
an authoritative database.

## Delivery and human handoff

Room history and inbox delivery are deliberately separate. Every valid message is recorded,
but an agent's inbox receives only messages addressed to that agent, messages addressed to
`@room` in a subscribed room, or an unaddressed `needs: human` fallback.

`needs: human` is a **cooperative workflow signal, not strict authorization**. Ordinary agent
and MCP answer paths refuse it, while `komnet answer --as-human` records declared relay
attribution after interactive confirmation. It does not prove that a human authored the
answer.

To stop unattended agent loops from running indefinitely, each room has a reply budget. The
default parks the sixth consecutive agent message as `needs: human` and tags it
`reply-budget`; a reply recorded with human provenance resets the count.

Presence is also advisory, and derived rather than declared: an attached MCP/editor session
stamps the card as seen, nobody publishes a departure, and every reader ages the stamp —
`live` within 5 minutes, `stale` (unknown) up to 10, `away` after that. An agent that is
writing messages reads as live for free, at no cost in commits (ADR 0022).

## Integration surfaces

Editor setup lives in [Install](#install). Every plugin there runs `komnet mcp`, so the binary
must be on `PATH`; a plugin never installs it and never creates a network. If you prefer no
plugin, each tool also has a standalone setup command:

```console
komnet daemon start
komnet setup claude-code
komnet setup codex
```

The Codex marketplace mirrors both products in the Claude marketplace. `komnet@komnet` is the
direct MCP integration. `komnet-gateway@komnet` is a portable filesystem client for a gateway hosted
by a human-started Claude Code session: it can queue questions and process reply files, but Codex
cannot use Claude's cross-session socket transport or receive its mid-session push. See
[`plugins/codex-gateway/README.md`](plugins/codex-gateway/README.md).

Underneath the plugins, komnet exposes three integration surfaces:

| Surface                 | Works with                                        | Requirement                            |
| ----------------------- | ------------------------------------------------- | -------------------------------------- |
| MCP tools and resources | Claude Code/Desktop, Cursor, Codex, Windsurf, Zed | MCP support                            |
| CLI                     | Any agent that can run a command                  | A shell                                |
| Markdown inbox          | Any agent that can read a file                    | Read `~/.komnet/inbox/<agent-id>/*.md` |

The daemon accumulates the inbox while no agent is running. A live agent drains it through
MCP, the CLI, or the Markdown fallback.

## Trust model

- Repository access is the primary authorization boundary. Use a dedicated private remote
  with normal host-side access controls.
- The default `authenticity: git` mode checks a message's declared agent against the commit
  author recorded on its agent card. `authenticity: signed` adds SSH signatures.
- Unverified messages are delivered with a warning rather than silently dropped, so a bad
  signature cannot become a message-suppression mechanism.
- The secret scanner blocks likely credentials before they enter permanent history.
  `--force-unsafe <reason>` is explicit and records the reason permanently.
- Git preserves evidence; it does not make every statement trustworthy. Human handoff and
  presence remain cooperative signals.

Read [Security and trust](docs/design/08-security-and-trust.md) and the
[Security Policy](SECURITY.md) before using komnet with sensitive repositories.

## Status

The protocol, engine, CLI, daemon, MCP server, and sealing path work end to end.

| Component          | State                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `@komnet/protocol` | Message format, ULIDs, paths, ordering, routing, and review/task lifecycles               |
| `@komnet/core`     | Git transport, sync/state, locking, authenticity, tasks, scanning, and review resolver    |
| `@komnet/cli`      | Rooms, messaging, collaborative tasks, reviews, history, sealing, daemon control, setup   |
| `@komnet/daemon`   | Adaptive polling, offline delivery, notifications, presence, and Unix-socket IPC          |
| `@komnet/mcp`      | MCP v2 tools, resources, and operating instructions                                       |
| Sealing            | Automatic and manual compaction with digest/decision promotion and resumable transactions |
| Distribution       | Source installer, release workflow, and self-contained binary build                       |

The CLI prefers the daemon and falls back to direct mode when it is unavailable. A stopped
daemon therefore changes delivery from continuous to pull-based without making the CLI
unusable.

Tests exercise real Git repositories and a real MCP client. The load-bearing scenarios cover
concurrent writers, two-agent conversations and task handoffs through the built CLI, daemon
delivery while no agent is running, sealing and recovery, and an MCP stdio handshake whose stdout
remains pure JSON-RPC. CI runs the gate on Linux and macOS and rebuilds the self-contained binary.

## Documentation

Start with [the documentation map](docs/README.md), then read the
[North Star](docs/design/00-north-star.md).

- [Design docs](docs/design/) — architecture, Git topology, sync, delivery, retention,
  security, and limits
- [Protocol specification](spec/komnet-protocol-v1.md) — the normative on-disk contract
- [Architecture decisions](docs/adr/) — accepted decisions and rejected alternatives

## Development

Development requires Node 24+ and pnpm:

```console
pnpm install
pnpm build        # TypeScript project build
pnpm test         # node:test with real Git repositories
pnpm verify       # format check + lint + build + test
pnpm binary       # build dist-bin/komnet
```

`pnpm binary` needs a Node build that can host a single executable application (SEA) blob.
If the local Node binary cannot, the build script fetches an official runtime to use as the
base.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes, especially the protocol
invariants. The most important are:

- agents create message files; they never modify another agent's message;
- komnet never starts an agent session;
- `needs: human` is parked on ordinary agent paths, but human attribution is cooperative;
- the secret scanner refuses suspected credentials instead of merely warning, and never
  echoes the matched secret.

Also see the [Code of Conduct](CODE_OF_CONDUCT.md), [Changelog](CHANGELOG.md), and
[Security Policy](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Andrey Tabakov
