#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


class BrowserBridgeError(RuntimeError):
    def __init__(self, message, data=None):
        super().__init__(message)
        self.data = data


class BrowserBridgeClient:
    def __init__(self, host=None, port=None, token=None, timeout=120):
        self.host = host or os.environ.get("BROWSER_AGENT_BRIDGE_HOST", DEFAULT_HOST)
        self.port = int(port or os.environ.get("BROWSER_AGENT_BRIDGE_PORT", DEFAULT_PORT))
        
        if token is None:
            token = os.environ.get("BROWSER_AGENT_BRIDGE_TOKEN", "")
            if not token:
                from pathlib import Path
                env_file = Path(os.environ.get("BROWSER_AGENT_BRIDGE_ENV_FILE", Path.home() / ".browser-agent-bridge.env"))
                if env_file.exists():
                    try:
                        for line in env_file.read_text(encoding="utf-8").splitlines():
                            if line.startswith("BROWSER_AGENT_BRIDGE_TOKEN="):
                                token = line.split("=", 1)[1].strip("'\"")
                                break
                    except Exception:
                        pass
        self.token = token
        self.timeout = timeout

    @property
    def base_url(self):
        return f"http://{self.host}:{self.port}"

    def health(self):
        return self._request("GET", "/health")

    def events(self):
        return self._request("GET", "/events", auth=True)

    def rpc(self, method, params=None, request_id=None, timeout_ms=None):
        body = {
            "jsonrpc": "2.0",
            "id": request_id or method,
            "method": method,
            "params": params or {},
        }
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        response = self._request("POST", "/rpc", body, auth=True)
        if "error" in response:
            error = response["error"]
            raise BrowserBridgeError(error.get("message", "JSON-RPC error"), error.get("data"))
        return response.get("result")

    def save_data_url(self, data_url, filename=None, directory=None):
        params = {"dataUrl": data_url}
        if filename:
            params["filename"] = filename
        if directory:
            params["directory"] = directory
        return self.rpc("native.saveDataUrl", params, "native.saveDataUrl")

    def _request(self, method, path, body=None, auth=False):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {}
        if body is not None:
            headers["content-type"] = "application/json"
        if auth and self.token:
            headers["authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            payload = error.read().decode("utf-8", errors="replace")
            raise BrowserBridgeError(f"HTTP {error.code}: {payload}") from error
        except urllib.error.URLError as error:
            raise BrowserBridgeError(str(error.reason)) from error
        return json.loads(payload or "{}")


def parse_json(value, label):
    try:
        return json.loads(value)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Invalid {label} JSON: {error}") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description="Client for the Browser Agent Bridge.")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--token", default=None)
    parser.add_argument("--timeout", type=float, default=120)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("health")
    subparsers.add_parser("events")

    rpc_parser = subparsers.add_parser("rpc")
    rpc_parser.add_argument("method")
    rpc_parser.add_argument("params", nargs="?", default="{}")
    rpc_parser.add_argument("--id", default=None)
    rpc_parser.add_argument("--timeout-ms", type=int, default=None)

    save_parser = subparsers.add_parser("save-data-url")
    save_parser.add_argument("data_url")
    save_parser.add_argument("--filename", default=None)
    save_parser.add_argument("--directory", default=None)

    args = parser.parse_args(argv)
    client = BrowserBridgeClient(args.host, args.port, args.token, args.timeout)

    if args.command == "health":
        result = client.health()
    elif args.command == "events":
        result = client.events()
    elif args.command == "save-data-url":
        result = client.save_data_url(args.data_url, args.filename, args.directory)
    else:
        result = client.rpc(args.method, parse_json(args.params, "params"), args.id, args.timeout_ms)

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
