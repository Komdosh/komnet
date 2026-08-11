# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is
`0.x`, the protocol and CLI surface may change between minor versions.

## [Unreleased]

### Added

- **`@kom-net/daemon`** — the long-lived local process. Adaptive sync loop, inbox staging, OS/file/terminal notifications, presence, and a unix-socket IPC server (mode `0600`; filesystem permissions are the authentication). Registers with `launchd` or `systemd --user` as an unprivileged user service.
- **`@kom-net/mcp`** — MCP v2 stdio server: 15 tools, static and templated resources, and the agent operating guide delivered as `instructions` so the rules reach the model rather than only the docs.
- **CLI** — `komnet daemon status|start|stop|install|uninstall|run`, `komnet mcp`, `komnet setup <tool>` (claude-code, claude-desktop, cursor, codex), and `komnet presence`.
- CLI and MCP now share one daemon-or-direct `Backend`, so both prefer the daemon and both fall back the same way (ADR 0005).

### Changed

- **Presence is derived from the MCP session's lifetime**, which makes it accurate rather than guessed: an MCP server runs for exactly as long as its editor session. Published on transition only, never as a heartbeat.
- A freshly started daemon now treats startup as activity. Previously an empty inbox meant "no activity ever", so a new install dropped straight to the 10-minute idle cadence — least responsive exactly when someone was first trying it.

### Fixed

- `Daemon.stop()` cleared the session set before iterating it to destroy sockets, so open connections were never closed on shutdown.
- The scanner block now carries a stable `SECRET_DETECTED` code, so a refused send reads identically whether it happened in-process or across the IPC boundary, where only `message` and `code` survive.

## [0.1.0] — unreleased

First working version: `komnet` carries a conversation between two agents on different
machines through a git repository, with no server.

### Added

- **`@kom-net/protocol`** — the wire contract in executable form. Message frontmatter parse/serialise with byte-stable round-tripping, ULID identifiers (monotonic across a clock step-back), path and ref conventions, thread ordering, and routing rules.
- **`@kom-net/core`** — the engine. Git transport over the user's own `git` binary, room store, `ls-remote` head diffing, adaptive poll cadence, durable local state on `node:sqlite`, exclusive file locking, and the blocking secret scanner.
- **`@kom-net/cli`** — `komnet`: `init`, `room create|join|leave|list|show`, `send`, `ask`, `answer`, `read`, `history`, `search`, `inbox`, `sync`, `status`, `agents`, `doctor`. `--json` on every read command; exit codes `0` success / `1` failure / `2` usage.
- **Distribution** — a self-contained executable embedding its own Node runtime, built by `scripts/build-binary.mjs`, published per platform by the release workflow, and installed by `install.sh` with mandatory checksum verification.
- **Design documentation** — 11 design documents, 11 ADRs, and a normative protocol specification.

### Design decisions worth knowing

- **Rooms are git branches; `main` is the record.** `room/<id>` carries the live log, `main` carries digests and decisions. One `git ls-remote 'refs/heads/room/*'` reveals exactly which rooms changed without fetching anything.
- **Messages are immutable, uniquely-named files.** No agent ever modifies another's, so `git pull --rebase` cannot conflict and the codebase contains no merge-resolution logic.
- **kom-net never spawns an agent session.** Agents run on interactive subscription plans; work is staged into an inbox and drained by a live agent.
- **A `needs: human` message cannot be answered by an agent.** Enforced, not advisory.

### Not implemented yet

- **Daemon** — so nothing accumulates an inbox while your agent is closed, and no notification ever fires. Delivery is pull-based via `komnet sync`.
- **MCP server** — agents use the CLI, which is the universal surface.
- **Sealing / compaction** — designed in detail; retention is not yet enforced.
- **Presence** — depends on the daemon.
- **Windows** — no packaged artifact; use WSL or build from source.

[Unreleased]: https://github.com/Komdosh/kom-net/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Komdosh/kom-net/releases/tag/v0.1.0
