#!/bin/bash
# Install REA (reverse-engineering MCP server + skill) for Claude Code in every session.
# Tries to install Hopper too; if hopperapp.com is unreachable, sets up REA without it.
# Runs in the background ("async": true in .claude/settings.json) so it doesn't delay
# session startup. When a newer REA is pinned, its JSON output tells Claude to notify the user.

# Only run in Claude Code cloud sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Pin REA to a known version, checking npm for a newer one at most once a day.
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/rea-agents"
pin_file="$cache_dir/pinned-version"
mkdir -p "$cache_dir"

pinned=$(cat "$pin_file" 2>/dev/null)
if [ -z "$pinned" ] || [ -z "$(find "$pin_file" -mtime -1 2>/dev/null)" ]; then
  latest=$(npm view rea-agents version 2>/dev/null)
  if [ -n "$latest" ]; then
    # Only move forward: keep the pinned version unless npm has a newer one.
    newest=$(printf '%s\n%s\n' "$pinned" "$latest" | sed '/^$/d' | sort -V | tail -n1)
    if [ "$newest" != "$pinned" ]; then
      echo "REA: pinning rea-agents@$newest (was ${pinned:-none})" >&2
      [ -n "$pinned" ] && upgraded_from="$pinned"
    fi
    pinned="$newest"
  fi
  # Record the check (even if npm was unreachable) so we retry tomorrow, not every session.
  [ -n "$pinned" ] && echo "$pinned" > "$pin_file"
fi
pkg="rea-agents@${pinned:-latest}"

notify() {
  [ -n "${upgraded_from:-}" ] || return 0
  msg="REA (rea-agents) was updated from $upgraded_from to $pinned by the session start hook."
  printf '{"systemMessage": "%s", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s Tell the user about this update in your next reply."}}\n' "$msg" "$msg"
}
trap notify EXIT

# Skip setup if this version is already registered and the skill is installed.
if [ -n "$pinned" ] \
  && grep -q "rea-agents@$pinned" "$HOME/.claude.json" 2>/dev/null \
  && [ -d "$HOME/.claude/skills/reverse-engineer-anything" ]; then
  exit 0
fi

# Setup output goes to stderr so stdout carries only the hook's JSON notice.
npx --yes "$pkg" setup --client claude_code --install-hopper --yes >&2 \
  || npx --yes "$pkg" setup --client claude_code --yes >&2 \
  || echo "REA setup failed; continuing without it" >&2
exit 0
