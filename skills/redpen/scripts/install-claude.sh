#!/usr/bin/env bash
# Installs the Redpen skill and MCP server entry for Claude Code.
# docs/IMPLEMENTATION_PLAN.md Phase 5: "Claude 설치 script".
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_PROJECT="${1:-$(pwd)}"
CLAUDE_SKILLS_DIR="$TARGET_PROJECT/.claude/skills/redpen"
CLAUDE_MCP_CONFIG="$TARGET_PROJECT/.mcp.json"

mkdir -p "$CLAUDE_SKILLS_DIR"
cp "$SKILL_DIR/SKILL.md" "$CLAUDE_SKILLS_DIR/SKILL.md"
echo "Copied SKILL.md to $CLAUDE_SKILLS_DIR"

CLI_ENTRY="$REPO_ROOT/apps/cli/bin/redpen.mjs"
if [ ! -f "$CLI_ENTRY" ]; then
  echo "warning: $CLI_ENTRY not found; run this script from inside the redpen repo checkout" >&2
fi

if [ -f "$CLAUDE_MCP_CONFIG" ]; then
  echo "warning: $CLAUDE_MCP_CONFIG already exists; add the redpen server manually:" >&2
  echo "  \"redpen\": { \"command\": \"node\", \"args\": [\"$CLI_ENTRY\", \"mcp\"] }" >&2
else
  cat > "$CLAUDE_MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "redpen": {
      "command": "node",
      "args": ["$CLI_ENTRY", "mcp"]
    }
  }
}
EOF
  echo "Wrote $CLAUDE_MCP_CONFIG"
fi

echo "Done. Restart Claude Code to pick up the new MCP server and skill."
