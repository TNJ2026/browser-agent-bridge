#!/usr/bin/env bash
# Compatibility wrapper: This file has been renamed to host-wrapper.sh.
# Delegates to host-wrapper.sh to prevent breaking existing installations.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/host-wrapper.sh" "$@"
