#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web. Local sessions manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo '{"async": true, "asyncTimeout": 300000}'

cd "$CLAUDE_PROJECT_DIR"

npm install --no-audit --no-fund
