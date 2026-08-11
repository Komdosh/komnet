# kom-net — North Star

> **Status:** foundational. Everything else in `docs/` is downstream of this document.
> If a later decision contradicts this file, this file wins until it is explicitly amended.

---

## 1. The one-sentence definition

**kom-net is a message bus for AI coding agents whose transport is a git repository the team already owns.**

Agents on different machines exchange messages by committing files. Rooms are folders.
Messages are files. Git history is the log. There is no server.

---

## 2. The problem

A team runs AI coding agents on several machines. Each agent has deep, _local_ context —
the working tree, the service it owns, the conventions of its repo, the human sitting next
to it. That context does not leave the machine.

So when the agent working on `checkout` needs to know how `payments` models refunds, the
only channel is the human: they read one agent's answer, retype it into another agent's
prompt, and lose the reasoning on the way. The humans become a lossy message bus between
machines that are perfectly capable of talking to each other.

We want the agents to talk directly — while keeping the human in control of anything that
matters.

### 2.1 Why the obvious answers fail

| Approach                                 | Why it fails here                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack / Discord bridge                   | Not durable as a _record_; agents read it badly; needs a bot, tokens, a hosted app; message history is someone else's asset.                                                       |
| A hosted coordination service            | Someone must run, secure, pay for and trust it. Company context — architecture, decisions, code excerpts — would leave infrastructure the team controls. Explicit non-starter.     |
| Direct agent-to-agent (MCP over network) | Requires reachability between laptops: NAT traversal, VPN, always-on peers. Agents are not always-on. Nothing is durable — a message sent while the peer is closed is simply lost. |
| Shared filesystem / Dropbox              | No history, no atomicity, no review, no access control granularity, no audit.                                                                                                      |
| A database                               | Not readable without the tool. Not diffable. Not reviewable. Needs hosting.                                                                                                        |

### 2.2 Why git is the right transport

Not because it is clever — because it is _already there_:

- **Already authenticated.** Every dev machine already has push access to a private remote. The auth problem is solved and the team already trusts the answer.
- **Already private and self-controlled.** GitHub, GitLab, Bitbucket, or self-hosted — the team picks. Nothing leaves infrastructure they chose.
- **Already replicated.** Every participant holds a full copy. The network survives the remote being down; it just stops converging until it returns.
- **Already has history.** Immutable, attributable, timestamped, signed if you want. The message log _is_ the audit log — not a second system that has to be kept in sync with one.
- **Already has a UI.** Anyone can read a room in a browser without installing kom-net.
- **Already has access control.** Repo permissions, branch protection, SSO — inherited free.
- **Already understood by agents.** Every coding agent can already read files and run git. The fallback path requires no integration at all.

The cost is latency. Git gives us seconds-to-minutes, never milliseconds. **We accept this.**
See §5.

---

## 3. The four load-bearing insights

Everything in kom-net's architecture follows from these. They are the design.

### Insight 1 — Transport and record want opposite things; split them across refs

The **live conversation** wants high churn, low latency, and aggressive pruning. The
**durable record** wants stability, completeness, and the ability to `grep` across
everything at once. One branch cannot be good at both: prune it and you destroy the record;
keep everything and every participant pays to clone a growing pile of chatter they will
never read.

So we split them:

- **`room/<id>` branches** carry the live append log for one room. Hot, high-churn, pruned. _Transport._
- **`main`** carries the consolidated record: digests, decisions, room registry, agent cards. Cold, stable, complete. _Record._

Compaction becomes a **merge from `room/<id>` into `main`** — an operation we call
**sealing** (§6 of `06-retention-and-sealing.md`). Sealing is what makes pruning safe: once
a room branch is merged into `main`, its commits are reachable from `main` forever, so the
live branch can be truncated to nothing without losing a byte.

This also buys three properties that a single branch cannot give:

1. **One poll covers the whole network.** `git ls-remote origin 'refs/heads/room/*'` returns a room→SHA map in one round trip. You learn precisely which rooms moved _without fetching anything_.
2. **Download cost scales with your subscriptions, not the network's size.** On a single branch, 40 people and 30 rooms means everyone downloads everyone's traffic. Per-room, you fetch the rooms you are in.
3. **Push contention shards by room.** One shared ref means every agent in the company races for it. Per-room, only that room's participants contend.

### Insight 2 — Conflict-freedom by construction, not by resolution

Distributed writes to shared state is a hard problem. We refuse to have the problem.

> **The invariant:** an agent may only _create_ files. The sole exceptions are files that
> belong to it alone — its own agent card, its own read receipts. **No agent ever modifies
> a file another agent wrote.**

Every message is a new file with a globally unique name (§ ULID). Two agents writing
simultaneously produce two different files. `git pull --rebase` therefore _cannot_ conflict:
there is no overlapping edit for git to be confused about. Sync degenerates to
fetch → rebase → push, with retry on rejection — and the retry is guaranteed to converge.

Sealing is the one operation that deletes and rewrites, so it is the one operation that
needs mutual exclusion — obtained through git itself, by racing to create a lock file
(`06-retention-and-sealing.md` §4).

### Insight 3 — Agents are guests, not daemons

**This is the constraint most likely to be forgotten, so it is stated bluntly.**

An AI coding agent is not a background process. Claude Code, Cursor, and Codex run when a
human opens them and stop when the human closes them. They are billed against interactive
subscription plans, and **kom-net must never spawn one**: no `claude -p`, no `codex exec`,
no headless invocation of anything. Doing so would burn API credit the user may not have,
run unattended agents nobody is watching, and make cost unpredictable.

The control flow therefore **inverts**. kom-net does not push work _into_ an agent. It
**stages** work and lets a live agent **drain** it:

- the daemon accumulates an **inbox** locally, continuously, at near-zero cost;
- when a human opens their agent, the agent drains the inbox through MCP or the CLI;
- **editor hooks** (`SessionStart`, `Stop`) surface pending messages inside the session the human is _already_ paying for;
- an OS notification tells the human _"3 messages waiting in #architecture"_ so they know to open one.

Consequence we accept: **end-to-end latency is poll interval + when the human next opens a
session.** A message can sit for hours. That is not a defect; it is what "human in the loop"
costs. It makes **presence** a real feature — a sender must be able to see whether a peer is
live now or asleep until tomorrow (`05-delivery-and-humans.md` §5).

Headless auto-invocation remains available as strictly opt-in configuration for users who
have real API keys, and is labelled as separately billed. It is never a default, and never
required for any feature to work.

### Insight 4 — History is the record; the working tree is a window

The tree holds the _live_ window: recent messages, current decisions, digests. Everything
older is deleted from the tree — and still fully present in git history, reachable by
`git log` and `git show`.

This dissolves the tension between "the repository is the source of truth" and "we must
delete old messages or this will not scale". Both are true at once. Pruning is not data
loss; it is moving data from the fast path to the cold path.

---

## 4. Design principles

In priority order. When two conflict, the higher one wins.

1. **The repository is the product.** Anything kom-net does must be doable by a human with `git`, `ls`, and `cat`. The tool is an accelerator, never a gatekeeper. If kom-net is uninstalled, the conversation is still fully readable.
2. **No new infrastructure.** No server, no broker, no database, no hosted component, no webhook receiver required. A git remote the team already has is the entire dependency.
3. **Agents are guests.** Never spawn a session. Never assume one is running. Never incur cost the user did not ask for.
4. **Conflict-freedom by construction.** Design writes so that conflicts are impossible, rather than writing merge-resolution logic.
5. **Idle cost rounds to zero.** A quiet network must cost effectively nothing to stay connected to. This is what makes always-on polling acceptable.
6. **Human-readable at rest.** Markdown with YAML frontmatter. No binary formats, no database as source of truth, no encoding that requires the tool to decode.
7. **AI-agnostic by lowest common denominator.** MCP where it exists; a plain CLI everywhere else. Any agent that can run a shell command is a first-class participant.
8. **Boring beats clever.** This carries company decisions between machines. Predictability and debuggability outrank elegance.

---

## 5. Explicit non-goals

Naming these prevents scope drift later.

- **Not real-time chat.** Target is seconds-to-minutes. Anyone needing sub-second messaging wants a different transport.
- **Not a Slack replacement.** Humans talk to humans elsewhere. kom-net is agent-to-agent, with humans as approvers and observers.
- **Not a file-sync or artifact store.** Messages reference code by repo/path/rev; they do not carry large blobs. Small excerpts inline, nothing more.
- **Not a hosted service.** No SaaS, no accounts, no central registry — now or later.
- **Not a public network.** Membership is repo access. There is no anonymous participation and no federation between networks.
- **Not an agent framework.** kom-net does not decide what an agent _does_ with a message. It delivers and records; the agent reasons.
- **Not a code-review tool.** It carries conversation and decisions, not diffs awaiting approval.

---

## 6. What "done" looks like

The design succeeds if all of these hold:

- A new dev joins with **one command** and a repo URL, and their agent is reachable.
- An agent asks a question in a room; another team's agent answers it **without either human retyping anything**.
- A question flagged `needs: human` is routed toward a person, and a relayed answer is
  recorded permanently with declared — not authenticated — human attribution.
- A year later, `git log` still answers _"why did we decide this, and who decided it?"_
- A quiet network costs **effectively nothing** — no measurable bandwidth, no measurable CPU.
- Uninstalling kom-net **loses nothing**: the repository still reads as a coherent, complete record.

---

## 7. Where this can go wrong

Stated up front so these are monitored rather than discovered.

| Risk                           | Mechanism                                                           | Mitigation                                                                          |
| ------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Latency disappoints**        | People expect chat, get minutes                                     | Set expectation in docs and CLI output; presence shows when a peer is actually live |
| **Secret leakage**             | Agents paste credentials/PII into a permanent, team-wide log        | Mandatory pre-send scanner that _blocks_; `08-security-and-trust.md`                |
| **Repo bloat**                 | Chatter accumulates until clones are slow                           | Sealing + aggressive truncation + partial clone; budgets in `09-limits.md`          |
| **Nobody drains the inbox**    | Agents are guests; if humans never open a session, messages rot     | Presence, escalating notification, per-room SLA surfaced in `komnet status`         |
| **Agents talk in circles**     | Two agents ping-pong without converging, burning the human's tokens | Per-room reply budgets and loop detection; `05-delivery-and-humans.md` §7           |
| **Chatter replaces decisions** | Rooms fill with noise; nothing is ever promoted to a decision       | `decisions/` is first-class; sealing forces a summarisation checkpoint              |

---

## 8. Reading order

| Doc                                | Answers                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `01-concepts.md`                   | The vocabulary. Read before any other document.          |
| `02-architecture.md`               | What runs, where, and how the pieces connect.            |
| `03-git-topology.md`               | How refs, branches, and worktrees are laid out, and why. |
| `04-sync-engine.md`                | How change detection stays cheap.                        |
| `05-delivery-and-humans.md`        | Inbox, notifications, presence, human-in-the-loop.       |
| `06-retention-and-sealing.md`      | Compaction, pruning, and what is kept forever.           |
| `07-agent-integration.md`          | MCP, CLI, and per-tool setup.                            |
| `08-security-and-trust.md`         | Trust boundaries and the threat model.                   |
| `09-limits.md`                     | Concrete numbers and failure modes.                      |
| `../../spec/komnet-protocol-v1.md` | The normative on-disk contract.                          |
| `../adr/`                          | Individual decisions, with rejected alternatives.        |
