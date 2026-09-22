#!/bin/sh
# Container boot for the referee (compute service).
#
# Links victim/ to the bmb-victim project in one of two modes:
#   full     INSFORGE_USER_API_KEY set: platform login + link by VICTIM_PROJECT_ID. Every
#            healer tool works, including diagnose --ai and the advisor.
#   api-key  otherwise: link by VICTIM_URL + VICTIM_API_KEY (OSS link mode). db, functions,
#            logs and diagnose db work; diagnose --ai returns "forbidden" and the advisor is
#            empty, so H2 loses two tools. Verified in docs/INSFORGE_NOTES.md §K.
#
# Also needs: VICTIM_ANON_KEY PROBE_* FILLER_* CONTROL_URL CONTROL_API_KEY and the model
# credentials (ANTHROPIC_API_KEY, or LLM_PROVIDER + LLM_API_KEY).
set -eu
cd /app
CLI="node /app/apps/referee/node_modules/@insforge/cli/dist/index.js"

if [ -n "${INSFORGE_USER_API_KEY:-}" ] && [ -n "${VICTIM_PROJECT_ID:-}" ]; then
  echo "boot: platform login + link to project $VICTIM_PROJECT_ID"
  $CLI login --user-api-key "$INSFORGE_USER_API_KEY" --json >/dev/null
  (cd /app/victim && $CLI link --project-id "$VICTIM_PROJECT_ID" -y --json >/dev/null)
else
  echo "boot: api-key link to $VICTIM_URL (no platform login: diagnose --ai and advisor unavailable)"
  (cd /app/victim && $CLI link --api-base-url "$VICTIM_URL" --api-key "$VICTIM_API_KEY" --json >/dev/null)
fi

# Tiny health endpoint so the platform sees the container as alive.
node -e "require('http').createServer((_, r) => r.end('ok')).listen(process.env.PORT || 8080)" &

echo "boot: starting the referee"
exec node /app/apps/referee/dist/index.js
