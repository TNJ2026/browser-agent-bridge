#!/usr/bin/env python3
import sys
import os
import json
import struct
import threading
import uuid
import time
import base64
import hashlib
import hmac
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingTCPServer

PORT = int(os.environ.get('BROWSER_AGENT_BRIDGE_PORT', 8765))
HOST = os.environ.get('BROWSER_AGENT_BRIDGE_HOST', '127.0.0.1')
AUTH_TOKEN = os.environ.get('BROWSER_AGENT_BRIDGE_TOKEN', '')
ALLOW_NO_AUTH = os.environ.get('BROWSER_AGENT_BRIDGE_ALLOW_NO_AUTH', '').lower() in ('1', 'true', 'yes')
EXTENSION_ID = os.environ.get('BROWSER_AGENT_BRIDGE_EXTENSION_ID', '').strip()
# Whether the id was pinned by the operator via env. Env always wins; an id
# learned at runtime from the (trusted) native-messaging channel only fills in
# when no env pin exists.
EXTENSION_ID_FROM_ENV = bool(EXTENSION_ID)
EXTENSION_ID_RE = re.compile(r'^[a-p]{32}$')
SAVE_DIR = Path(os.environ.get('BROWSER_AGENT_BRIDGE_SAVE_DIR', str(Path.home() / 'Downloads' / 'browser-agent-bridge')))
ALLOW_CUSTOM_SAVE_DIR = os.environ.get('BROWSER_AGENT_BRIDGE_ALLOW_CUSTOM_SAVE_DIR', '').lower() in ('1', 'true', 'yes')
MAX_MESSAGE_BYTES = 32 * 1024 * 1024
ROOT = Path(__file__).resolve().parent.parent
RUNTIME_SITE_PATTERNS_DIR = ROOT / "runtime" / "site-patterns"
SKILL_SITE_PATTERNS_DIR = ROOT / "skills" / "browser-agent-bridge" / "references" / "site-patterns"
SITE_PATTERNS_DIR = RUNTIME_SITE_PATTERNS_DIR if RUNTIME_SITE_PATTERNS_DIR.exists() else SKILL_SITE_PATTERNS_DIR
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;base64)?,(.*)$', re.DOTALL)

extension_ready = False
extension_version = None
next_rpc_id = 1
rpc_id_lock = threading.Lock()

config_ready = threading.Event()
configured_port = PORT

allow_read_tabs = True
enable_runtime_approval = True

# Thread-safe collections
pending_requests = {}  # msg_id -> {"event": threading.Event(), "response": None}
pending_lock = threading.Lock()

event_buffer = []
event_lock = threading.Lock()

stdout_lock = threading.Lock()
websocket_clients = {}
websocket_clients_lock = threading.Lock()
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def log(msg):
    sys.stderr.write(f"[browser-agent-native] {msg}\n")
    sys.stderr.flush()

def write_native_message(message):
    try:
        encoded = json.dumps(message).encode('utf-8')
        header = struct.pack('<I', len(encoded))
        with stdout_lock:
            sys.stdout.buffer.write(header)
            sys.stdout.buffer.write(encoded)
            sys.stdout.buffer.flush()
    except Exception as e:
        log(f"Failed to write native message: {e}")

def handle_native_notification(message):
    global extension_ready, extension_version, configured_port, allow_read_tabs, enable_runtime_approval, EXTENSION_ID
    method = message.get("method")
    params = message.get("params", {})
    if method == "extension.ready":
        extension_ready = True
        extension_version = params.get("version")
        if "port" in params:
            try:
                configured_port = int(params["port"])
            except Exception:
                pass
        # Chrome only connects the extension named in the native-messaging
        # manifest's allowed_origins, so the id reported over this channel is
        # authoritative. Adopt it to pin origin checks when no env pin exists.
        if not EXTENSION_ID_FROM_ENV:
            reported_id = params.get("extensionId")
            if isinstance(reported_id, str) and EXTENSION_ID_RE.match(reported_id.strip().lower()):
                EXTENSION_ID = reported_id.strip().lower()
        config_ready.set()
    elif method == "extension.settings":
        allow_read_tabs = params.get("allowReadTabs", True)
        enable_runtime_approval = params.get("enableRuntimeApproval", True)
    
    event = {
            "id": str(uuid.uuid4()),
            "timestamp": int(time.time() * 1000),
            "method": method,
            "params": params
        }
    with event_lock:
        event_buffer.append(event)
        while len(event_buffer) > 1000:
            event_buffer.pop(0)
    broadcast_websocket({
        "jsonrpc": "2.0",
        "method": method,
        "params": params
    })

def current_site_patterns_dir():
    root = Path(__file__).resolve().parent.parent
    runtime_dir = root / "runtime" / "site-patterns"
    if runtime_dir.exists():
        return runtime_dir
    return root / "skills" / "browser-agent-bridge" / "references" / "site-patterns"

def get_site_patterns():
    return list_site_patterns(current_site_patterns_dir())

def handle_native_request(message):
    if message.get("method") in ("native.saveDataUrl", "native.sitePatterns"):
        write_native_message(call_extension(message))
        return

    write_native_message({
        "jsonrpc": "2.0",
        "id": message.get("id"),
        "error": {
            "code": -32601,
            "message": f"Method not found: {message.get('method')}"
        }
    })

def handle_native_message(message):
    if not isinstance(message, dict):
        return
    
    # Check if notification (no id)
    if "method" in message and "id" not in message:
        handle_native_notification(message)
        return
        
    # Check if request (has id and method)
    if "method" in message and "id" in message:
        handle_native_request(message)
        return

    # Check if response (has id, no method)
    if "id" in message and "method" not in message:
        msg_id = str(message["id"])
        with pending_lock:
            waiter = pending_requests.get(msg_id)
        if waiter:
            waiter["response"] = message
            waiter["event"].set()
        return

    # Check ping
    if message.get("type") == "ping":
        write_native_message({
            "type": "pong",
            "timestamp": message.get("timestamp"),
            "now": int(time.time() * 1000)
        })

def native_reader_loop():
    while True:
        try:
            # Read 4-byte message length (little-endian unsigned int)
            raw_length = sys.stdin.buffer.read(4)
            if not raw_length or len(raw_length) < 4:
                log("Stdin closed or EOF reached. Exiting reader loop.")
                os._exit(0)
            message_length = struct.unpack('<I', raw_length)[0]
            if message_length > MAX_MESSAGE_BYTES:
                log(f"Native message too large: {message_length} bytes")
                os._exit(1)
            # Read JSON data
            raw_data = sys.stdin.buffer.read(message_length)
            if len(raw_data) < message_length:
                log("Incomplete message read from stdin. Exiting.")
                os._exit(1)
            
            payload = json.loads(raw_data.decode('utf-8'))
            handle_native_message(payload)
        except Exception as e:
            log(f"Error in native reader loop: {e}")
            time.sleep(0.1)

class ThreadingHTTPServer(ThreadingTCPServer, HTTPServer):
    allow_reuse_address = True

def call_extension(request):
    global next_rpc_id
    if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
        return {
            "jsonrpc": "2.0",
            "id": request.get("id") if isinstance(request, dict) else None,
            "error": {"code": -32600, "message": "Invalid JSON-RPC request"}
        }

    if request.get("method") == "native.saveDataUrl":
        return handle_save_data_url(request)
    if request.get("method") == "native.sitePatterns":
        return handle_site_patterns(request)

    if not extension_ready:
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32000, "message": "Chrome extension is not connected to the native host"}
        }

    # The id used to correlate the forwarded request with its response must be
    # globally unique. Client-supplied ids are untrusted and may collide across
    # concurrent clients (multiple WebSocket connections + HTTP), so we always
    # mint an internal id for matching and restore the client's id on the way out.
    client_id = request.get("id")
    with rpc_id_lock:
        internal_id = f"rpc-{next_rpc_id}"
        next_rpc_id += 1

    forwarded = {
        "jsonrpc": "2.0",
        "id": internal_id,
        "method": request["method"],
        "params": request.get("params", {})
    }

    event = threading.Event()
    waiter = {"event": event, "response": None}

    with pending_lock:
        pending_requests[internal_id] = waiter

    write_native_message(forwarded)

    timeout_ms = request.get("timeoutMs", 120000)
    timeout_sec = timeout_ms / 1000.0
    finished = event.wait(timeout=timeout_sec)

    with pending_lock:
        pending_requests.pop(internal_id, None)

    # Echo back the id the client sent (preserving its original type), falling
    # back to the internal id when the client omitted one.
    response_id = client_id if client_id is not None else internal_id

    if not finished:
        return {
            "jsonrpc": "2.0",
            "id": response_id,
            "error": {"code": -32000, "message": f"Request timed out: {request['method']}"}
        }

    response = waiter["response"]
    if isinstance(response, dict):
        response["id"] = response_id
    return response

def handle_save_data_url(request):
    try:
        params = request.get("params", {}) or {}
        path, byte_count, mime_type = save_data_url(params)
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "path": str(path),
                "bytes": byte_count,
                "mimeType": mime_type
            }
        }
    except Exception as e:
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32000, "message": str(e)}
        }

def handle_site_patterns(request):
    try:
        patterns_dir = current_site_patterns_dir()
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "directory": str(patterns_dir),
                "patterns": list_site_patterns(patterns_dir)
            }
        }
    except Exception as e:
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32000, "message": str(e)}
        }

def list_site_patterns(patterns_dir=SITE_PATTERNS_DIR):
    if not patterns_dir.exists():
        return []

    patterns = []
    for path in sorted(patterns_dir.glob("*.md")):
        if path.name.startswith("."):
            continue
        stat = path.stat()
        content = path.read_text(encoding="utf-8", errors="replace")
        patterns.append({
            "domain": path.stem,
            "filename": path.name,
            "path": str(path),
            "updatedAt": int(stat.st_mtime * 1000),
            "bytes": stat.st_size,
            "summary": extract_site_pattern_summary(content),
            "content": content
        })
    return patterns

def extract_site_pattern_summary(content):
    lines = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            if lines:
                break
            continue
        lines.append(line)
        if len(" ".join(lines)) >= 180:
            break
    return " ".join(lines)[:240]

def save_data_url(params):
    data_url = params.get("dataUrl")
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        raise ValueError("dataUrl must be a data URL")

    match = DATA_URL_RE.match(data_url)
    if not match:
        raise ValueError("Invalid data URL")

    mime_type = match.group(1) or "application/octet-stream"
    is_base64 = bool(match.group(2))
    payload = match.group(3)
    if is_base64:
        data = base64.b64decode(payload, validate=True)
    else:
        from urllib.parse import unquote_to_bytes
        data = unquote_to_bytes(payload)

    extension = extension_for_mime(mime_type)
    filename = params.get("filename")
    if isinstance(filename, str) and filename.strip():
        safe_name = safe_filename(filename.strip())
    else:
        safe_name = f"screenshot-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}{extension}"
    if not Path(safe_name).suffix and extension:
        safe_name = f"{safe_name}{extension}"

    target_dir = SAVE_DIR
    if isinstance(params.get("directory"), str) and params["directory"].strip():
        if not ALLOW_CUSTOM_SAVE_DIR:
            raise ValueError(
                "Custom save directories are disabled. Set "
                "BROWSER_AGENT_BRIDGE_ALLOW_CUSTOM_SAVE_DIR=1 to enable them."
            )
        target_dir = Path(params["directory"]).expanduser()
    target_dir.mkdir(parents=True, exist_ok=True)
    path = (target_dir / safe_name).resolve()
    if target_dir.resolve() not in path.parents and path != target_dir.resolve():
        raise ValueError("Refusing to write outside target directory")
    path.write_bytes(data)
    return path, len(data), mime_type

def extension_for_mime(mime_type):
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "application/json": ".json",
        "application/pdf": ".pdf",
        "text/plain": ".txt"
    }.get(mime_type, ".bin")

def safe_filename(value):
    cleaned = re.sub(r'[\\/:*?"<>|]+', '-', value).strip('. ')
    return cleaned or f"artifact-{uuid.uuid4().hex[:8]}"

def auth_enabled():
    return bool(AUTH_TOKEN) or not ALLOW_NO_AUTH

def is_authorized(headers):
    if ALLOW_NO_AUTH and not AUTH_TOKEN:
        return True
    if not AUTH_TOKEN:
        return False
    value = headers.get('Authorization', '')
    prefix = 'Bearer '
    if not value.startswith(prefix):
        return False
    return hmac.compare_digest(value[len(prefix):], AUTH_TOKEN)

def websocket_accept_key(key):
    digest = hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")

def websocket_read_exact(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("WebSocket connection closed")
        data += chunk
    return data

def websocket_read_frame(sock):
    """Read a single WebSocket frame, returning (fin, opcode, payload_bytes).

    The declared length is checked before the payload is read so an oversized
    frame can never allocate memory.
    """
    header = websocket_read_exact(sock, 2)
    first, second = header[0], header[1]
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", websocket_read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", websocket_read_exact(sock, 8))[0]
    if length > MAX_MESSAGE_BYTES:
        # Reject before allocating/reading the payload to avoid memory exhaustion.
        try:
            websocket_send(sock, struct.pack("!H", 1009) + b"message too big", opcode=0x8)
        except Exception:
            pass
        raise ConnectionError(f"WebSocket frame exceeds max size ({length} > {MAX_MESSAGE_BYTES})")
    mask = websocket_read_exact(sock, 4) if masked else b""
    payload = websocket_read_exact(sock, length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return fin, opcode, payload


def websocket_recv(sock):
    """Read one full WebSocket message, reassembling fragmented frames.

    Returns the decoded text of a complete text message, None when the peer
    closes, or "" for a complete message the caller should ignore (binary).
    Per RFC 6455, control frames (ping/pong) are never fragmented and may be
    interleaved between the fragments of a data message, so they are handled
    inline here rather than surfaced to the caller.
    """
    message = bytearray()
    message_opcode = None  # opcode of the data frame that started the message
    while True:
        fin, opcode, payload = websocket_read_frame(sock)

        if opcode == 0x8:  # close
            return None
        if opcode == 0x9:  # ping -> pong, then keep waiting for the data message
            websocket_send(sock, payload, opcode=0xA)
            continue
        if opcode == 0xA:  # pong
            continue

        if opcode == 0x0:  # continuation of the in-progress message
            if message_opcode is None:
                raise ConnectionError("Unexpected WebSocket continuation frame")
        elif opcode in (0x1, 0x2):  # start of a text/binary message
            if message_opcode is not None:
                raise ConnectionError("Expected a WebSocket continuation frame")
            message_opcode = opcode
        else:
            raise ConnectionError(f"Unsupported WebSocket opcode: {opcode}")

        if len(message) + len(payload) > MAX_MESSAGE_BYTES:
            # Bound the reassembled total, not just each frame, so a flood of
            # small fragments cannot sum past the cap.
            try:
                websocket_send(sock, struct.pack("!H", 1009) + b"message too big", opcode=0x8)
            except Exception:
                pass
            raise ConnectionError("WebSocket message exceeds max size")
        message.extend(payload)

        if fin:
            if message_opcode == 0x1:
                return bytes(message).decode("utf-8")
            return ""  # complete binary message: ignored, as before

def websocket_send(sock, payload, opcode=0x1):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    length = len(payload)
    header = bytearray([0x80 | opcode])
    if length < 126:
        header.append(length)
    elif length <= 0xFFFF:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    sock.sendall(bytes(header) + payload)

def websocket_send_json(sock, value):
    websocket_send(sock, json.dumps(value))

def register_websocket(sock):
    # Each client carries its own send lock and an optional tab filter. tabs is
    # None by default (receive every event); a set restricts delivery to events
    # for those tab ids. The recv thread mutates tabs; the broadcaster reads it.
    client = {"lock": threading.Lock(), "tabs": None}
    with websocket_clients_lock:
        websocket_clients[sock] = client
    publish_ws_subscription_status()
    return client

def unregister_websocket(sock):
    with websocket_clients_lock:
        websocket_clients.pop(sock, None)
    publish_ws_subscription_status()

def current_ws_subscription_status():
    with websocket_clients_lock:
        clients = list(websocket_clients.values())
    if not clients:
        return {"all": False, "tabIds": []}
    if any(client["tabs"] is None for client in clients):
        return {"all": True, "tabIds": []}
    tab_ids = set()
    for client in clients:
        tab_ids.update(client["tabs"])
    return {"all": False, "tabIds": sorted(tab_ids)}

def publish_ws_subscription_status():
    write_native_message({
        "jsonrpc": "2.0",
        "method": "bridge.subscriptionStatus",
        "params": {
            "cdpEvents": current_ws_subscription_status()
        }
    })

def event_tab_id(value):
    """Best-effort tab id for an outbound event, or None for global events."""
    params = value.get("params") if isinstance(value, dict) else None
    if not isinstance(params, dict):
        return None
    source = params.get("source")
    if isinstance(source, dict) and isinstance(source.get("tabId"), int):
        return source["tabId"]
    if isinstance(params.get("tabId"), int):
        return params["tabId"]
    return None

def broadcast_websocket(value):
    payload = json.dumps(value)
    tab_id = event_tab_id(value)
    with websocket_clients_lock:
        clients = list(websocket_clients.items())
    for sock, client in clients:
        tabs = client["tabs"]
        # A subscribed client only gets tab-scoped events for its tabs; events
        # with no tab id (e.g. extension.ready) always go to everyone.
        if tabs is not None and tab_id is not None and tab_id not in tabs:
            continue
        try:
            with client["lock"]:
                websocket_send(sock, payload)
        except Exception:
            unregister_websocket(sock)

def apply_ws_subscription(client, request):
    params = request.get("params") or {}
    tab_ids = params.get("tabIds")
    if tab_ids is None:
        client["tabs"] = None
    elif isinstance(tab_ids, list):
        client["tabs"] = {t for t in tab_ids if isinstance(t, int) and not isinstance(t, bool)}
    else:
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32602, "message": "tabIds must be an array of integers or null"}
        }
    publish_ws_subscription_status()
    return {
        "jsonrpc": "2.0",
        "id": request.get("id"),
        "result": {"subscribed": sorted(client["tabs"]) if client["tabs"] is not None else None}
    }

def websocket_send_client_json(sock, lock, value):
    with lock:
        websocket_send_json(sock, value)

class RpcRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress logging to keep stdin/stdout clean and clear from standard logging
        pass

    def send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.set_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2).encode('utf-8'))

    def send_unauthorized(self):
        self.send_response(401)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('WWW-Authenticate', 'Bearer')
        self.set_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Unauthorized"}).encode('utf-8'))

    def is_origin_allowed(self, origin):
        if not origin:
            return True
        origin_lower = origin.lower()
        if (origin_lower.startswith("http://localhost:") or origin_lower == "http://localhost" or
            origin_lower.startswith("http://127.0.0.1:") or origin_lower == "http://127.0.0.1"):
            return True
        if origin_lower.startswith("chrome-extension://"):
            if not EXTENSION_ID:
                # Fail closed: with no pinned id we cannot tell which extension
                # this is, so reject rather than trust every extension origin.
                return False
            allowed = f"chrome-extension://{EXTENSION_ID.lower()}"
            return origin_lower == allowed or origin_lower == f"{allowed}/"
        return False

    def set_cors_headers(self):
        origin = self.headers.get('Origin')
        if origin and self.is_origin_allowed(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
        else:
            if origin:
                self.send_header('Access-Control-Allow-Origin', 'null')
            else:
                self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'authorization,content-type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204)
        self.set_cors_headers()
        self.end_headers()

    def do_GET(self):
        global extension_ready, extension_version
        origin = self.headers.get('Origin')
        if not self.is_origin_allowed(origin):
            self.send_json(403, {"error": "Forbidden: Origin not allowed"})
            return

        if self.path == '/ws' and self.headers.get('Upgrade', '').lower() == 'websocket':
            if not is_authorized(self.headers):
                self.send_unauthorized()
                return
            self.handle_websocket()
            return

        if self.path == '/health':
            with pending_lock:
                pending_size = len(pending_requests)
            self.send_json(200, {
                "ok": True,
                "hostReady": True,
                "extensionReady": extension_ready,
                "extensionVersion": extension_version,
                "authRequired": auth_enabled(),
                "authConfigured": bool(AUTH_TOKEN),
                "allowNoAuth": ALLOW_NO_AUTH,
                "pending": pending_size
            })
            return

        if self.path == '/events':
            if not is_authorized(self.headers):
                self.send_unauthorized()
                return
            with event_lock:
                events = list(event_buffer[-200:])
            self.send_json(200, {"events": events})
            return

        self.send_json(404, {"error": "Not found"})

    def handle_websocket(self):
        key = self.headers.get('Sec-WebSocket-Key')
        if not key:
            self.send_json(400, {"error": "Missing Sec-WebSocket-Key"})
            return

        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', websocket_accept_key(key))
        self.end_headers()

        sock = self.connection
        client = register_websocket(sock)
        client_lock = client["lock"]
        try:
            websocket_send_client_json(sock, client_lock, {
                "jsonrpc": "2.0",
                "method": "bridge.ready",
                "params": {
                    "extensionReady": extension_ready,
                    "extensionVersion": extension_version
                }
            })
            while True:
                try:
                    text = websocket_recv(sock)
                except (ConnectionError, OSError):
                    break
                if text is None:
                    break
                if not text:
                    continue
                try:
                    request = json.loads(text)
                    method = request.get("method") if isinstance(request, dict) else None
                    if method == "bridge.subscribe":
                        # Host-local control: restrict which tab events this
                        # connection receives. Not forwarded to the extension.
                        response = apply_ws_subscription(client, request)
                    elif method == "bridge.unsubscribe":
                        client["tabs"] = None
                        publish_ws_subscription_status()
                        response = {"jsonrpc": "2.0", "id": request.get("id"), "result": {"subscribed": None}}
                    else:
                        response = call_extension(request)
                except Exception as e:
                    response = {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32000, "message": str(e)}
                    }
                websocket_send_client_json(sock, client_lock, response)
        finally:
            unregister_websocket(sock)

    def do_POST(self):
        origin = self.headers.get('Origin')
        if not self.is_origin_allowed(origin):
            self.send_json(403, {"error": "Forbidden: Origin not allowed"})
            return

        if self.path != '/rpc':
            self.send_json(404, {"error": "Not found"})
            return
        if not is_authorized(self.headers):
            self.send_unauthorized()
            return

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > MAX_MESSAGE_BYTES:
                self.send_json(400, {"error": "Request body too large"})
                return

            body = self.rfile.read(content_length).decode('utf-8')
            request = json.loads(body or '{}')
            
            response = call_extension(request)
            self.send_json(200, response)

        except Exception as e:
            self.send_json(500, {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": str(e)}
            })

def main():
    # Run the Native Messaging listener in a daemon background thread
    reader_thread = threading.Thread(target=native_reader_loop, name="NativeReader")
    reader_thread.daemon = True
    reader_thread.start()

    # Wait for the extension to send the config/port, or timeout after 3 seconds
    config_received = config_ready.wait(timeout=3.0)
    
    global PORT
    PORT = configured_port

    log(f"HTTP JSON-RPC listening on http://{HOST}:{PORT}/rpc")
    log(f"WebSocket JSON-RPC listening on ws://{HOST}:{PORT}/ws")
    if AUTH_TOKEN:
        log("Bearer token authentication enabled for /rpc, /events, and /ws")
    elif ALLOW_NO_AUTH:
        log("WARNING: bearer token authentication is disabled by BROWSER_AGENT_BRIDGE_ALLOW_NO_AUTH")
    else:
        log("ERROR: BROWSER_AGENT_BRIDGE_TOKEN is not set; /rpc, /events, and /ws will reject requests")
    server = ThreadingHTTPServer((HOST, PORT), RpcRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down host server.")
        os._exit(0)

if __name__ == '__main__':
    main()
