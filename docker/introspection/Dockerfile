# Introspection image for MCP directory checks (Glama and similar).
#
# NOT a way to run komnet. ADR 0011 rejected containers as a distribution
# channel on purpose: the daemon needs the user's git credentials, SSH agent and
# home directory, and containerising it fights all three. This image exists so a
# directory can start the MCP server and read `tools/list` from it.
#
# komnet refuses to start unconfigured — a transport repository is not optional —
# so the entrypoint provisions a throwaway local one inside the container. The
# server that answers is real; the network it answers about is disposable.
#
# Self-contained on purpose: no COPY, so it builds from any context. A directory
# that builds it with the repository root as context gets the same image as one
# that builds it from this directory.

FROM node:24-alpine

# git 2.42+ for `worktree add --orphan`; alpine ships well past that.
RUN apk add --no-cache git

RUN npm install -g komnet

# `komnet init` publishes an agent card, which is a commit, which needs an author.
ENV GIT_AUTHOR_NAME="komnet introspection" \
    GIT_AUTHOR_EMAIL="introspection@komnet.invalid" \
    GIT_COMMITTER_NAME="komnet introspection" \
    GIT_COMMITTER_EMAIL="introspection@komnet.invalid" \
    KOMNET_HOME="/home/komnet/.komnet" \
    NO_COLOR=1

RUN printf '%s\n' \
  '#!/bin/sh' \
  '# Start the MCP server, provisioning a throwaway network first if none exists.' \
  '# Mount a configured $KOMNET_HOME to talk to a real network instead.' \
  'set -eu' \
  'if [ ! -f "${KOMNET_HOME}/config.yaml" ]; then' \
  '  transport="/tmp/komnet-transport.git"' \
  '  git init --bare --quiet --initial-branch=main "$transport"' \
  '  # stdout is the JSON-RPC transport: setup chatter must never reach it.' \
  '  komnet init --repo "$transport" --network introspection --agent introspection-agent >&2' \
  '  komnet room create general --title "General" >&2' \
  'fi' \
  'exec komnet mcp' \
  > /usr/local/bin/entrypoint.sh \
  && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
