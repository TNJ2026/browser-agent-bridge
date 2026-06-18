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
SAVE_DIR = Path(os.environ.get('BROWSER_AGENT_BRIDGE_SAVE_DIR', str(Path.home() / 'Downloads' / 'browser-agent-bridge')))
MAX_MESSAGE_BYTES = 32 * 1024 * 1024
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;base64)?,(.*)$', re.DOTALL)

extension_ready = False
extension_version = None
next_rpc_id = 1
rpc_id_lock = threading.Lock()

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
    global extension_ready, extension_version
    method = message.get("method")
    params = message.get("params", {})
    if method == "extension.ready":
        extension_ready = True
        extension_version = params.get("version")
    
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

    def set_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'authorization,content-type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204)
        self.set_cors_headers()
        self.end_headers()

    def do_GET(self):
        global extension_ready, extension_version
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
