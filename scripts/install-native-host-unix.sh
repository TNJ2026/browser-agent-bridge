#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/install-native-host-unix.sh [--browser chrome|chromium|brave|edge|all] <chrome-extension-id>

Installs the Chrome Native Messaging host manifest for macOS or Linux.
EOF
}

BROWSER="chrome"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --browser)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      BROWSER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

EXTENSION_ID="$1"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ENV_FILE="${BROWSER_AGENT_BRIDGE_ENV_FILE:-$HOME/.browser-agent-bridge.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(openssl rand -hex 16 2>/dev/null || od -vAn -N16 -tx1 /dev/urandom | tr -d ' \n' | tr -d '\r')"
  cat > "$ENV_FILE" <<EOF
BROWSER_AGENT_BRIDGE_TOKEN="$TOKEN"
EOF
  chmod 600 "$ENV_FILE"
  echo "Security token generated and saved in $ENV_FILE"
fi

PYTHON_BIN="$(command -v python3 || command -v python || true)"
MANIFEST_SRC="$ROOT_DIR/native/com.local.browser_agent_bridge.json"

if [[ -z "$PYTHON_BIN" ]]; then
  echo "python3 or python was not found on PATH. Install Python first." >&2
  exit 1
fi

manifest_dirs_for_browser() {
  local os="$1"
  local browser="$2"
  if [[ "$os" == "Darwin" ]]; then
    case "$browser" in
      chrome) echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
      chromium) echo "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
      brave) echo "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
      edge) echo "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
      all)
        echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        echo "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
        echo "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        echo "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        ;;
      *) return 1 ;;
    esac
  elif [[ "$os" == "Linux" ]]; then
    case "$browser" in
      chrome) echo "$HOME/.config/google-chrome/NativeMessagingHosts" ;;
      chromium) echo "$HOME/.config/chromium/NativeMessagingHosts" ;;
      brave) echo "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
      edge) echo "$HOME/.config/microsoft-edge/NativeMessagingHosts" ;;
      all)
        echo "$HOME/.config/google-chrome/NativeMessagingHosts"
        echo "$HOME/.config/chromium/NativeMessagingHosts"
        echo "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        echo "$HOME/.config/microsoft-edge/NativeMessagingHosts"
        ;;
      *) return 1 ;;
    esac
  else
    return 2
  fi
}

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  SUPPORT_DIR="$HOME/Library/Application Support/Browser Agent Bridge"
  SUPPORT_NATIVE_DIR="$SUPPORT_DIR/native"
  SUPPORT_RUNTIME_DIR="$SUPPORT_DIR/runtime"
  mkdir -p "$SUPPORT_NATIVE_DIR" "$SUPPORT_RUNTIME_DIR"
  cp "$ROOT_DIR/native/host.py" "$SUPPORT_NATIVE_DIR/host.py"
  cp "$ROOT_DIR/native/com.local.browser_agent_bridge.json" "$SUPPORT_NATIVE_DIR/com.local.browser_agent_bridge.json"
  rm -rf "$SUPPORT_DIR/skills"
  rm -rf "$SUPPORT_RUNTIME_DIR/site-patterns"
  cp -R "$ROOT_DIR/runtime/site-patterns" "$SUPPORT_RUNTIME_DIR/"
  find "$SUPPORT_DIR" -name '.DS_Store' -type f -delete
  HOST_PY="$SUPPORT_NATIVE_DIR/host.py"
  HOST_WRAPPER="$SUPPORT_DIR/host-wrapper.sh"
else
  HOST_PY="$ROOT_DIR/native/host.py"
  HOST_WRAPPER="$ROOT_DIR/native/host-wrapper.sh"
fi

MANIFEST_DIRS=()
while IFS= read -r manifest_dir; do
  MANIFEST_DIRS+=("$manifest_dir")
done < <(manifest_dirs_for_browser "$OS" "$BROWSER")
if [[ ${#MANIFEST_DIRS[@]} -eq 0 ]]; then
  if [[ "$OS" != "Darwin" && "$OS" != "Linux" ]]; then
    echo "Unsupported OS: $OS" >&2
  else
    echo "Unsupported browser: $BROWSER" >&2
  fi
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

export BROWSER_AGENT_BRIDGE_EXTENSION_ID="$EXTENSION_ID"

exec "$PYTHON_BIN" "$HOST_PY" "$@"
EOF
chmod +x "$HOST_WRAPPER"

installed=()
for manifest_dir in "${MANIFEST_DIRS[@]}"; do
  manifest_dst="$manifest_dir/com.local.browser_agent_bridge.json"
  mkdir -p "$manifest_dir"
  "$PYTHON_BIN" - "$MANIFEST_SRC" "$manifest_dst" "$HOST_WRAPPER" "$EXTENSION_ID" <<'PY'
import json
import sys
from pathlib import Path

src, dst, host_path, extension_id = sys.argv[1:5]
manifest = json.loads(Path(src).read_text(encoding="utf-8"))
manifest["path"] = host_path
manifest["allowed_origins"] = [f"chrome-extension://{extension_id}/"]
Path(dst).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
  installed+=("$manifest_dst")
done

echo "Installed native messaging host manifest(s):"
printf '  %s\n' "${installed[@]}"
echo
echo "Host path:"
echo "$HOST_WRAPPER"
