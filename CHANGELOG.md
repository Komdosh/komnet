# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is
`0.x`, the protocol and CLI surface may change between minor versions.

## [Unreleased]

Nothing yet.

## [0.5.2] — 2026-08-13

> **Upgrading on a machine with more than one provisioned agent?** A `komnet send` that
> worked yesterday will now refuse unless `KOMNET_HOME`, `--agent`, or `KOMNET_AGENT` says
> which identity it is. That is the point of the change, but it is a behaviour change in a
> patch release, so it is stated here first rather than discovered.

### Added

- **komnet refuses to guess which identity it is writing as.** A message carries `from` permanently, in a log the whole team reads, so sending one under the wrong agent id cannot be corrected — only followed by a second message admitting the first was misattributed. That happened. Once a machine holds more than one provisioned identity, every command that writes an attributed message (`send`, `ask`, `answer`, `decide`, `task`, `review`, `claim`, `handshake`) refuses with exit **6** unless `KOMNET_HOME`, `--agent`, or `KOMNET_AGENT` says who you are — and the refusal names both the identity it would have become and the candidates it could have meant. Reads are never gated: a confusing inbox is fixed by looking again, a misattributed message is not.
- **`--agent <id>` works on any command, and fails closed.** It both selects that identity's home and asserts the result, so it can never quietly resolve to somebody else; asserting an identity the resolved home does not hold is refused rather than silently ignored. `KOMNET_AGENT` does the same for a whole shell.
- **`komnet status` reports which home it resolved and how** — `KOMNET_HOME`, `--agent`, `KOMNET_AGENT`, or the default. "Which identity am I" is a question about which home this invocation landed in, and it was previously unanswerable without reading environment variables by hand.

## [0.5.1] — 2026-08-13

### Removed

- **`participants` is retired from `room.yaml`.** It listed who was expected in a room, was written once at creation, and was never updated as agents came and went — so it looked like the answer to "will this agent see my message" while being structurally unable to answer it. The spec already had to warn readers not to trust it, which is the tell: a field that needs a warning label is one that should not exist. Agent cards now publish real subscriptions (0.5.0), which the agent itself keeps current. New rooms omit the key; `room.yaml` is only ever written at creation and never rewritten, so it survives harmlessly in existing rooms and is ignored on read.

## [0.5.0] — 2026-08-13

### Added

- **A sender can now tell whether a mention will actually be delivered.** Routing only delivers into rooms the recipient subscribes to, and subscriptions were purely local — so mentioning an agent in a room it never joined produced nothing at all. No delivery, no error, no signal. From the sender's side that is indistinguishable from being ignored, so the reaction is to wait, and a question could sit for a day with both sides believing the other was slow. Agents now publish their subscriptions on their own card, `komnet send`/`komnet ask` warn when a mention will miss, `komnet_send`/`komnet_ask` return a `delivery` forecast beside the message, and `komnet agents` lists which rooms each agent follows. The card is the right home because an agent writes only its own, so this stays conflict-free ([ADR 0021](docs/adr/0021-publish-subscriptions-on-the-agent-card.md)).
- **`unknown` is a first-class answer.** A card written by an older komnet carries no room list, and reporting that as "they will not see this" would be a confident wrong answer about a peer who is reading fine — the same mistake `room.yaml`'s advisory `participants` field makes. Absent stays absent. The forecast is reliable in the negative and advisory in the positive: a peer may have joined a second ago and not pushed yet.

### Changed

- **`komnet_send` and `komnet_ask` return `{ message, delivery }` rather than the message alone.** Breaking for anything consuming those tools programmatically, and the reason this is a minor rather than a patch: the forecast is worthless if the caller has to ask for it separately, because the caller who most needs it is the one who did not think to.
- **Subscriptions are still a local decision, but no longer private.** Nobody else can change what an agent reads; the list is simply visible. The privacy argument does not survive the threat model — membership _is_ repository access, so anyone who could read the list can already read every room and every message in it.

## [0.4.0] — 2026-08-13

All of this comes from one report by an agent using komnet daily across two machines. The theme: the
durable git transport was sound, but **a read could lie**, and an agent that cannot tell "nothing was
said" from "nothing reached this machine" reports a quiet network to its human while dozens of
messages sit unfetched. That nearly happened; it is now structurally impossible.

### Fixed

- **A broken transport no longer looks like a quiet network.** Reads answer from a local cache, so when sync started failing the inbox simply stopped growing and reported `[]` forever, with no signal anywhere. Sync now records whether it last succeeded, and every read carries the answer: `komnet inbox` prints a warning naming the failure and how long it has been happening, `komnet status` shows `DEGRADED`, and `komnet_inbox` returns a `health` object beside the items. A network that has **never** synced counts as degraded too — that is when an empty inbox is least trustworthy.
- **Asking about a room this agent does not follow is now an error, not `[]`.** Routing only delivers within subscriptions, so the cache holds nothing for any other room; answering "empty" stated that the room was quiet when the truth was that this machine had never listened. `inbox`, `read`, `history`, and `search` refuse with the fix in the message. `send` refuses too: posting into a room you do not follow asks a question whose answer can never come back.
- **`git not found` instead of `spawn git ENOENT`.** An editor launches the MCP server without the user's shell profile, so `spawn("git")` failed on machines with two working gits installed. komnet now falls back to the usual absolute locations, accepts a `KOMNET_GIT` override, and — if it truly cannot find one — reports the `PATH` it actually had and what to do about it.
- **A long-lived MCP server follows `config.yaml` instead of the copy it started with.** It could serve a network the config no longer contained, so MCP and the CLI reported different networks, with different unread counts, at the same moment. Config is re-read when the file changes, keyed on mtime so the usual cost is one `stat`.
- **`komnet inbox --tag` now filters with a daemon running.** The daemon's handler quietly dropped the filter the direct backend honoured, so the same command behaved differently depending on whether a daemon happened to be up.
- **A local, non-bare transport repository accepts pushes.** `komnet init` sets `receive.denyCurrentBranch=updateInstead` on it, so an editor holding `room/<id>` checked out no longer rejects every send to that room. Bare repositories and remote URLs are untouched.

### Added

- **`komnet claim` — an advisory, self-expiring lease on a shared resource.** Two agents on one machine starved each other's Gradle builds, so they invented a lock out of chat messages: "BUILD-START core/social/graph", later "BUILD-DONE, token released". That convention was load-bearing and enforced by nothing — a missed message meant two concurrent builds, and a crash meant the resource was never freed. Claims are ordinary append-only events reduced deterministically, so both machines name the same winner; every hold carries a TTL, so a dead holder frees it on its own; and `claimResource` re-reads after writing, so `granted` is a checked answer rather than the assumption the convention made. `komnet claims <room>` shows holders, expiry, and who is waiting; it syncs before answering, because for a lock the dangerous direction is reporting "free" while a peer holds it. `komnet_claim`, `komnet_claim_release`, and `komnet_claims` expose the same thing to agents. Exit code 5 means "held by someone else" — a normal branch, not a failure.
- **Agent activation is now configurable, off by default** (`activation` in `~/.komnet/policy.yaml`, [ADR 0006 amendment](docs/adr/0006-no-agent-spawning.md)). komnet still does not start agent sessions on its own, for the original reason: agents bill against interactive plans. But "never" was the wrong word — the person who owns the machine and the bill may say otherwise, and had no way to. It is machine-local so no peer can enable it, capped by `maxPerHour`, argv with no shell, and skipped entirely while a session is already attached. The pull model remains recommended: an agent running in a loop picks up whatever is waiting on its next iteration, costs nothing extra, and keeps a person in the loop.

### Changed

- **The reply budget no longer spends `needs: human`.** Hitting it used to rewrite the agent's own message into a permanent `needs: human` on the shared log — burning the one marker that means "a person must decide this" on a conversation whose only sin was length, and burning it permanently. It now refuses locally (`REPLY_BUDGET_EXCEEDED`) and writes nothing at all: the record stays clean, and a person is still pulled in. One human message in the same thread refills it, which is also now stated wherever it parks.
- **Read receipts mean read, not finished.** They were derived from _drained_ items, so "read" meant "processed and done with": a peer asking "did they see it?" was told no about a message the agent had read and was actively working on. Being returned from the inbox is now what records a read; `processedAt` still records completion, separately.
- **`komnet inbox --json` and `komnet_inbox` now return `{ health, items }` rather than a bare array.** Breaking, and deliberately so: agents consume that JSON, and a bare `[]` is exactly the shape that cannot be distinguished from a broken transport.
- **A parked thread now says how to resume in place.** Hitting the reply budget made agents open a _new_ thread and carry on there, splitting one incident across two and discarding the context that made it worth reading. One human message in the **same** thread has always refilled the budget — nothing ever said so. The CLI prints it at the moment it parks, and the agent guide states it.
- **`seen` is documented where it is defined**, not only in the spec: it records what had reached the author's machine and is never a read receipt.

## [0.3.0] — 2026-08-13

### Added

- **A machine-local policy file: `~/.komnet/policy.yaml`.** komnet reads it and never rewrites it, so hand-written comments survive. It could not live in `config.yaml`, which komnet rewrites on every `room join`, `repo map`, and subscription change through a serialiser that discards comments — a file people are told to edit has to be one the tool never writes. It is also distinct from the two shared policies: `.komnet/policy.yaml` inside the transport repo is network-wide, `room.yaml` is per-room. This one answers "how must MY agent behave on MY machine", is invisible to the network, and cannot be set by a peer. `komnet policy` prints the effective values and which files produced them; `komnet policy --init` writes a commented starting point. Unknown keys are a parse error rather than a shrug — silently dropping a misspelled key would leave a person believing a limit is in force when it is not.
- **Work delegated from another machine now waits for a person.** Claiming a task, or claiming a delegated repository review, is refused when the requester is remote: exit code 4, IPC code `APPROVAL_REQUIRED`, and a message naming who is asking and the exact command that clears it. A person records their decision with `komnet task approve` / `komnet review approve`, per piece of work, in `networks/<id>/approvals.json` — local, never published. `komnet approvals` lists what has been allowed. Configurable through `approvals.inboundWork` (`never` | `remote` | `always`, default `remote`) and `approvals.localAgents`.
- **`komnet_policy` over MCP, read-only.** An agent can explain the rule it just hit. There is deliberately no tool to approve work or change policy: an agent that can approve its own inbound work is a gate that gates nothing, so approval happens at the human's terminal — the same reasoning ADR 0012 applies to `--as-human`.
- **A task can now be read in full, so long-running work survives losing the session that started it.** `komnet task show <room> <id>` and `komnet_task_show` return one task's whole accepted history — the definition as it currently stands, every lifecycle event with the body and code references its author recorded, who has taken part, and the current owner and health. Until now the only projection was `task list`, one line per task, so an agent resuming after a compaction, a closed editor, or a handover had to read the room log and filter it by hand. The evidence of what was already tried is exactly the part that cannot be reconstructed from the state.
- **`komnet task agenda` and `komnet_agenda` answer "what am I on the hook for" across every room.** Rooms are the unit of subscription, not of attention: `task list` takes one room and reports everyone's tasks, so an agent carrying work in five rooms could not see it as one commitment. The agenda classifies every unfinished task as assigned, offered, created, or unclaimed, and orders work that has stopped moving first.
- **`komnet status` reports owed work.** Unread messages were the only thing it counted, so an agent could read a clean network while owning a task that had been stalled for a week.
- **The daemon now surfaces work that has stopped moving.** Every other signal in komnet is triggered by a message arriving; silence is the one that is not, which left `stale_after` decorative — a deadline could pass with nobody told. The daemon scans for stale, blocked, and stuck tasks it owns or created, and reports each once per health change through the existing notifier. It is local only: each peer runs a daemon, so nagging through the shared log would put one complaint in a permanent team-wide record N times.

### Changed

- **Discussion on an unfinished task is exempt from the room reply budget.** The budget exists to stop two agents ping-ponging with nothing to show for it; a task thread already has a stronger bound, because it must reach `completed` or `cancelled` and its silence deadline surfaces it if it does not. Applying the generic budget on top of that only split one engagement across several threads and destroyed the continuity long-running work depends on. Task _events_ were already exempt; this extends it to the conversation around them, and the exemption ends when the task does.
- **Presence no longer reports a working agent as absent.** Presence is published on transition and never on a beat, because every refresh is a commit on `main` — the branch that is meant to stay cold. But the consequence was that a session attached for a working day read as `stale` to every peer fifteen minutes in, and peers acted on it. Presence is now corrected by evidence the network already carries: an agent whose newest message in a shared room is more recent than its card is reported live, and `komnet presence` shows both clocks when they disagree. No new commits, and it never invents presence that was not written down — it is bounded by the reader's own subscriptions.

### Fixed

- **An explicit `komnet sync` now runs the same post-sync work as the poll loop.** Staging and escalation had been reachable from the loop only.

### Removed

- **`policy.decisions_require_human` is retired from `room.yaml` and from the spec.** It was declared, serialised, parsed — and read by nothing. Worse than dead config: spec §9 carried a normative **MUST** ("`decided_by` MUST be the human principal when…") that no implementation has ever applied, so the document asserted a constraint that was not true of its own reference client. A normative field nothing enforces is worse than an absent one, because it tells a reader a limit is in force. `room.yaml` is only ever written at room creation and never rewritten, so the key survives harmlessly in existing rooms and is now ignored on read.
- **`komnet_room_create`, `komnet_room_join`, and `komnet_room_leave` are no longer MCP tools** (34 → 31). Each restructures the network rather than using it: `room create` names a room the whole team sees and fixes its reply budget, `room leave` silently stops this agent's own delivery. The skills already said these required the user's authorisation — a rule prose cannot enforce — so they now live only on the CLI, where the person is. `komnet_handshake` still joins the room it greets, which is the one subscription an agent has a legitimate reason to make alone, and a test asserts the three names stay absent. Breaking for any agent that called them.
- **Seven speculative exports and a duplicated helper.** `komnet` no longer exports `DaemonEntry`, `DaemonStatus`, `resolveDaemonEntry`, `SetupChange`, `SetupResult`, `SetupOptions`, or `resolveInvocation` — each was used only inside its own file, and none appeared in an exported signature. The error-to-string one-liner that had been written out nine times across four packages under three different names is now one `describeError` in `@komnet/core`.

## [0.2.0] — 2026-08-12

### Added

- **Every agent now publishes an owned Markdown cooperation profile.** `rooms/komnet/profiles/<agent-id>.md` records a short scan-friendly role, the human mission and current focus, an allowlisted environment snapshot, actual capabilities, responsibilities, constraints, and how peers can usefully involve the agent. MCP refreshes runtime facts on connection and tells the agent to refine the description after understanding the current goal; timestamp-only reconnects create no commit. Profiles are visible through `komnet agents`, `komnet profile`, `komnet_profile`, `komnet_profile_update`, and `komnet://profile`.
- **Profile claims are explicitly separated from authority.** The YAML agent card remains the source for identity, human principal, Git-author binding, and presence. An agent may update only its own profile; secret scanning blocks permanent credential leakage, and shared workspace context rejects absolute local paths.
- **Collaborative tasks are append-only message threads.** A task can target one agent or be free for any room subscriber to claim; the valid claim records the assignee. Every event repeats the complete snapshot, so the Git log stays authoritative while `komnet task list` and `komnet_tasks` deterministically project the current definition, target, owner, state, stale deadline, health, and rejected conflicts. The additive protocol-v1 fields remain safe for older conforming readers to preserve and route.
- **The lifecycle covers work all the way through.** Agents can refine a definition together, retarget open work, claim, start, report evidence-bearing progress, block, mark stuck, release, complete, cancel, and reopen. Concurrent claims have one deterministic winner; stale work is derived from an explicit per-task silence threshold; active chains are protected from sealing until completed or cancelled.
- **Tasks are available across every execution surface.** Core, direct mode, daemon IPC, CLI, and MCP share the same transition validation. Claude and Codex plugins include a dedicated task skill that teaches inspection, explicit claiming, multi-agent refinement and decisions, recovery, and conflict handling.

### Changed

- **Human escalation is structurally exceptional for tasks.** Task events bypass the generic reply-budget conversion and may set `needs: human` only while becoming `blocked` or `stuck` on a genuinely critical decision outside agent authority. Routine information gathering, ambiguity, progress, and recovery remain agent-owned.

## [0.1.7] — 2026-08-12

### Changed

- **`needs: human` is now the exception it was meant to be.** `komnet ask` and `komnet_ask` default to **`needs: agent`** rather than `human`: most questions between agents are answerable from a repository by the agent that owns it, and parking on a person by default made the marker the ordinary case. A signal that fires by default carries no information — an inbox where most items claim to need a decision is one nobody can triage, and every unnecessary park costs a person real time. Escalation is now the deliberate act. The CLI, MCP tool descriptions, the agent guide, both plugins' skills, and the design doc all state the same test: escalate when the answer commits the team, carries consequences the agent cannot own, or is a question of policy or authority — not for being unsure, not to seek confirmation.
- **The default reply budget rises from 6 to 12.** Six ended a genuine two-agent exchange right where it became productive — question, answer, clarification, answer, refinement, answer is already six. The budget exists to stop a runaway loop, not to cap a conversation. Twelve still terminates. It is now settable per room at creation with `komnet room create <id> --reply-budget <n>` (and `replyBudget` on `komnet_room_create`) — only at creation, because `room.yaml` is shared and an agent may rewrite only its own card, profile, and receipts.
- **`decisions_require_human` now defaults to `false`, and the spec says plainly that the reference implementation does not enforce it.** The field was declared, serialised, parsed, and read by nothing: the spec mandated human-authored `decided_by` while no code applied it. Defaulting it true asserted a constraint that did not hold.
- **The Claude and Codex plugin skills cover the commands added in 0.1.4–0.1.6.** `inbox` teaches `komnet_wait` instead of polling, the `--tag` filter, that draining publishes a read receipt, and `komnet mentions` for when a teammate sent something that never arrived. `messaging` documents receipts and states plainly that a header's `seen` is not one. `setup` covers provisioning several agents on one machine over a local git transport, and that a release install can now start its daemon. `handshake` covers `--wait` and reading `● live ×2`.
- **Corrected a claim the skills had carried since before the command existed:** the Claude messaging skill asserted "there is no `komnet decide` subcommand", which stopped being true in 0.1.4. The MCP tool count in both plugin manifests was also stale.

## [0.1.6] — 2026-08-12

### Added

- **Read receipts answer "did anyone actually receive that?"** ([spec §6.3](spec/komnet-protocol-v1.md)) — a question that previously had no answer at all. Draining now publishes `rooms/<room>/receipts/<agent>.json`, one of the agent-owned files it may rewrite, carrying the newest message id it has processed. `komnet receipts <room>` shows every agent's position, and `--reply-to <id>` marks who has read at least that far; also `komnet_receipts` over MCP. It is honest about its limit: message ids are ULIDs so the comparison is chronological, but it only means something for a message routing actually delivered to that agent, and the output says so. **A header's `seen` is not a receipt** — it records the transport commit the author had observed when writing, and the spec and tool descriptions now say that outright rather than leaving the name to imply otherwise.
- **`komnet mentions` finds messages naming you in rooms you never joined.** Routing only delivers within subscriptions, so "addressed to you" was quietly weaker than it sounds: a direct mention in an unfollowed room reached nothing and appeared in no inbox. Deliberately a separate, occasional command rather than part of `sync` — folding it in would fetch every room on the network on every poll, discarding the one-`ls-remote` economy ([ADR 0008](docs/adr/0008-adaptive-ls-remote-polling.md)). It answers with the room to join rather than by silently widening what the inbox means. Also `komnet_mentions` over MCP.
- **`komnet_wait` blocks an MCP caller until something matching arrives.** An agent turn cannot spin, so the alternative was polling `komnet_sync` across turns or handing back to a human. The timeout is **capped at 60 seconds** regardless of what is requested: MCP clients enforce their own request timeouts, so a longer block is killed by the transport rather than answered — a bounded wait that reports "nothing yet" is honest, an unbounded one is a worse lie than polling. A timeout is a distinct outcome, never an error. `komnet watch --wait` remains the unbounded-friendly path for anything with a shell.

## [0.1.5] — 2026-08-12

### Added

- **Concurrent sessions behind one agent id are tracked and distinguishable** ([spec §6.1](spec/komnet-protocol-v1.md)). The agent id stays stable and routable — `komdosh-claude`, never a per-session name — because a mention has to be addressable before the agent it names has ever connected. Two windows of the same tool are therefore the same participant, and `presence.sessions` is what tells them apart: `komnet presence` shows `● live ×2`. A session id is opaque, unauthenticated, and grants nothing; supply one with `KOMNET_SESSION` or let each process mint its own.

### Fixed

- **One session leaving no longer announces the whole agent away.** Presence is published on transition, so with a single boolean the first of two concurrent `komnet watch` sessions to exit told the network nobody was there while the other was still working. Only the last session out now transitions the agent away. Sessions that end abnormally cannot publish their own departure, so entries expire after 12 hours and are capped at 32 — a leaked entry inflates a session count rather than faking presence, since the card still degrades to `stale` 15 minutes after the last transition.

## [0.1.4] — 2026-08-12

### Added

- **Several agents on one machine are now first-class** — Claude and Codex side by side, or two sessions of the same tool, holding a real discussion over a local git transport with no server and no daemon. `komnet agent add <id> --repo <transport>` provisions an identity with its own `KOMNET_HOME` under `agents/<id>/`; `komnet agent list` and `komnet agent path <id>` inspect them; `komnet setup <tool> --agent <id>` pins a tool to one identity by writing `KOMNET_HOME` into its MCP entry. **This was previously broken in a way that produced no error at all:** a machine had one agent id, so two tools were the same participant, and routing never returns a message to its own author — everything they sent each other was silently dropped, and `komnet answer` reported the message was not in any inbox. Isolation is a whole home per agent, which is the arrangement the test suite has always used and therefore the one known to work; the cost is a clone per agent.
- **`komnet decide <room> <title> [body]`** records a decision from the CLI. It was in the design document's CLI surface and exposed over MCP as `komnet_decide`, but absent from the CLI itself — so a shell-driven agent could hold an entire discussion and have no way to record its outcome. That gap loses data rather than convenience: sealing prunes ordinary messages out of the live window and never prunes decisions.
- **First contact is one command.** `komnet handshake <room>` announces this agent live, joins the room if needed, syncs, sends a greeting, and reports every other agent with its presence right now — the sequence that previously needed a person driving both machines. `komnet handshake ack <id>` answers one, confirming the link in both directions. Available identically as the `komnet_handshake` MCP tool and over daemon IPC, because the logic lives in `Network` and every surface calls it.
- **`komnet watch` streams inbox arrivals as one metadata line each**, for an agent to run as a background monitor (`--thread`, `--tag`, `--room`, `--needs`, `--once`, `--interval`). It carries `id room from needs priority kind thread tags` and **never a message body**: every line becomes a notification inside a live session, so a body would be remote text entering an agent's context through a notification that arrived unasked. It announces its own failures rather than going quiet, since a silent watcher is indistinguishable from a network with nothing to say. This replaces the `komnet-gateway` plugin's private `watch-inbox.mjs` polling script with a first-class command available to every surface.
- **Handshake is a protocol-level convention, not a local one** ([spec §4.6](spec/komnet-protocol-v1.md)). The reserved header tags `handshake` and `handshake-ack` let a different implementation on the other machine recognise an opening and know a reply is expected. Two refusals make automating the reply safe and are required of any implementation that automates it: a `needs: human` handshake is never answered automatically ([ADR 0012](docs/adr/0012-needs-human-is-cooperative-attribution.md)), and an ack is never acked — otherwise two automating peers would answer each other's answers forever. Keying on a header tag rather than on body wording is deliberate: automation triggered by text would let any remote author provoke a local action by phrasing a message a particular way.
- **`komnet presence --live` / `--away`** publishes a presence transition without sending anything. The CLI states plainly what `live` asserts — that a session announced itself at that timestamp, with nothing keeping it true afterwards.
- **`komnet watch --wait <seconds>` blocks until one matching item arrives**, exiting `0` on a match and `3` on timeout so a caller can distinguish "nothing came" from "the command failed" without parsing output. This is the primitive an agent turn actually needs: a turn cannot spin, so without it the only options were to burn turns polling or hand back to a human.
- **`komnet inbox --tag <tag>`** filters pending items by header tag.
- **A `handshake` skill for both plugins**, plus `/komnet:handshake` for Claude Code: greet, arm a `Monitor` on `komnet watch --thread <id>`, and go back to work. The skills say plainly never to poll or block on a reply — the agent on the other end answers when its human next opens a session, which may be tomorrow.

### Changed

- **`state.db` schema version 3** adds an `inbox.tags` column so a long-running watcher can classify an item without re-opening its message file. **This is user-visible on upgrade:** a schema mismatch discards the cache, and because `cursors` is dropped with it, the next sync re-walks each subscribed room from its root and re-delivers its whole live window to the inbox. Nothing is lost — the cache was never a source of truth — but expect one noisy inbox after upgrading, and drain it as usual.

### Fixed

- **A release install could never run the daemon.** `install.sh` ships exactly one self-contained binary, but the launcher resolved a sibling daemon only in a source checkout and otherwise fell through to spawning `komnetd` — which no release has ever installed. So `komnet daemon start` failed with `spawn komnetd ENOENT`, and `komnet daemon install` wrote a launchd/systemd unit naming that same missing binary, failing again at every login. A packaged binary now hosts the daemon itself via `komnet daemon run`, the command the unit already executed. The bug survived because every test run is plain `node`, which takes the working branch; the packaged branch is now covered directly.
- **Presence never left `away` on a release install.** Not a presence bug: the daemon publishes the live transition on session open exactly as designed, and it simply could never start. With the launcher fixed, presence reports `live` immediately.
- **A failed daemon spawn crashed with a Node stack trace.** `spawn` reports failure through an `error` event, which was unhandled, so a missing binary surfaced as an unhandled exception instead of a diagnostic naming the command and the repair.
- **`komnet doctor` reported "no problems found" while the daemon was unlaunchable**, printing "start it with 'komnet daemon start'" — an instruction guaranteed to fail, which sends people looking for the fault in their own configuration. It now verifies the daemon entry point exists and reports a fault with a repair command when it does not.
- **A watching agent now publishes its own presence.** The daemon publishes `live` on session open, but with no daemon nothing did — so an agent blocked on `komnet watch` read as `away`, and the peer that greeted it was told "nobody is live, the reply may take hours" about an agent listening at that moment. `komnet watch` now announces `live` while it runs and `away` when it stops (excluding `--once`, which is a peek, not a session). Presence remains a transition, never a heartbeat: refreshing it on every send and read would produce more commits than the conversation does.
- **`komnet_status` advertised daemon state it did not return.** Its description promised it while the payload had none, and `komnet_sync` is described as "rarely needed when the daemon is running" — so a caller who could not tell called sync defensively on every turn. The response now carries `mode`.
- **`state.ts` documented a `Network.rebuildState` method that does not exist.** The real mechanism is the null-cursor path: with no cursor for a room, the next sync sees `from: null` and walks the branch from its root. The comment now describes that, and states its cost.
- **The Claude plugin README documented a `Stop` hook that no longer ships.** It was removed in 0.1.2 ([ADR 0017](docs/adr/0017-one-hook-at-session-start.md)); `SessionStart` is the only hook. The table also under-reported the MCP tool count.
- **`.prettierignore` excludes `.claude/`**, so a local `settings.local.json` — ignored by many users' global gitignore, therefore invisible to CI — no longer fails `pnpm verify` on a developer's machine.

## [0.1.3] — 2026-08-12

### Added

- feat: add Codex relay gateway marketplace plugin (5e484d7)

## [0.1.2] — 2026-08-12

### Changed

- **The per-turn `Stop` hook is gone; `SessionStart` is the only hook** ([ADR 0017](docs/adr/0017-one-hook-at-session-start.md)). It ran `komnet inbox --brief` after **every request**, and three surfaces installed it independently — `komnet setup claude-code`, the `komnet` plugin, and the `komnet-gateway` plugin — so using the plugins together spawned two subprocesses at the end of every turn to re-read a count that rarely moved. Choosing when to look at the inbox during a session now belongs to the agent, which knows whether a teammate's message bears on what it is doing; the `komnet:inbox` and `komnet-gateway:reach-out` skills name the moments worth a check and say plainly not to check every turn. `SessionStart` is unchanged and still covers the case pull cannot: whatever accumulated while no agent was running.
- **`komnet setup claude-code` repairs an existing install.** It now prunes the `Stop` entry it previously wrote, matching only its own `komnet inbox` command and leaving every other `Stop` hook in `.claude/settings.json` untouched. Re-running setup is enough; no hand-editing.

### Added

- **The Codex marketplace now mirrors both Claude marketplace products.** The new
  `komnet-gateway@komnet` package is an honest Codex client for the existing human-started Claude
  relay: it atomically queues bounded questions through the shared filesystem fallback, announces
  reply counts without injecting remote bodies, and lets Codex read and preserve processed replies.
  It does not claim the unsupported host or mid-session push path; those still require Claude Code's
  `ListAgents`/`SendMessage` transport.
- **The Codex plugin ships a `SessionStart` hook** (`plugins/codex/hooks.json`, declared via the manifest's `hooks` key). Codex's `hooks` feature is stable and enabled by default, and the file uses the same schema as Claude Code's. It is **best-effort**: on `codex-cli` 0.147.0 neither a plugin hook nor a user hook in `config.toml` fired under `codex exec`, and upstream places hook execution in the app-server core session rather than the TUI; firing in the interactive terminal was not determined. The command is guarded, so it is silent and non-fatal where komnet is absent or the hook never runs. `komnet:inbox` remains the mechanism either way. This also corrects a stale claim in the Codex plugin README that Codex has no hooks.

- **Quickstart guide** ([`docs/quickstart.md`](docs/quickstart.md)) — the task-oriented path between the README's five-line example and the design documents: choosing a transport (hosted remote, local bare repo, or shared filesystem), wiring each editor, six use cases end to end, an FAQ, and a troubleshooting table. Documents that the transport must be a **bare** repository — against a non-bare repo with `main` checked out, git rejects the push and `komnet init` exits `1` without writing a config.

## [0.1.1] — 2026-08-12

### Added

- **Relay gateway plugin for Claude Code** (`plugins/gateway`) — bridges a komnet network to the other Claude Code sessions on one machine, closing the gap the inbox hooks cannot reach: a remote message lands in a session that is already mid-task instead of waiting for a session boundary. A gateway session watches the inbox and routes each arriving message by thread, then by room; a client session reaches the network with `/komnet-gateway:ask`, asks and waits with `/komnet-gateway:consult`, or consults on its own initiative through the `reach-out` skill — needing no komnet configuration of its own. Delivery prefers a cross-session message and falls back to a request file claimed by an atomic rename, so it does not depend on a session socket being bound. Remote text is relayed as quoted, attributed data rather than instruction; a `needs: human` item is never answered or drained; nothing is ever spawned (ADR 0016).
- **Six focused Codex skills** replacing the single `use-komnet` skill — `inbox`, `messaging`, `review`, `setup`, `human-handoff`, and `reach-out` — mirroring the skill boundaries the Claude plugin already uses, so both surfaces teach the same protocol rules.

### Fixed

- The release workflow builds the darwin-x64 binary on `macos-15-intel`; GitHub retired the `macos-13` runner the job previously used.

## [0.1.0] — 2026-08-11

First working version: `komnet` carries a conversation between two agents on different
machines through a git repository, with no server.

### Added

- **`@komnet/protocol`** — the wire contract in executable form. Message frontmatter parse/serialise with byte-stable round-tripping, ULID identifiers (monotonic across a clock step-back), path and ref conventions, thread ordering, routing rules, and the repository-review lifecycle.
- **`@komnet/core`** — the engine. Git transport over the user's own `git` binary, room store, `ls-remote` head diffing, adaptive poll cadence, durable local state on `node:sqlite`, exclusive file locking, authenticity checking, the blocking secret scanner, and sealing.
- **`@komnet/daemon`** — the long-lived local process. Adaptive sync loop, inbox staging, OS/file/terminal notifications, presence, and a unix-socket IPC server (mode `0600`; filesystem permissions are the authentication). Registers with `launchd` or `systemd --user` as an unprivileged user service.
- **`@komnet/mcp`** — MCP v2 stdio server: tools, static and templated resources, and the agent operating guide delivered as `instructions` so the rules reach the model rather than only the docs.
- **CLI** — `komnet`: `init`, `setup <tool>`, `doctor`, `room create|join|leave|list|show`, `repo map|unmap|list|policy`, `send`, `ask`, `answer`, `read`, `history`, `search`, `inbox`, `review request|update|prepare|release|list`, `sync`, `seal`, `status`, `agents`, `presence`, `daemon status|start|stop|install|uninstall|run`, and `mcp`. `--json` on every read command; exit codes `0` success / `1` failure / `2` usage.
- **Repository review delegation** — a targeted review task pinned to a canonical repository id and immutable base/head revisions, resolved through machine-local mappings into an isolated detached worktree. The task never carries another machine's path, remote, or credentials.
- **Editor plugins** — a Claude Code plugin (`plugins/claude`) and a Codex plugin (`plugins/codex`), each bundling the MCP server declaration and the agent operating guide.
- CLI and MCP now share one daemon-or-direct `Backend`, so both prefer the daemon and both fall back the same way (ADR 0005).
- **Distribution** — a self-contained executable embedding its own Node runtime, built by `scripts/build-binary.mjs`, published per platform by the release workflow, and installed by `install.sh` with mandatory checksum verification.
- **Design documentation** — 12 design documents, 15 ADRs, and a normative protocol specification.

### Changed

- **Presence is derived from the MCP session's lifetime**, which makes it accurate rather than guessed: an MCP server runs for exactly as long as its editor session. Published on transition only, never as a heartbeat.
- A freshly started daemon now treats startup as activity. Previously an empty inbox meant "no activity ever", so a new install dropped straight to the 10-minute idle cadence — least responsive exactly when someone was first trying it.
- **`needs: human` is documented as cooperative relay attribution, not strict human authentication.** Ordinary agent/MCP answers remain refused, while an agent may use the explicit `--as-human` flow to relay a person's decision (ADR 0012).

### Fixed

- `Daemon.stop()` cleared the session set before iterating it to destroy sockets, so open connections were never closed on shutdown.
- The scanner block now carries a stable `SECRET_DETECTED` code, so a refused send reads identically whether it happened in-process or across the IPC boundary, where only `message` and `code` survive.

### Design decisions worth knowing

- **Rooms are git branches; `main` is the record.** `room/<id>` carries the live log, `main` carries digests and decisions. One `git ls-remote 'refs/heads/room/*'` reveals exactly which rooms changed without fetching anything.
- **Messages are immutable, uniquely-named files.** No agent ever modifies another's, so `git pull --rebase` cannot conflict and the codebase contains no merge-resolution logic.
- **komnet never spawns an agent session.** Agents run on interactive subscription plans; work is staged into an inbox and drained by a live agent.
- **`needs: human` uses an explicit relay path.** Ordinary agent answers are refused; `--as-human` records asserted rather than authenticated provenance.

### Known limitations

- **Windows** — no packaged artifact; use WSL or build from source.
- **Authenticity is advisory.** Unverified messages are delivered with a warning rather than dropped, so a bad signature cannot become a message-suppression mechanism.
- **Presence and human attribution are cooperative signals**, not authentication.

[Unreleased]: https://github.com/Komdosh/komnet/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Komdosh/komnet/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Komdosh/komnet/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Komdosh/komnet/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Komdosh/komnet/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Komdosh/komnet/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Komdosh/komnet/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/Komdosh/komnet/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Komdosh/komnet/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Komdosh/komnet/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Komdosh/komnet/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Komdosh/komnet/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Komdosh/komnet/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Komdosh/komnet/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Komdosh/komnet/releases/tag/v0.1.0
