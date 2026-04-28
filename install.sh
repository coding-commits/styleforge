#!/usr/bin/env bash
set -euo pipefail

# Styleforge installer
# Sets up: MCP server (for tools) + Claude Code slash commands (for prompts)

REPO_URL="https://github.com/coding-commits/styleforge.git"
INSTALL_DIR="${STYLEFORGE_INSTALL:-$HOME/.local/share/styleforge-mcp}"
DATA_DIR="${STYLEFORGE_HOME:-$HOME/.styleforge}"
COMMANDS_DIR="$HOME/.claude/commands"

echo "=== Styleforge Installer ==="
echo ""
echo "  MCP server → $INSTALL_DIR"
echo "  Data dir   → $DATA_DIR"
echo "  Commands   → $COMMANDS_DIR"
echo ""

# 1. Clone or update the server
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[1/3] Updating server..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "[1/3] Cloning server..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# 2. Install dependencies
echo "[2/3] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production --silent

# 3. Install slash commands for Claude Code
echo "[3/3] Installing slash commands..."
mkdir -p "$COMMANDS_DIR"
for cmd in "$INSTALL_DIR"/commands/style-*.md; do
  name=$(basename "$cmd")
  cp "$cmd" "$COMMANDS_DIR/$name"
done

# 4. Print MCP config for the user to add
echo ""
echo "=== Done ==="
echo ""
echo "Data directory: $DATA_DIR"
echo "Slash commands installed: $(ls "$COMMANDS_DIR"/style-*.md 2>/dev/null | wc -l | tr -d ' ') commands"
echo ""
echo "To register the MCP server, add this to your Claude Code settings"
echo "(~/.claude/settings.json under \"mcpServers\"):"
echo ""
cat <<EOF
  "styleforge": {
    "command": "node",
    "args": ["$INSTALL_DIR/server/index.js"],
    "env": {
      "STYLEFORGE_HOME": "$DATA_DIR"
    }
  }
EOF
echo ""
echo "Or run:"
echo "  claude mcp add styleforge node $INSTALL_DIR/server/index.js -e STYLEFORGE_HOME=$DATA_DIR"
echo ""
echo "Then restart Claude Code. Try: /style-authors"
