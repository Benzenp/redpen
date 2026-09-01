#!/usr/bin/env bash
# Installs the Redpen skill and MCP server entry for Codex CLI.
# docs/IMPLEMENTATION_PLAN.md Phase 5: "Codex 설치 script".
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills/redpen"
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"

mkdir -p "$CODEX_SKILLS_DIR"
cp "$SKILL_DIR/SKILL.md" "$CODEX_SKILLS_DIR/SKILL.md"
echo "Copied SKILL.md to $CODEX_SKILLS_DIR"

CLI_ENTRY="$REPO_ROOT/apps/cli/bin/redpen.mjs"
if [ ! -f "$CLI_ENTRY" ]; then
  echo "warning: $CLI_ENTRY not found; run this script from inside the redpen repo checkout" >&2
fi

mkdir -p "$(dirname "$CODEX_CONFIG")"
if ! grep -q '\[mcp_servers.redpen\]' "$CODEX_CONFIG" 2>/dev/null; then
  {
    echo ""
    echo "[mcp_servers.redpen]"
    echo "command = \"node\""
    echo "args = [\"$CLI_ENTRY\", \"mcp\"]"
  } >> "$CODEX_CONFIG"
  echo "Added [mcp_servers.redpen] to $CODEX_CONFIG"
else
  echo "[mcp_servers.redpen] already present in $CODEX_CONFIG; not duplicating"
fi

echo "Done. Restart Codex CLI/IDE to pick up the new MCP server and skill."
