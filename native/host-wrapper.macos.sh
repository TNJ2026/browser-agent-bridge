#!/usr/bin/env bash
set -euo pipefail

env_file="${BROWSER_AGENT_BRIDGE_ENV_FILE:-$HOME/.browser-agent-bridge.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

exec "/Users/cxd/.pyenv/versions/3.12.13/bin/python3" "/Users/cxd/Developer/browser_scraper/native/host.py"
