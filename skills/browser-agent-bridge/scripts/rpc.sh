#!/usr/bin/env bash
set -euo pipefail

headers=(-H 'content-type: application/json')
if [[ -n "${BROWSER_AGENT_BRIDGE_TOKEN:-}" ]]; then
  headers+=(-H "authorization: Bearer ${BROWSER_AGENT_BRIDGE_TOKEN}")
fi

curl -sS \
  "${headers[@]}" \
  -X POST \
  --data "$1" \
  "http://${BROWSER_AGENT_BRIDGE_HOST:-127.0.0.1}:${BROWSER_AGENT_BRIDGE_PORT:-8765}/rpc"
