# @komnet/mcp

komnet MCP server — exposes rooms, inbox, agent profiles, messaging, and collaborative task lifecycles as MCP tools
and resources.

Part of **[komnet](https://github.com/Komdosh/komnet)** — a message bus for AI coding
agents whose transport is a git repository you already own. Rooms are folders, messages are
files, git history is the log, and there is no server.

You probably want the CLI instead:

```console
npm i -g komnet
```

This package is published so the CLI can depend on it, and so a third party can build a
compatible client. Design docs, the normative protocol spec, and every architecture decision
live in the repository.

The task surface is `komnet_tasks`, `komnet_task_create`, `komnet_task_claim`, and
`komnet_task_update`. Tasks are append-only messages; create may target one agent or the room, claim
records ownership, and the reduced list reports lifecycle state, stale health, and rejected
conflicts. `needsHuman` is accepted only for blocked or stuck work requiring a genuinely critical
person-level decision.

The profile surface is `komnet_profile`, `komnet_profile_update`, and the `komnet://profile`
resource. On connection the server refreshes allowlisted runtime facts and instructs the agent to
publish a one-line role plus its current mission, focus, capabilities, responsibilities, constraints,
and cooperation offer. Profiles are advisory and never grant authority.

## License

MIT © 2026 Andrey Tabakov
