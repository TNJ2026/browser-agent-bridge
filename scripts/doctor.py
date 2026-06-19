#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from browser_bridge_client import BrowserBridgeClient, BrowserBridgeError


ROOT = Path(__file__).resolve().parent.parent
HOST_NAME = "com.local.browser_agent_bridge"
DEFAULT_ZIP = ROOT / "dist" / "browser-agent-bridge-0.1.0.zip"
MACOS_NATIVE_MANIFEST = (
    Path.home()
    / "Library"
    / "Application Support"
    / "Google"
    / "Chrome"
    / "NativeMessagingHosts"
    / f"{HOST_NAME}.json"
)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Diagnose the Browser Agent Bridge setup.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--skip-live", action="store_true", help="Skip HTTP/WebSocket live checks.")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--token", default=None)
    args = parser.parse_args(argv)

    # Load BROWSER_AGENT_BRIDGE_TOKEN from env file if present
    env_file = Path(os.environ.get("BROWSER_AGENT_BRIDGE_ENV_FILE", Path.home() / ".browser-agent-bridge.env"))
    if not os.environ.get("BROWSER_AGENT_BRIDGE_TOKEN") and env_file.exists():
        try:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("BROWSER_AGENT_BRIDGE_TOKEN="):
                    os.environ["BROWSER_AGENT_BRIDGE_TOKEN"] = line.split("=", 1)[1].strip("'\"")
                    break
        except Exception:
            pass

    checks = []
    context = {
        "root": str(ROOT),
        "nativeManifest": str(MACOS_NATIVE_MANIFEST),
        "zip": str(DEFAULT_ZIP),
    }

    check_repo_files(checks)
    check_extension_manifest(checks)
    check_native_manifest(checks)
    check_wrapper(checks)
    check_env(checks)
    check_zip(checks)
    if not args.skip_live:
        check_live(checks, args)

    status = overall_status(checks)
    if args.json:
        json.dump({"status": status, "context": context, "checks": checks}, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"Browser Agent Bridge doctor: {status.upper()}")
        for check in checks:
            print(f"[{check['status'].upper()}] {check['name']}: {check['message']}")
        print(f"\nroot: {ROOT}")
        print(f"native manifest: {MACOS_NATIVE_MANIFEST}")
        print(f"zip: {DEFAULT_ZIP}")
    return 0 if status != "fail" else 1


def check_repo_files(checks):
    required = [
        "extension/manifest.json",
        "extension/service-worker.js",
        "native/host.py",
        "native/host-wrapper.macos.sh",
        "native/com.local.browser_agent_bridge.json",
        "scripts/rpc.sh",
        "scripts/ws-rpc.js",
        "scripts/browser_bridge_client.py",
    ]
    missing = [path for path in required if not (ROOT / path).exists()]
    if missing:
        add(checks, "repo.files", "fail", f"missing {', '.join(missing)}")
    else:
        add(checks, "repo.files", "pass", "required project files exist")


def check_extension_manifest(checks):
    path = ROOT / "extension" / "manifest.json"
    try:
        manifest = read_json(path)
    except Exception as error:
        add(checks, "extension.manifest", "fail", str(error))
        return
    permissions = set(manifest.get("permissions", []))
    if "history" in permissions:
        add(checks, "extension.permissions", "fail", "history permission is still present")
    else:
        add(checks, "extension.permissions", "pass", "history permission is absent")
    if manifest.get("manifest_version") == 3 and manifest.get("background", {}).get("service_worker"):
        add(checks, "extension.manifest", "pass", f"MV3 manifest version {manifest.get('version')}")
    else:
        add(checks, "extension.manifest", "fail", "manifest is not a valid MV3 service worker extension")


def check_native_manifest(checks):
    if not MACOS_NATIVE_MANIFEST.exists():
        add(checks, "native.manifest.installed", "warn", "Chrome native manifest is not installed")
        return
    try:
        manifest = read_json(MACOS_NATIVE_MANIFEST)
    except Exception as error:
        add(checks, "native.manifest.installed", "fail", str(error))
        return
    host_path = Path(manifest.get("path", ""))
    origins = manifest.get("allowed_origins", [])
    if manifest.get("name") != HOST_NAME:
        add(checks, "native.manifest.name", "fail", f"unexpected name {manifest.get('name')}")
    else:
        add(checks, "native.manifest.name", "pass", HOST_NAME)
    if host_path.exists() and os.access(host_path, os.X_OK):
        add(checks, "native.manifest.path", "pass", str(host_path))
    else:
        add(checks, "native.manifest.path", "fail", f"path missing or not executable: {host_path}")
    if origins:
        add(checks, "native.manifest.origins", "pass", ", ".join(origins))
    else:
        add(checks, "native.manifest.origins", "fail", "allowed_origins is empty")


def check_wrapper(checks):
    wrapper = ROOT / "native" / "host-wrapper.macos.sh"
    if not wrapper.exists():
        add(checks, "native.wrapper", "fail", "missing wrapper")
        return
    text = wrapper.read_text(encoding="utf-8")
    if ".browser-agent-bridge.env" in text and "native/host.py" in text and "BROWSER_AGENT_BRIDGE_EXTENSION_ID" in text:
        add(checks, "native.wrapper", "pass", "loads env file, pins extension id, and launches host.py")
    elif ".browser-agent-bridge.env" in text and "native/host.py" in text:
        add(checks, "native.wrapper", "warn", "wrapper should be reinstalled to pin BROWSER_AGENT_BRIDGE_EXTENSION_ID")
    else:
        add(checks, "native.wrapper", "warn", "wrapper may not load token env file")


def check_env(checks):
    env_file = Path(os.environ.get("BROWSER_AGENT_BRIDGE_ENV_FILE", Path.home() / ".browser-agent-bridge.env"))
    token = os.environ.get("BROWSER_AGENT_BRIDGE_TOKEN", "")
    env_token = ""
    if env_file.exists():
        mode = env_file.stat().st_mode & 0o777
        status = "pass" if mode & 0o077 == 0 else "warn"
        add(checks, "auth.env_file", status, f"{env_file} mode {mode:o}")
        try:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("BROWSER_AGENT_BRIDGE_TOKEN="):
                    env_token = line.split("=", 1)[1].strip("'\"")
                    break
        except OSError as error:
            add(checks, "auth.env_file_read", "warn", str(error))
    else:
        add(checks, "auth.env_file", "fail", f"{env_file} does not exist; token auth is required by default")

    allow_no_auth = os.environ.get("BROWSER_AGENT_BRIDGE_ALLOW_NO_AUTH", "").lower() in ("1", "true", "yes")
    has_token = bool(token or env_token)
    if has_token:
        source = "environment" if token else str(env_file)
        add(checks, "auth.env_token", "pass", f"BROWSER_AGENT_BRIDGE_TOKEN is set in {source}")
    elif allow_no_auth:
        add(checks, "auth.env_token", "warn", "token missing but BROWSER_AGENT_BRIDGE_ALLOW_NO_AUTH is enabled")
    else:
        add(checks, "auth.env_token", "fail", "BROWSER_AGENT_BRIDGE_TOKEN is required")


def check_zip(checks):
    if not DEFAULT_ZIP.exists():
        add(checks, "package.zip", "warn", "zip package does not exist")
        return
    try:
        with zipfile.ZipFile(DEFAULT_ZIP) as archive:
            bad = archive.testzip()
            names = set(archive.namelist())
    except Exception as error:
        add(checks, "package.zip", "fail", str(error))
        return
    if bad:
        add(checks, "package.zip", "fail", f"corrupt member: {bad}")
    elif "manifest.json" not in names:
        add(checks, "package.zip", "fail", "manifest.json is not at zip root")
    else:
        add(checks, "package.zip", "pass", f"{DEFAULT_ZIP.stat().st_size} bytes")
    newest_extension = max((path.stat().st_mtime for path in (ROOT / "extension").rglob("*") if path.is_file()), default=0)
    if DEFAULT_ZIP.stat().st_mtime + 1 < newest_extension:
        add(checks, "package.freshness", "warn", "extension files are newer than the zip")
    else:
        add(checks, "package.freshness", "pass", "zip is up to date with extension files")


def check_live(checks, args):
    client = BrowserBridgeClient(args.host, args.port, args.token, timeout=5)
    try:
        health = client.health()
        add(checks, "live.health", "pass", json.dumps(health, ensure_ascii=False))
    except BrowserBridgeError as error:
        add(checks, "live.health", "fail", str(error))
        return
    try:
        result = client.rpc("extension.info", {}, "doctor-extension-info", 10000)
        tools = result.get("tools", [])
        add(checks, "live.rpc", "pass", f"extension {result.get('extensionId')} exposes {len(tools)} tools")
        for tool in ["extension.reload", "dom.query", "page.waitForSelector", "page.waitForText"]:
            add(checks, f"live.tool.{tool}", "pass" if tool in tools else "warn", "available" if tool in tools else "not exposed; reload extension")
    except BrowserBridgeError as error:
        add(checks, "live.rpc", "fail", str(error))
    check_save_data_url(checks, client)
    check_websocket(checks, args)


def check_save_data_url(checks, client):
    try:
        result = client.rpc(
            "native.saveDataUrl",
            {
                "dataUrl": "data:text/plain;base64,YnJvd3Nlci1hZ2VudC1icmlkZ2UK",
                "filename": f"doctor-{int(time.time())}.txt",
            },
            "doctor-save-data-url",
            10000,
        )
    except BrowserBridgeError as error:
        add(checks, "live.native.saveDataUrl", "fail", str(error))
        return
    path = Path(result.get("path", ""))
    try:
        content_matches = path.exists() and path.read_text(encoding="utf-8") == "browser-agent-bridge\n"
        if content_matches:
            add(checks, "live.native.saveDataUrl", "pass", str(path))
        else:
            add(checks, "live.native.saveDataUrl", "fail", f"unexpected save result: {result}")
    finally:
        path.unlink(missing_ok=True)


def check_websocket(checks, args):
    script = ROOT / "scripts" / "ws-rpc.js"
    if not shutil.which("node"):
        add(checks, "live.websocket", "warn", "node is not available")
        return
    env = os.environ.copy()
    if args.host:
        env["BROWSER_AGENT_BRIDGE_HOST"] = args.host
    if args.port:
        env["BROWSER_AGENT_BRIDGE_PORT"] = str(args.port)
    if args.token is not None:
        env["BROWSER_AGENT_BRIDGE_TOKEN"] = args.token
    request = '{"jsonrpc":"2.0","id":"doctor-ws","method":"native.status","params":{}}'
    try:
        result = subprocess.run(
            [str(script), request],
            cwd=ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
            check=False,
        )
    except Exception as error:
        add(checks, "live.websocket", "fail", str(error))
        return
    if result.returncode != 0:
        add(checks, "live.websocket", "fail", result.stderr.strip() or "ws-rpc.js failed")
        return
    messages = [line for line in result.stdout.splitlines() if line.strip()]
    if any('"id": "doctor-ws"' in line or '"id":"doctor-ws"' in line for line in messages):
        add(checks, "live.websocket", "pass", "received doctor-ws response")
    else:
        add(checks, "live.websocket", "warn", "connected but did not find doctor-ws response")


def read_json(path):
    with Path(path).open(encoding="utf-8") as handle:
        return json.load(handle)


def add(checks, name, status, message):
    checks.append({"name": name, "status": status, "message": message})


def overall_status(checks):
    statuses = {check["status"] for check in checks}
    if "fail" in statuses:
        return "fail"
    if "warn" in statuses:
        return "warn"
    return "pass"


if __name__ == "__main__":
    raise SystemExit(main())
