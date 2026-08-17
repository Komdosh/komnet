# Introspection image

Built for MCP directory listings — Glama and the checks that mirror it — which
verify a server by starting it and reading `tools/list`.

```console
docker build -t komnet-introspect -f docker/introspection/Dockerfile .
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | docker run -i --rm komnet-introspect
```

## What it is not

It is **not** a way to run komnet, and adding it does not reverse
[ADR 0011](../../docs/adr/0011-self-contained-binary-distribution.md). A daemon
in a container is cut off from the git credentials, SSH agent and home directory
it exists to use. Install the binary instead.

## Why an entrypoint at all

`komnet mcp` refuses to start unconfigured — a transport repository is not
optional, and failing loudly beats serving an empty network. A directory check
has no repository to offer, so the entrypoint provisions a throwaway bare repo
inside the container. The server answering is real; the network it answers about
is disposable, and a mounted `$KOMNET_HOME` skips that branch entirely.

The Dockerfile carries no `COPY`, so it builds identically whether the context is
this directory or the repository root — a directory that picks its own build
context still gets a working image.
