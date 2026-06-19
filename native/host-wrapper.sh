#!/usr/bin/env bash
set -euo pipefail

env_file="${BROWSER_AGENT_BRIDGE_ENV_FILE:-$HOME/.browser-agent-bridge.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

export BROWSER_AGENT_BRIDGE_EXTENSION_ID="testextensionid"

exec "/Users/cxd/.pyenv/shims/python3" "/Users/cxd/Developer/browser-agent-bridge/native/host.py" "testextensionid"
