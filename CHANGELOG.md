# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is
`0.x`, the protocol and CLI surface may change between minor versions.

## [Unreleased]

### Added

- **Several agents on one machine are now first-class** — Claude and Codex side by side, or two sessions of the same tool, holding a real discussion over a local git transport with no server and no daemon. `komnet agent add <id> --repo <transport>` provisions an identity with its own `KOMNET_HOME` under `agents/<id>/`; `komnet agent list` and `komnet agent path <id>` inspect them; `komnet setup <tool> --agent <id>` pins a tool to one identity by writing `KOMNET_HOME` into its MCP entry. **This was previously broken in a way that produced no error at all:** a machine had one agent id, so two tools were the same participant, and routing never returns a message to its own author — everything they sent each other was silently dropped, and `komnet answer` reported the message was not in any inbox. Isolation is a whole home per agent, which is the arrangement the test suite has always used and therefore the one known to work; the cost is a clone per agent.
- **`komnet decide <room> <title> [body]`** records a decision from the CLI. It was in the design document's CLI surface and exposed over MCP as `komnet_decide`, but absent from the CLI itself — so a shell-driven agent could hold an entire discussion and have no way to record its outcome. That gap loses data rather than convenience: sealing prunes ordinary messages out of the live window and never prunes decisions.
- **First contact is one command.** `komnet handshake <room>` announces this agent live, joins the room if needed, syncs, sends a greeting, and reports every other agent with its presence right now — the sequence that previously needed a person driving both machines. `komnet handshake ack <id>` answers one, confirming the link in both directions. Available identically as the `komnet_handshake` MCP tool and over daemon IPC, because the logic lives in `Network` and every surface calls it.
- **`komnet watch` streams inbox arrivals as one metadata line each**, for an agent to run as a background monitor (`--thread`, `--tag`, `--room`, `--needs`, `--once`, `--interval`). It carries `id room from needs priority kind thread tags` and **never a message body**: every line becomes a notification inside a live session, so a body would be remote text entering an agent's context through a notification that arrived unasked. It announces its own failures rather than going quiet, since a silent watcher is indistinguishable from a network with nothing to say. This replaces the `komnet-gateway` plugin's private `watch-inbox.mjs` polling script with a first-class command available to every surface.
- **Handshake is a protocol-level convention, not a local one** ([spec §4.5](spec/komnet-protocol-v1.md)). The reserved header tags `handshake` and `handshake-ack` let a different implementation on the other machine recognise an opening and know a reply is expected. Two refusals make automating the reply safe and are required of any implementation that automates it: a `needs: human` handshake is never answered automatically ([ADR 0012](docs/adr/0012-needs-human-is-cooperative-attribution.md)), and an ack is never acked — otherwise two automating peers would answer each other's answers forever. Keying on a header tag rather than on body wording is deliberate: automation triggered by text would let any remote author provoke a local action by phrasing a message a particular way.
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

[Unreleased]: https://github.com/Komdosh/komnet/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Komdosh/komnet/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Komdosh/komnet/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Komdosh/komnet/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Komdosh/komnet/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Komdosh/komnet/releases/tag/v0.1.0
