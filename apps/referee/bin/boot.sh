#!/bin/sh
# Container boot for the referee (compute service). Requires env:
#   INSFORGE_USER_API_KEY  a user API key (dashboard → Profile → API Keys) so platform-only
#                          commands (diagnose --ai, advisor, metrics) work inside the container
#   VICTIM_PROJECT_ID      the bmb-victim project id
#   VICTIM_URL VICTIM_ANON_KEY VICTIM_API_KEY PROBE_* FILLER_* CONTROL_URL CONTROL_API_KEY
#   ANTHROPIC_API_KEY HEALER_MODEL JUDGE_MODEL
set -eu
cd /app
CLI="node /app/apps/referee/node_modules/@insforge/cli/dist/index.js"

echo "boot: logging in to the InsForge platform"
$CLI login --user-api-key "$INSFORGE_USER_API_KEY" --json >/dev/null

echo "boot: linking victim/ to project $VICTIM_PROJECT_ID"
cd /app/victim && $CLI link --project-id "$VICTIM_PROJECT_ID" -y --json >/dev/null && cd /app

# Tiny health endpoint so the platform sees the container as alive.
node -e "require('http').createServer((_, r) => r.end('ok')).listen(process.env.PORT || 8080)" &

echo "boot: starting the referee"
exec node /app/apps/referee/dist/index.js
