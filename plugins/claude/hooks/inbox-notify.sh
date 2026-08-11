#!/usr/bin/env sh
# Stop hook: tell the HUMAN when new komnet messages arrived during the turn, so
# a teammate's question is not left sitting until the next session.
#
# Emits `systemMessage`, not `hookSpecificOutput.additionalContext`, on purpose.
# additionalContext on Stop continues the conversation; a pending `needs: human`
# item is something the agent structurally cannot clear, so that would restart
# the turn on every single stop. A systemMessage informs the person and lets the
# turn end.
#
# Only a digit-only count reaches the JSON payload, so no message text from
# another machine is ever interpolated into it.
#
# Fires only when the pending count has GROWN since the last notice, so an item
# parked on an absent human does not nag once per turn forever.

set -u

command -v komnet >/dev/null 2>&1 || exit 0

brief=$(komnet inbox --brief 2>/dev/null) || exit 0

# `renderInboxBrief` prints nothing when empty, else a `komnet: N pending ...`
# header. Anything that is not a plain integer is treated as "cannot tell" and
# the hook stays silent rather than guessing.
count=$(printf '%s\n' "$brief" | sed -n 's/^komnet: \([0-9][0-9]*\) pending.*/\1/p' | head -n 1)
[ -n "$count" ] || count=0
case "$count" in
*[!0-9]*) exit 0 ;;
esac

state_dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
mkdir -p "$state_dir" 2>/dev/null || exit 0
# cksum keeps the filename short and stable regardless of how deep the project
# path is; the count is tracked per project directory, not globally.
key=$(printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}" | cksum | cut -d' ' -f1)
state_file="$state_dir/komnet-stop-$key"

previous=$(cat "$state_file" 2>/dev/null) || previous=0
[ -n "$previous" ] || previous=0
case "$previous" in
*[!0-9]*) previous=0 ;;
esac

printf '%s' "$count" >"$state_file" 2>/dev/null || true

[ "$count" -gt "$previous" ] || exit 0

printf '{"systemMessage":"komnet: %s message(s) pending. Run /komnet:inbox to triage."}\n' "$count"
exit 0
