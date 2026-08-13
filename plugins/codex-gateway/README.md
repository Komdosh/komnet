# komnet gateway — Codex client plugin

Connects Codex to the portable filesystem side of the
[`komnet-gateway`](../gateway/README.md) relay. A human-started Claude Code session hosts the relay;
Codex queues focused cross-team questions and reads attributed replies for the current repository.

## Install

```console
codex plugin marketplace add Komdosh/komnet --ref main
codex plugin add komnet-gateway@komnet
```

Start a new Codex thread after installation. The plugin does not register another MCP server, so it
can be installed alongside `komnet@komnet`.

## Capabilities and boundary

| Component                        | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `komnet-gateway:reach-out`       | Queue one bounded question for the local gateway              |
| `komnet-gateway:gateway-replies` | List, read, attribute, and finish reply files                 |
| `SessionStart` hook              | Announce reply count for this repository; never inject bodies |

Codex uses the gateway's filesystem fallback. It cannot use Claude Code's cross-session sockets,
host `/komnet-gateway:relay`, or receive mid-session push. If no gateway host has initialized the
request directory, the queue script refuses instead of creating work nobody will claim.

The gateway host requires the `komnet` CLI and Node on `PATH`. This Codex client requires Node and
the host's shared `${KOMNET_HOME:-~/.komnet}/gateway` state.
