#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(jq -r '.version' "$ROOT_DIR/extension/manifest.json")"
RELEASE_NAME="browser-agent-bridge-$VERSION"
DIST_DIR="$ROOT_DIR/dist"
RELEASE_DIR="$DIST_DIR/$RELEASE_NAME"
ZIP_PATH="$DIST_DIR/local-browser-agent-bridge-$VERSION.zip"

mkdir -p "$DIST_DIR" "$RELEASE_DIR"

(
  cd "$ROOT_DIR/extension"
  zip -r "$ZIP_PATH" . -x '*.DS_Store'
)

mkdir -p \
  "$RELEASE_DIR/extension" \
  "$RELEASE_DIR/native" \
  "$RELEASE_DIR/scripts" \
  "$RELEASE_DIR/docs" \
  "$RELEASE_DIR/skills"

cp "$ZIP_PATH" "$RELEASE_DIR/extension/"
cp "$ROOT_DIR/native/host.py" "$RELEASE_DIR/native/"
cp "$ROOT_DIR/native/host-wrapper.macos.sh" "$RELEASE_DIR/native/"
cp "$ROOT_DIR/native/com.local.browser_agent_bridge.json" "$RELEASE_DIR/native/"
cp "$ROOT_DIR/scripts/install-native-host-macos.sh" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/rpc.sh" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/ws-rpc.js" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/browser_bridge_client.py" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/doctor.py" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/README.md" "$RELEASE_DIR/"
cp "$ROOT_DIR/docs/protocol.md" "$RELEASE_DIR/docs/"
cp -R "$ROOT_DIR/skills/browser-agent-bridge" "$RELEASE_DIR/skills/"
find "$RELEASE_DIR" -name '.DS_Store' -type f -delete

cat > "$RELEASE_DIR/release.json" <<EOF
{
  "name": "browser-agent-bridge",
  "version": "$VERSION",
  "extensionZip": "extension/$(basename "$ZIP_PATH")",
  "nativeHost": "native/host.py",
  "installer": "scripts/install-native-host-macos.sh",
  "doctor": "scripts/doctor.py",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "$RELEASE_DIR"
