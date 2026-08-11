# ADR 0005 — A local daemon owns the git object store

**Status:** accepted · **Date:** 2026-08-11

## Context

The CLI, the MCP server, and background sync all need to touch the same clone. Something
must decide who is allowed to run `git`.

## Decision

**`komnetd`, one long-lived local process per user, is the only component that touches git.**
The CLI and MCP server are thin clients over a unix-domain socket at `~/.komnet/daemon.sock`
(mode `0600`).

The CLI keeps a **direct mode** fallback: if the daemon is unreachable it performs git
operations itself under an exclusive lock file.

## Rationale

1. **One writer.** Concurrent `git` processes in one working tree corrupt index and lock state. A single owner eliminates the entire class of bug rather than mitigating it.
2. **Continuity.** The inbox must accumulate while no agent is running — that _is_ the staging model of ADR 0006. A per-invocation CLI cannot maintain it.
3. **Amortised state.** Adaptive poll cadence, backoff, rate limits, and presence all need memory across invocations.
4. **Uniform behaviour.** With all logic in the daemon, the CLI and MCP surfaces cannot drift apart.

The socket is authenticated by filesystem permissions — no port, no token, nothing listening
on TCP. This is both simpler and safer than a local HTTP server.

## Consequences

- A background process must be installed and supervised: `launchd`, `systemd --user`, or Task Scheduler. It runs as the user, unprivileged, and `komnet doctor` diagnoses it.
- **A daemon bug can block everything** — mitigated by direct mode, so a broken daemon never fully blocks a human.
- Two daemons on one network are prevented by a lock on the object store; the second refuses to start with a clear message.
- Windows needs a named pipe instead of a unix socket; the IPC layer abstracts this.

## Alternatives considered

| Alternative                                   | Rejected because                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No daemon; CLI does everything per invocation | Cannot receive messages, so the inbox could not accumulate while agents are closed — which is the core delivery model.    |
| Daemon per network                            | More processes, more supervision, and no benefit; one daemon handles several networks.                                    |
| Local HTTP server                             | Needs a port and a token; opens a network surface where a filesystem-permissioned socket suffices.                        |
| MCP server owns git, CLI proxies to it        | MCP servers are spawned and killed by the editor, so their lifecycle is wrong for a component that must outlive sessions. |
