#!/bin/bash
# Launches the MCP server, installing dependencies and building first if needed.
# This lets a fresh clone (e.g. a Claude Code cloud session) work without manual setup.
# stdout is reserved for the MCP protocol, so all setup output goes to stderr.
set -e
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund >&2
fi
if [ ! -f build/index.js ]; then
  npm run build >&2
fi

exec node build/index.js
