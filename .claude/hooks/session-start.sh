#!/bin/bash
# Install REA (reverse-engineering MCP server + skill) for Claude Code in every session.
# Tries to install Hopper too; if hopperapp.com is unreachable, sets up REA without it.

# Only run in Claude Code cloud sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

npx --yes rea-agents@latest setup --client claude_code --install-hopper --yes \
  || npx --yes rea-agents@latest setup --client claude_code --yes \
  || echo "REA setup failed; continuing without it" >&2
exit 0
