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
import sqlite3
import shutil
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingTCPServer

PORT = int(os.environ.get('BROWSER_AGENT_BRIDGE_PORT', 8765))
HOST = os.environ.get('BROWSER_AGENT_BRIDGE_HOST', '127.0.0.1')
AUTH_TOKEN = os.environ.get('BROWSER_AGENT_BRIDGE_TOKEN', '')
SAVE_DIR = Path(os.environ.get('BROWSER_AGENT_BRIDGE_SAVE_DIR', str(Path.home() / 'Downloads' / 'browser-agent-bridge')))
MAX_MESSAGE_BYTES = 32 * 1024 * 1024
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;base64)?,(.*)$', re.DOTALL)

extension_ready = False
extension_version = None
next_rpc_id = 1
rpc_id_lock = threading.Lock()

config_ready = threading.Event()
configured_port = PORT

allow_read_tabs = True
allow_read_history = True

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
    global extension_ready, extension_version, configured_port, allow_read_tabs, allow_read_history
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
        config_ready.set()
    elif method == "extension.settings":
        allow_read_tabs = params.get("allowReadTabs", True)
        allow_read_history = params.get("allowReadHistory", True)
    
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

def handle_native_message(message):
    if not isinstance(message, dict):
        return
    
    # Check if notification (no id)
    if "method" in message and "id" not in message:
        handle_native_notification(message)
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
        write_native_message({"type": "pong"})

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

    if request.get("method") == "history.search":
        return handle_history_search(request)

    if request.get("method") == "bookmarks.search":
        return handle_bookmarks_search(request)

    if not extension_ready:
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32000, "message": "Chrome extension is not connected to the native host"}
        }

    req_id = request.get("id")
    if req_id is None:
        with rpc_id_lock:
            req_id = f"native-{next_rpc_id}"
            next_rpc_id += 1
    else:
        req_id = str(req_id)

    forwarded = {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": request["method"],
        "params": request.get("params", {})
    }

    event = threading.Event()
    waiter = {"event": event, "response": None}

    with pending_lock:
        pending_requests[req_id] = waiter

    write_native_message(forwarded)

    timeout_ms = request.get("timeoutMs", 120000)
    timeout_sec = timeout_ms / 1000.0
    finished = event.wait(timeout=timeout_sec)

    with pending_lock:
        pending_requests.pop(req_id, None)

    if not finished:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32000, "message": f"Request timed out: {request['method']}"}
        }
    return waiter["response"]

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
        "text/plain": ".txt"
    }.get(mime_type, ".bin")

def safe_filename(value):
    cleaned = re.sub(r'[\\/:*?"<>|]+', '-', value).strip('. ')
    return cleaned or f"artifact-{uuid.uuid4().hex[:8]}"

def auth_enabled():
    return bool(AUTH_TOKEN)

def is_authorized(headers):
    if not auth_enabled():
        return True
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

def websocket_recv(sock):
    header = websocket_read_exact(sock, 2)
    first, second = header[0], header[1]
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", websocket_read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", websocket_read_exact(sock, 8))[0]
    mask = websocket_read_exact(sock, 4) if masked else b""
    payload = websocket_read_exact(sock, length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    if opcode == 0x8:
        return None
    if opcode == 0x9:
        websocket_send(sock, payload, opcode=0xA)
        return ""
    if opcode != 0x1:
        return ""
    return payload.decode("utf-8")

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
    lock = threading.Lock()
    with websocket_clients_lock:
        websocket_clients[sock] = lock
    return lock

def unregister_websocket(sock):
    with websocket_clients_lock:
        websocket_clients.pop(sock, None)

def broadcast_websocket(value):
    payload = json.dumps(value)
    with websocket_clients_lock:
        clients = list(websocket_clients.items())
    for sock, lock in clients:
        try:
            with lock:
                websocket_send(sock, payload)
        except Exception:
            unregister_websocket(sock)

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
            origin_lower.startswith("http://127.0.0.1:") or origin_lower == "http://127.0.0.1" or
            origin_lower.startswith("chrome-extension://")):
            return True
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
                "extensionReady": extension_ready,
                "extensionVersion": extension_version,
                "authRequired": auth_enabled(),
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
        client_lock = register_websocket(sock)
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

def get_browser_data_dirs():
    home = Path.home()
    if sys.platform == "darwin":
        return [
            {"id": "chrome", "label": "Chrome", "dir": home / "Library/Application Support/Google/Chrome"},
            {"id": "edge", "label": "Edge", "dir": home / "Library/Application Support/Microsoft Edge"}
        ]
    elif sys.platform.startswith("linux"):
        return [
            {"id": "chrome", "label": "Chrome", "dir": home / ".config/google-chrome"},
            {"id": "edge", "label": "Edge", "dir": home / ".config/microsoft-edge"}
        ]
    elif sys.platform == "win32":
        local_app_data = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        return [
            {"id": "chrome", "label": "Chrome", "dir": local_app_data / "Google" / "Chrome" / "User Data"},
            {"id": "edge", "label": "Edge", "dir": local_app_data / "Microsoft" / "Edge" / "User Data"}
        ]
    return []

def list_profiles(data_dir):
    local_state_path = data_dir / "Local State"
    if local_state_path.exists():
        try:
            state = json.loads(local_state_path.read_text(encoding="utf-8", errors="ignore"))
            info = state.get("profile", {}).get("info_cache", {})
            profiles = [{"dir": d, "name": info[d].get("name", d)} for d in info]
            if profiles:
                return profiles
        except Exception:
            pass
    return [{"dir": "Default", "name": "Default"}]

def handle_history_search(request):
    if not allow_read_history:
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32601, "message": "Method blocked by user privacy settings: history search is disabled"}
        }

    params = request.get("params", {}) or {}
    query = params.get("query", "")
    limit = params.get("limit", 20)
    since = params.get("since")
    browser_filter = params.get("browser")
    
    keywords = [k.strip() for k in query.split() if k.strip()]
    since_dt = None
    if since:
        try:
            if isinstance(since, (int, float)):
                since_dt = time.time() - since
            elif isinstance(since, str):
                m = re.match(r"^(\d+)([dhm])$", since.strip().lower())
                if m:
                    val = int(m.group(1))
                    unit = m.group(2)
                    sec = {"d": 86400, "h": 3600, "m": 60}[unit]
                    since_dt = time.time() - (val * sec)
                else:
                    since_dt = time.mktime(time.strptime(since.strip(), "%Y-%m-%d"))
        except Exception as e:
            log(f"Failed to parse since parameter {since}: {e}")
            
    WEBKIT_EPOCH_DIFF_US = 11644473600000000
    results = []
    
    browser_dirs = get_browser_data_dirs()
    for b in browser_dirs:
        if not b["dir"].exists():
            continue
        if browser_filter and b["id"] != browser_filter:
            continue
            
        profiles = list_profiles(b["dir"])
        for p in profiles:
            p_dir = b["dir"] / p["dir"]
            history_file = p_dir / "History"
            if not history_file.exists():
                continue
                
            temp_db = None
            try:
                fd, temp_path = tempfile.mkstemp(suffix=".sqlite")
                os.close(fd)
                temp_db = Path(temp_path)
                shutil.copy2(history_file, temp_db)
                
                conn = sqlite3.connect(str(temp_db))
                cursor = conn.cursor()
                
                conds = ["last_visit_time > 0"]
                sql_params = []
                for kw in keywords:
                    conds.append("LOWER(title || ' ' || url) LIKE ?")
                    sql_params.append(f"%{kw.lower()}%")
                    
                if since_dt:
                    webkit_us = int(since_dt * 1000000) + WEBKIT_EPOCH_DIFF_US
                    conds.append("last_visit_time >= ?")
                    sql_params.append(webkit_us)
                    
                where_clause = " AND ".join(conds)
                sql_limit = limit * 2 if limit > 0 else 1000
                sql = f"""
                SELECT title, url, last_visit_time, visit_count
                FROM urls WHERE {where_clause}
                ORDER BY last_visit_time DESC LIMIT {sql_limit}
                """
                cursor.execute(sql, sql_params)
                for row in cursor.fetchall():
                    title, url, last_visit_time, visit_count = row
                    unix_time = (last_visit_time - WEBKIT_EPOCH_DIFF_US) / 1000000
                    results.append({
                        "browser": b["label"],
                        "profile": p["name"],
                        "title": title or "",
                        "url": url or "",
                        "visitTime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(unix_time)),
                        "timestamp": unix_time,
                        "visitCount": visit_count
                    })
                conn.close()
            except Exception as e:
                log(f"Failed to query history for {b['label']} {p['name']}: {e}")
            finally:
                if temp_db and temp_db.exists():
                    try:
                        temp_db.unlink()
                    except Exception:
                        pass
                        
    results.sort(key=lambda x: x["timestamp"], reverse=True)
    if limit > 0:
        results = results[:limit]
        
    return {
        "jsonrpc": "2.0",
        "id": request.get("id"),
        "result": {
            "history": results
        }
    }

def handle_bookmarks_search(request):
    if not allow_read_history:
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "error": {"code": -32601, "message": "Method blocked by user privacy settings: bookmarks search is disabled"}
        }

    params = request.get("params", {}) or {}
    query = params.get("query", "")
    browser_filter = params.get("browser")
    
    keywords = [k.strip().lower() for k in query.split() if k.strip()]
    results = []
    
    browser_dirs = get_browser_data_dirs()
    for b in browser_dirs:
        if not b["dir"].exists():
            continue
        if browser_filter and b["id"] != browser_filter:
            continue
            
        profiles = list_profiles(b["dir"])
        for p in profiles:
            p_dir = b["dir"] / p["dir"]
            bookmarks_file = p_dir / "Bookmarks"
            if not bookmarks_file.exists():
                continue
                
            try:
                data = json.loads(bookmarks_file.read_text(encoding="utf-8", errors="ignore"))
                
                def walk(node, trail):
                    if not node:
                        return
                    if node.get("type") == "url":
                        url = node.get("url", "")
                        name = node.get("name", "")
                        hay = f"{name} {url}".lower()
                        if not keywords or all(kw in hay for kw in keywords):
                            results.append({
                                "browser": b["label"],
                                "profile": p["name"],
                                "name": name,
                                "url": url,
                                "folder": " / ".join(trail)
                            })
                    if isinstance(node.get("children"), list):
                        sub_trail = trail + [node["name"]] if node.get("name") else trail
                        for child in node["children"]:
                            walk(child, sub_trail)
                            
                for root in data.get("roots", {}).values():
                    walk(root, [])
            except Exception as e:
                log(f"Failed to read bookmarks for {b['label']} {p['name']}: {e}")
                
    results = results[:1000]
    return {
        "jsonrpc": "2.0",
        "id": request.get("id"),
        "result": {
            "bookmarks": results
        }
    }

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
    if auth_enabled():
        log("Bearer token authentication enabled for /rpc, /events, and /ws")
    server = ThreadingHTTPServer((HOST, PORT), RpcRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down host server.")
        os._exit(0)

if __name__ == '__main__':
    main()
