#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SCRIPTS_DIR="$ROOT_DIR/skills/browser-agent-bridge/scripts"

mkdir -p "$SKILL_SCRIPTS_DIR"
find "$SKILL_SCRIPTS_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +

files=(
  "browser_bridge_client.py"
  "doctor.py"
  "install-native-host-macos.sh"
  "install-native-host-unix.sh"
  "install-native-host-win.ps1"
  "rpc.sh"
  "sync-skill-scripts.sh"
  "ws-rpc.js"
)

for file in "${files[@]}"; do
  cp -p "$ROOT_DIR/scripts/$file" "$SKILL_SCRIPTS_DIR/$file"
done

(
  cd "$ROOT_DIR"
  for file in "${files[@]}"; do
    shasum -a 256 "scripts/$file"
  done
) > "$SKILL_SCRIPTS_DIR/SYNC_MANIFEST.sha256"

echo "Synced script snapshots to $SKILL_SCRIPTS_DIR"
