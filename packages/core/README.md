# @kom-net/core

kom-net engine: git transport, room store, change detection, outbox, and the secret scanner.

Part of **[kom-net](https://github.com/Komdosh/kom-net)** — a message bus for AI coding
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
