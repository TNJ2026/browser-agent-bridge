#!/usr/bin/env bash
set -euo pipefail

# Injects the portable runtime clients into the skill bundle so a skill copied to
# an agent's skills directory (separated from this repo's top-level scripts/) can
# still call the bridge. Only the self-contained RPC clients are bundled — the
# setup/diagnostic scripts (doctor.py, install-native-host-*) require the repo and
# are always run from the repo's top-level scripts/, never from the skill.
#
# The skill's scripts/ directory is a generated artifact (gitignored). Run this
# before copying skills/browser-agent-bridge/ to an agent skills directory, or let
# build-release.sh run it during packaging.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SCRIPTS_DIR="$ROOT_DIR/skills/browser-agent-bridge/scripts"

mkdir -p "$SKILL_SCRIPTS_DIR"
find "$SKILL_SCRIPTS_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +

runtime_clients=(
  "browser_bridge_client.py"
  "rpc.sh"
  "ws-rpc.js"
)

for file in "${runtime_clients[@]}"; do
  cp -p "$ROOT_DIR/scripts/$file" "$SKILL_SCRIPTS_DIR/$file"
done

echo "Injected runtime clients (${runtime_clients[*]}) into $SKILL_SCRIPTS_DIR"
