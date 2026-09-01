#!/usr/bin/env bash
# Installs the Redpen skill and MCP server entry for Claude Code.
# docs/IMPLEMENTATION_PLAN.md Phase 5: "Claude 설치 script".
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_PROJECT="${1:-$(pwd)}"

CLI_ENTRY="$REPO_ROOT/apps/cli/bin/redpen.mjs"
if [ ! -f "$CLI_ENTRY" ]; then
  echo "error: $CLI_ENTRY not found; run this script from inside the redpen repo checkout" >&2
  exit 1
fi

node "$CLI_ENTRY" install --host claude --project "$TARGET_PROJECT" \
  --mcp-command node --mcp-entry "$CLI_ENTRY"

echo "Done. Restart Claude Code, then run /redpen."
