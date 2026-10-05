#!/bin/bash
# Launches the MCP server, installing dependencies and building first when needed.
# Works on a fresh clone (e.g. a Claude Code cloud session) and rebuilds after source changes.
# stdout is reserved for the MCP protocol, so all setup output goes to stderr.
set -e
cd "$(dirname "$0")/.."

# Install when node_modules is missing or the lockfile changed since the last install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund >&2
fi

# Build when there is no build, or any source/config file is newer than it.
if [ ! -f build/index.js ] || [ -n "$(find src package.json tsconfig.json -newer build/index.js -print -quit)" ]; then
  npm run build >&2
fi

exec node build/index.js
