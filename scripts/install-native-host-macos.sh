#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <chrome-extension-id>" >&2
  exit 1
fi

EXTENSION_ID="$1"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST_PY="$ROOT_DIR/native/host.py"
PYTHON_BIN="$(command -v python3 || command -v python)"
HOST_WRAPPER="$ROOT_DIR/native/host-wrapper.macos.sh"
MANIFEST_SRC="$ROOT_DIR/native/com.local.browser_agent_bridge.json"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_DST="$MANIFEST_DIR/com.local.browser_agent_bridge.json"

if [[ -z "$PYTHON_BIN" ]]; then
  echo "python3 or python was not found on PATH. Install Python first." >&2
  exit 1
fi

chmod +x "$HOST_PY"
cat > "$HOST_WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

env_file="\${BROWSER_AGENT_BRIDGE_ENV_FILE:-\$HOME/.browser-agent-bridge.env}"
if [[ -f "\$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "\$env_file"
  set +a
fi

exec "$PYTHON_BIN" "$HOST_PY"
EOF
chmod +x "$HOST_WRAPPER"
mkdir -p "$MANIFEST_DIR"
sed \
  -e "s#__HOST_PATH__#$HOST_WRAPPER#g" \
  -e "s#__EXTENSION_ID__#$EXTENSION_ID#g" \
  "$MANIFEST_SRC" > "$MANIFEST_DST"

echo "Installed native messaging host manifest:"
echo "$MANIFEST_DST"
echo
echo "Host path:"
echo "$HOST_WRAPPER"
