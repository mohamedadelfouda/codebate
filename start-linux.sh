#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required."
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "Node.js 22 or newer is required. Found major version $major."
  exit 1
fi
node scripts/source-preflight.mjs
echo "Starting Codebate. Your browser will open automatically when the local server is ready."
exec node server/index.js
