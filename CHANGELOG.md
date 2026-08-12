# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is
`0.x`, the protocol and CLI surface may change between minor versions.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/Komdosh/komnet/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Komdosh/komnet/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Komdosh/komnet/releases/tag/v0.1.0
