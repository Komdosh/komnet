#!/usr/bin/env sh
# Stop hook: tell the HUMAN when an answer came back during the turn.
#
# Emits `systemMessage`, not `hookSpecificOutput.additionalContext`, on purpose.
# additionalContext on Stop continues the conversation, so a reply the agent
# chooses not to act on would restart the turn on every stop, forever. A
# systemMessage informs the person and lets the turn end.
#
# Only a digit-only count reaches the JSON payload, so no text from another
# machine is ever interpolated into it.
#
# Fires only when the waiting count has GROWN since the last notice, so a reply
# left sitting does not nag once per turn.

set -u

KOMNET_HOME_DIR="${KOMNET_HOME:-$HOME/.komnet}"

key=$(printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}" | cksum | cut -d' ' -f1)
pending_dir="$KOMNET_HOME_DIR/gateway/replies/$key/pending"

[ -d "$pending_dir" ] || exit 0

count=$(find "$pending_dir" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
[ -n "$count" ] || count=0
case "$count" in
*[!0-9]*) exit 0 ;;
esac

state_dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
mkdir -p "$state_dir" 2>/dev/null || exit 0
state_file="$state_dir/komnet-gateway-replies-$key"

previous=$(cat "$state_file" 2>/dev/null) || previous=0
[ -n "$previous" ] || previous=0
case "$previous" in
*[!0-9]*) previous=0 ;;
esac

printf '%s' "$count" >"$state_file" 2>/dev/null || true

[ "$count" -gt "$previous" ] || exit 0

printf '{"systemMessage":"komnet: %s reply(ies) came back from the network for this project."}\n' "$count"
exit 0
