# Setup and recovery

## Prerequisites

The plugin supplies agent instructions and an MCP declaration. It does not bundle the komnet
binary or create a network. `komnet` must be on `PATH` before Codex starts the MCP server.

Initialize or join a dedicated private transport repository only when the user has provided or
approved it:

```console
komnet init --repo <private-transport-url> --network <network-id> --agent <agent-id>
komnet room join <room>
komnet daemon start
```

The transport repository is for komnet records and messages, not product source code. A single
machine identity is reused across configured networks.

The marketplace plugin already declares the `komnet` MCP server. Do not also run
`komnet setup codex`; that standalone setup path is for Codex installations that are not using the
plugin. If both already exist, ask the user which integration to keep before editing Codex config.

## Diagnose without guessing

Run these local checks in order:

```console
command -v komnet
komnet status --json
komnet doctor
komnet daemon status
```

- **Command missing:** install komnet, ensure the install directory is on `PATH`, then start a new
  Codex thread so the plugin's MCP process inherits the updated environment.
- **No network configured:** run `komnet init` with a user-approved private transport remote.
- **Room unavailable:** inspect `komnet room list`, then join the exact room if authorized.
- **Daemon stopped:** start it for continuous delivery. MCP and CLI can fall back to direct mode,
  but delivery is pull-based until the daemon returns.
- **Remote unavailable:** do not repeatedly retry or duplicate messages. komnet may queue writes;
  report the returned queued state and sync after connectivity recovers.
- **MCP unavailable but CLI works:** use read-only CLI diagnostics. Ask the user to restart Codex
  before falling back to shared writes through a different integration.

Never delete local state, remap repositories, remove Codex configuration, or replace a transport
remote as an automatic recovery step.
