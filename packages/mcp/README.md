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

The task surface is `komnet_tasks`, `komnet_task_create`, `komnet_task_claim`,
`komnet_task_update`, `komnet_task_show`, and `komnet_agenda`. Tasks are append-only messages;
create may target one agent or the room, claim records ownership, and the reduced list reports
lifecycle state, stale health, and rejected conflicts. `needsHuman` is accepted only for blocked or
stuck work requiring a genuinely critical person-level decision.

Creating, joining, and leaving rooms are **not** exposed as tools. Each restructures the network
rather than using it — `room create` names a room the whole team sees and fixes its reply budget,
`room leave` silently stops this agent's own delivery — so they live only on the CLI, where the
person is. `komnet_handshake` still joins the room it greets, which is the one subscription an agent
has a legitimate reason to make on its own. A test asserts these tool names stay absent.

`komnet_policy` is read-only and reports this machine's local rules — chiefly whether a person must
approve before this agent takes on delegated work. By default, claiming a task or review delegated
from another machine fails with `APPROVAL_REQUIRED`; that is policy, not an error, and the agent's
job is to surface it rather than retry. There is deliberately **no** tool to approve or to change
policy: approval happens at the human's own terminal, because an agent that could approve its own
inbound work would be a gate that gates nothing.

`komnet_task_show` returns one task's whole accepted history — definition, every event with its
body and code references, participants — which is how a session that no longer holds the context
resumes work already in flight. `komnet_agenda` returns unfinished work involving this agent across
every subscribed room, ordered with anything that has stopped moving first; it answers "what am I on
the hook for", where `komnet_tasks` answers "what exists in this room".

The profile surface is `komnet_profile` (action=read / action=update) and the `komnet://profile`
resource. On connection the server refreshes allowlisted runtime facts and instructs the agent to
publish a one-line role plus its current mission, focus, capabilities, responsibilities, constraints,
and cooperation offer. Profiles are advisory and never grant authority.

## License

MIT © 2026 Andrey Tabakov
