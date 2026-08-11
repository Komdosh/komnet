# @komnet/daemon

komnet daemon: continuous sync, inbox staging, notifications, presence, and the local IPC server.

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

## License

MIT © 2026 Andrey Tabakov
