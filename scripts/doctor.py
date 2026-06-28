#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from browser_bridge_client import BrowserBridgeClient, BrowserBridgeError


ROOT = Path(__file__).resolve().parent.parent

def get_extension_version():
    manifest_path = ROOT / "extension" / "manifest.json"
    if manifest_path.exists():
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            return manifest.get("version", "0.1.0")
        except Exception:
            pass
    return "0.1.0"

VERSION = get_extension_version()
HOST_NAME = "com.local.browser_agent_bridge"
RELEASE_DIR = ROOT / "dist" / f"browser-agent-bridge-{VERSION}"
RELEASE_EXTENSION_DIR = RELEASE_DIR / "extension"
NATIVE_MANIFEST_FILENAME = f"{HOST_NAME}.json"
WINDOWS_REGISTRY_KEY = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"


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

    platform_name = current_platform()
    native_manifest = find_native_manifest(platform_name)
    checks = []
    context = {
        "root": str(ROOT),
        "platform": platform_name,
        "nativeManifest": str(native_manifest) if native_manifest else None,
        "nativeManifestCandidates": [str(path) for path in native_manifest_candidates(platform_name)],
        "releaseDir": str(RELEASE_DIR),
        "releaseExtensionDir": str(RELEASE_EXTENSION_DIR),
    }

    check_repo_files(checks)
    check_extension_manifest(checks)
    check_native_manifest(checks)
    check_wrapper(checks)
    check_env(checks)
    check_release_package(checks)
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
        print(f"platform: {platform_name}")
        print(f"native manifest: {context['nativeManifest'] or 'not found'}")
        print(f"release extension: {RELEASE_EXTENSION_DIR}")
    return 0 if status != "fail" else 1


def current_platform():
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        return "linux"
    if sys.platform.startswith("win"):
        return "windows"
    return sys.platform


def native_manifest_candidates(platform_name=None):
    platform_name = platform_name or current_platform()
    if platform_name == "macos":
        base = Path.home() / "Library" / "Application Support"
        return [
            base / "Google" / "Chrome" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
            base / "Chromium" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
            base / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
            base / "Microsoft Edge" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
        ]
    if platform_name == "linux":
        base = Path.home() / ".config"
        return [
            base / "google-chrome" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
            base / "chromium" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
            base / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
            base / "microsoft-edge" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME,
        ]
    if platform_name == "windows":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return [Path(local_app_data) / "Google" / "Chrome" / "NativeMessagingHosts" / NATIVE_MANIFEST_FILENAME]
    return []


def read_windows_manifest_from_registry():
    if not sys.platform.startswith("win"):
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, WINDOWS_REGISTRY_KEY) as key:
            value, _ = winreg.QueryValueEx(key, "")
            return Path(value) if value else None
    except Exception:
        return None


def find_native_manifest(platform_name=None):
    platform_name = platform_name or current_platform()
    if platform_name == "windows":
        registry_manifest = read_windows_manifest_from_registry()
        if registry_manifest:
            return registry_manifest
    for path in native_manifest_candidates(platform_name):
        if path.exists():
            return path
    return None


def check_repo_files(checks):
    required = [
        "extension/approval.html",
        "extension/approval.js",
        "extension/manifest.json",
        "extension/service-worker.js",
        "extension/sidepanel.html",
        "extension/sidepanel.js",
        "native/host.py",
        "native/host-wrapper.sh",
        "native/host-wrapper.win.bat",
        "native/com.local.browser_agent_bridge.json",
        "runtime/site-patterns",
        "scripts/install-native-host-macos.sh",
        "scripts/install-native-host-unix.sh",
        "scripts/install-native-host-win.ps1",
        "scripts/rpc.sh",
        "scripts/sync-skill-scripts.sh",
        "scripts/ws-rpc.js",
        "scripts/browser_bridge_client.py",
    ]
    missing = [path for path in required if not (ROOT / path).exists()]
    if missing:
        add(checks, "repo.files", "fail", f"missing {', '.join(missing)}")
    else:
        add(checks, "repo.files", "pass", "required project files exist")
    check_install_layout(checks)


def check_install_layout(checks):
    agent_scripts = [
        ROOT / "scripts" / "install-native-host-unix.sh",
        ROOT / "scripts" / "install-native-host-macos.sh",
        ROOT / "scripts" / "install-native-host-win.ps1",
    ]
    native_launchers = [
        ROOT / "native" / "host-wrapper.sh",
        ROOT / "native" / "host-wrapper.win.bat",
    ]
    # Installer scripts must never live under skills/ — they require the repo and
    # are not part of the portable skill bundle.
    misplaced_skill_scripts = []
    if (ROOT / "skills").exists():
        misplaced_skill_scripts = list((ROOT / "skills").glob("**/install-native-host*"))
    missing_scripts = [path.relative_to(ROOT).as_posix() for path in agent_scripts if not path.exists()]
    missing_launchers = [path.relative_to(ROOT).as_posix() for path in native_launchers if not path.exists()]
    if misplaced_skill_scripts:
        paths = ", ".join(path.relative_to(ROOT).as_posix() for path in misplaced_skill_scripts)
        add(checks, "repo.install_layout", "warn", f"installer scripts should live in scripts/, not skills/: {paths}")
    elif missing_scripts or missing_launchers:
        missing = ", ".join(missing_scripts + missing_launchers)
        add(checks, "repo.install_layout", "fail", f"missing expected install layout files: {missing}")
    else:
        add(checks, "repo.install_layout", "pass", "agent-run installers are in scripts/; generated launchers are in native/")


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
    platform_name = current_platform()
    registry_manifest = read_windows_manifest_from_registry() if platform_name == "windows" else None
    manifest_path = find_native_manifest(platform_name)
    if not manifest_path:
        candidates = ", ".join(str(path) for path in native_manifest_candidates(platform_name)) or "none"
        add(checks, "native.manifest.installed", "warn", f"Chrome native manifest is not installed; checked {candidates}")
        if platform_name == "windows":
            add(checks, "native.manifest.registry", "warn", rf"HKCU:\{WINDOWS_REGISTRY_KEY} default value is not set")
        return
    try:
        manifest = read_json(manifest_path)
    except Exception as error:
        add(checks, "native.manifest.installed", "fail", str(error))
        return
    add(checks, "native.manifest.installed", "pass", str(manifest_path))
    if platform_name == "windows":
        if registry_manifest:
            add(checks, "native.manifest.registry", "pass", str(registry_manifest))
        else:
            add(checks, "native.manifest.registry", "warn", rf"HKCU:\{WINDOWS_REGISTRY_KEY} default value is not set")
    host_path = Path(manifest.get("path", ""))
    origins = manifest.get("allowed_origins", [])
    if manifest.get("name") != HOST_NAME:
        add(checks, "native.manifest.name", "fail", f"unexpected name {manifest.get('name')}")
    else:
        add(checks, "native.manifest.name", "pass", HOST_NAME)
    if host_path.exists() and is_host_path_runnable(host_path, platform_name):
        add(checks, "native.manifest.path", "pass", str(host_path))
    else:
        add(checks, "native.manifest.path", "fail", f"path missing or not runnable: {host_path}")
    if origins:
        add(checks, "native.manifest.origins", "pass", ", ".join(origins))
    else:
        add(checks, "native.manifest.origins", "fail", "allowed_origins is empty")


def check_wrapper(checks):
    platform_name = current_platform()
    wrapper = ROOT / "native" / ("host-wrapper.win.bat" if platform_name == "windows" else "host-wrapper.sh")
    manifest_path = find_native_manifest(platform_name)
    if manifest_path:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest_wrapper = Path(manifest.get("path", ""))
            if manifest_wrapper:
                wrapper = manifest_wrapper
        except Exception:
            pass
    if not wrapper.exists():
        add(checks, "native.wrapper", "fail", "missing wrapper")
        return
    text = wrapper.read_text(encoding="utf-8")
    launches_host = "host.py" in text
    loads_env = ".browser-agent-bridge.env" in text
    pins_extension = "BROWSER_AGENT_BRIDGE_EXTENSION_ID" in text
    if loads_env and launches_host and pins_extension:
        add(checks, "native.wrapper", "pass", "loads env file, pins extension id, and launches host.py")
    elif loads_env and launches_host:
        add(checks, "native.wrapper", "warn", "wrapper should be reinstalled to pin BROWSER_AGENT_BRIDGE_EXTENSION_ID")
    else:
        add(checks, "native.wrapper", "warn", "wrapper may not load token env file")


def check_env(checks):
    env_file = Path(os.environ.get("BROWSER_AGENT_BRIDGE_ENV_FILE", Path.home() / ".browser-agent-bridge.env"))
    token = os.environ.get("BROWSER_AGENT_BRIDGE_TOKEN", "")
    env_token = ""
    if env_file.exists():
        if current_platform() == "windows":
            add(checks, "auth.env_file", "pass", str(env_file))
        else:
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


def check_release_package(checks):
    if not RELEASE_EXTENSION_DIR.exists():
        add(checks, "package.extension", "warn", "release extension directory does not exist")
        return
    manifest = RELEASE_EXTENSION_DIR / "manifest.json"
    if not manifest.exists():
        add(checks, "package.extension", "fail", "manifest.json is not at release extension root")
        return
    file_count = sum(1 for path in RELEASE_EXTENSION_DIR.rglob("*") if path.is_file())
    add(checks, "package.extension", "pass", f"{file_count} files in {RELEASE_EXTENSION_DIR}")
    newest_extension = max((path.stat().st_mtime for path in (ROOT / "extension").rglob("*") if path.is_file()), default=0)
    newest_release_extension = max((path.stat().st_mtime for path in RELEASE_EXTENSION_DIR.rglob("*") if path.is_file()), default=0)
    if newest_release_extension + 1 < newest_extension:
        add(checks, "package.freshness", "warn", "extension files are newer than the release extension directory")
    else:
        add(checks, "package.freshness", "pass", "release extension directory is up to date with extension files")


def is_host_path_runnable(path, platform_name):
    if platform_name == "windows":
        return path.suffix.lower() in (".bat", ".cmd", ".exe", ".ps1", ".py")
    return os.access(path, os.X_OK)


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
        for tool in ["extension.reload", "dom.query", "locator.click", "locator.fill", "page.waitForSelector", "page.waitForText"]:
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
