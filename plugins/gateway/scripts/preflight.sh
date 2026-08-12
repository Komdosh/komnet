#!/usr/bin/env sh
# Preflight for the relay gateway: prove the machine-side half of the relay is
# healthy before a session commits to sitting in a watch loop for hours.
#
# Deliberately reports only what it can ground in komnet's own output and the
# filesystem. Whether *this* session is addressable by other Claude sessions is
# not decided here — that is what `ListAgents` reports, and the relay command
# asks the agent to check it there rather than having a shell script guess from
# Claude Code's private session registry, which is undocumented and would rot.
#
# Prints a plain-text report and exits 0 when the gateway can run, 1 when it
# cannot. Never prints message bodies.

set -u

KOMNET_HOME_DIR="${KOMNET_HOME:-$HOME/.komnet}"
GATEWAY_DIR="$KOMNET_HOME_DIR/gateway"
fatal=0

echo "komnet relay gateway — preflight"
echo

if command -v komnet >/dev/null 2>&1; then
  echo "  komnet     $(komnet --version 2>/dev/null || echo 'present (version unknown)')"
else
  echo "  komnet     MISSING — install it and re-run; the gateway is a thin"
  echo "             surface over the CLI and cannot work without it."
  fatal=1
fi

if command -v node >/dev/null 2>&1; then
  echo "  node       $(node --version 2>/dev/null)"
else
  echo "  node       MISSING — scripts/watch-inbox.mjs needs it. If you installed"
  echo "             the self-contained komnet binary you may not have node;"
  echo "             install Node 20+ or run the gateway on a machine that has it."
  fatal=1
fi

if [ "$fatal" -eq 0 ]; then
  # `komnet status` already prints identity, rooms, pending counts and daemon
  # state in exactly the shape this report wants, so reuse it verbatim rather
  # than re-deriving it from --json. Non-zero means no network configured here.
  if status_out=$(komnet status 2>/dev/null); then
    echo "  network    configured"
    printf '%s\n' "$status_out" | sed 's/^/  /'
  else
    echo "  network    NOT CONFIGURED — run 'komnet init --repo <url>' first."
    fatal=1
  fi
fi

# The request drop directory is the path a local session uses when it cannot
# reach the gateway over a cross-session socket. Create it now so the watcher
# can establish an fs.watch on it immediately instead of falling back to polling.
if mkdir -p "$GATEWAY_DIR/requests" "$GATEWAY_DIR/claimed" "$GATEWAY_DIR/replies" 2>/dev/null; then
  echo "  drop dir   $GATEWAY_DIR/requests"
else
  echo "  drop dir   COULD NOT CREATE under $GATEWAY_DIR — the socket path will"
  echo "             still work, but sessions with no inbox socket cannot queue."
fi

echo
if [ "$fatal" -ne 0 ]; then
  echo "Preflight failed. Fix the items above, then re-run /komnet-gateway:relay."
  exit 1
fi

echo "Preflight OK. Remaining checks are session-level and belong to the agent:"
echo "  1. ListAgents — confirm this session is listed and note its own name."
echo "  2. Start the daemon if it is not running, so sync stays hot and this"
echo "     machine's presence reads 'live' to the rest of the network."
exit 0
