#!/usr/bin/env python3
import sys
import unittest
import tempfile
import time
from pathlib import Path

# Add native folder to import path
sys.path.append(str(Path(__file__).resolve().parent.parent / "native"))
import host

class TestHostUtilities(unittest.TestCase):
    def setUp(self):
        self._host_state = {
            "AUTH_TOKEN": host.AUTH_TOKEN,
            "ALLOW_NO_AUTH": host.ALLOW_NO_AUTH,
            "ALLOW_CUSTOM_SAVE_DIR": host.ALLOW_CUSTOM_SAVE_DIR,
            "EXTENSION_ID": host.EXTENSION_ID,
            "EXTENSION_ID_FROM_ENV": host.EXTENSION_ID_FROM_ENV,
            "safe_filename": host.safe_filename,
            "extension_ready": host.extension_ready,
            "next_rpc_id": host.next_rpc_id,
            "write_native_message": host.write_native_message,
        }
        host.write_native_message = lambda message: None
        with host.websocket_clients_lock:
            host.websocket_clients.clear()

    def tearDown(self):
        with host.websocket_clients_lock:
            host.websocket_clients.clear()
        for name, value in self._host_state.items():
            setattr(host, name, value)

    def test_extension_for_mime(self):
        self.assertEqual(host.extension_for_mime("image/png"), ".png")
        self.assertEqual(host.extension_for_mime("image/jpeg"), ".jpg")
        self.assertEqual(host.extension_for_mime("application/json"), ".json")
        self.assertEqual(host.extension_for_mime("application/pdf"), ".pdf")
        self.assertEqual(host.extension_for_mime("text/plain"), ".txt")
        self.assertEqual(host.extension_for_mime("unknown/mime"), ".bin")

    def test_safe_filename(self):
        self.assertEqual(host.safe_filename("test_file.png"), "test_file.png")
        self.assertEqual(host.safe_filename("test/\\?*|:file.png"), "test-file.png")
        self.assertTrue(host.safe_filename("...").startswith("artifact-"))  # falls back if empty/dots only

    def test_auth_checks(self):
        # Default: empty AUTH_TOKEN and ALLOW_NO_AUTH is False -> unauthorized
        host.AUTH_TOKEN = ""
        host.ALLOW_NO_AUTH = False
        self.assertFalse(host.is_authorized({}))

        # With ALLOW_NO_AUTH=True and empty AUTH_TOKEN -> authorized
        host.ALLOW_NO_AUTH = True
        self.assertTrue(host.is_authorized({}))
        self.assertTrue(host.is_authorized({"Authorization": "Bearer test-token"}))

        # With token enabled
        host.ALLOW_NO_AUTH = False
        host.AUTH_TOKEN = "secret-key"
        self.assertFalse(host.is_authorized({}))
        self.assertFalse(host.is_authorized({"Authorization": "Bearer wrong-key"}))
        self.assertTrue(host.is_authorized({"Authorization": "Bearer secret-key"}))

    def test_save_data_url_text(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            params = {
                "dataUrl": "data:text/plain;base64,YnJvd3Nlci1hZ2VudC1icmlkZ2U=",
                "filename": "hello.txt",
                "directory": tmpdir
            }
            # Should fail when ALLOW_CUSTOM_SAVE_DIR is False
            host.ALLOW_CUSTOM_SAVE_DIR = False
            with self.assertRaises(ValueError):
                host.save_data_url(params)

            # Should succeed when ALLOW_CUSTOM_SAVE_DIR is True
            host.ALLOW_CUSTOM_SAVE_DIR = True
            path, size, mime = host.save_data_url(params)
            self.assertTrue(path.exists())
            self.assertEqual(path.read_text(encoding="utf-8"), "browser-agent-bridge")
            self.assertEqual(size, 20)
            self.assertEqual(mime, "text/plain")

    def test_save_data_url_traversal_protection(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            params = {
                "dataUrl": "data:text/plain;base64,YnJvd3Nlci1hZ2VudC1icmlkZ2U=",
                "filename": "escaped.txt",
                "directory": tmpdir
            }
            host.safe_filename = lambda x: "../escaped.txt"
            host.ALLOW_CUSTOM_SAVE_DIR = True
            with self.assertRaises(ValueError):
                host.save_data_url(params)

    def test_origin_validation(self):
        class Dummy:
            pass
        dummy = Dummy()
        dummy.is_origin_allowed = host.RpcRequestHandler.is_origin_allowed.__get__(dummy)
        host.EXTENSION_ID = "aodcpicfepmdmpfaflncbndcicoemdje"
        
        self.assertTrue(dummy.is_origin_allowed(None))
        self.assertTrue(dummy.is_origin_allowed(""))
        self.assertTrue(dummy.is_origin_allowed("http://localhost:3000"))
        self.assertTrue(dummy.is_origin_allowed("http://localhost"))
        self.assertTrue(dummy.is_origin_allowed("http://127.0.0.1:8000"))
        self.assertTrue(dummy.is_origin_allowed("chrome-extension://aodcpicfepmdmpfaflncbndcicoemdje"))
        self.assertTrue(dummy.is_origin_allowed("chrome-extension://aodcpicfepmdmpfaflncbndcicoemdje/"))
        
        self.assertFalse(dummy.is_origin_allowed("chrome-extension://otherextensionid"))
        self.assertFalse(dummy.is_origin_allowed("https://example.com"))
        self.assertFalse(dummy.is_origin_allowed("http://malicious.com:8765"))

    def test_origin_validation_fails_closed_without_pinned_id(self):
        class Dummy:
            pass
        dummy = Dummy()
        dummy.is_origin_allowed = host.RpcRequestHandler.is_origin_allowed.__get__(dummy)
        host.EXTENSION_ID = ""

        # Non-browser clients (no Origin) and localhost stay allowed.
        self.assertTrue(dummy.is_origin_allowed(None))
        self.assertTrue(dummy.is_origin_allowed(""))
        self.assertTrue(dummy.is_origin_allowed("http://127.0.0.1:8765"))
        # Unknown extension origin is rejected instead of blanket-allowed.
        self.assertFalse(dummy.is_origin_allowed("chrome-extension://aodcpicfepmdmpfaflncbndcicoemdje"))

    def test_extension_ready_adopts_reported_id_when_not_env_pinned(self):
        host.EXTENSION_ID = ""
        host.EXTENSION_ID_FROM_ENV = False
        host.handle_native_notification({
            "method": "extension.ready",
            "params": {"version": "1.0.0", "extensionId": "lpemchcojepfkbgjgoehfknibdjjppig"},
        })
        self.assertEqual(host.EXTENSION_ID, "lpemchcojepfkbgjgoehfknibdjjppig")

    def test_extension_ready_keeps_env_pinned_id(self):
        host.EXTENSION_ID = "aodcpicfepmdmpfaflncbndcicoemdje"
        host.EXTENSION_ID_FROM_ENV = True
        host.handle_native_notification({
            "method": "extension.ready",
            "params": {"extensionId": "lpemchcojepfkbgjgoehfknibdjjppig"},
        })
        self.assertEqual(host.EXTENSION_ID, "aodcpicfepmdmpfaflncbndcicoemdje")

    def test_extension_ready_rejects_malformed_reported_id(self):
        host.EXTENSION_ID = ""
        host.EXTENSION_ID_FROM_ENV = False
        for bad in ("../etc/passwd", "ABCDEF", "lpemchcojepfkbgjgoehfknibdjjppi", "xyz"):
            host.handle_native_notification({
                "method": "extension.ready",
                "params": {"extensionId": bad},
            })
            self.assertEqual(host.EXTENSION_ID, "")

    def test_native_ping_replies_with_pong(self):
        sent = []
        host.write_native_message = sent.append

        host.handle_native_message({"type": "ping", "timestamp": 1234})

        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["type"], "pong")
        self.assertEqual(sent[0]["timestamp"], 1234)
        self.assertIsInstance(sent[0]["now"], int)

    def test_get_site_patterns(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_root = Path(tmpdir)
            patterns_dir = tmp_root / "skills" / "browser-agent-bridge" / "references" / "site-patterns"
            patterns_dir.mkdir(parents=True)

            test_md = patterns_dir / "example.com.md"
            test_md.write_text("# Example Site\n\nThis is a summary of example.com.\nMore details here.", encoding="utf-8")

            with patch("host.Path.resolve") as mock_resolve:
                mock_resolve.return_value = tmp_root / "native" / "host.py"
                patterns = host.get_site_patterns()

            self.assertEqual(len(patterns), 1)
            self.assertEqual(patterns[0]["domain"], "example.com")
            self.assertEqual(patterns[0]["filename"], "example.com.md")
            self.assertEqual(patterns[0]["summary"], "This is a summary of example.com. More details here.")
            self.assertIn("Example Site", patterns[0]["content"])

    def test_websocket_recv_rejects_oversized_frame(self):
        import struct

        class FakeSock:
            def __init__(self, chunks):
                self._chunks = list(chunks)
                self.read_bytes = 0
                self.sent = []

            def recv(self, size):
                if not self._chunks:
                    raise AssertionError("recv called after payload would be read")
                chunk = self._chunks.pop(0)
                self.read_bytes += len(chunk)
                return chunk

            def sendall(self, data):
                self.sent.append(data)

        # FIN + text opcode, length marker 127, then 8-byte length above the cap.
        huge = host.MAX_MESSAGE_BYTES + 1
        chunks = [bytes([0x81]), bytes([0x7F]), struct.pack("!Q", huge)]
        sock = FakeSock(chunks)

        with self.assertRaises(ConnectionError):
            host.websocket_recv(sock)

        # Only the 10 header bytes were read; payload never allocated.
        self.assertEqual(sock.read_bytes, 10)
        # A close frame (opcode 0x8) with status 1009 was sent back.
        self.assertEqual(len(sock.sent), 1)
        self.assertEqual(sock.sent[0][0] & 0x0F, 0x8)
        self.assertEqual(struct.unpack("!H", sock.sent[0][2:4])[0], 1009)

    def test_call_extension_isolates_colliding_client_ids(self):
        from unittest.mock import patch

        host.extension_ready = True
        captured = []

        def fake_write(msg):
            # Simulate the extension echoing the forwarded (internal) id back.
            internal_id = msg["id"]
            captured.append(internal_id)
            with host.pending_lock:
                waiter = host.pending_requests.get(internal_id)
            waiter["response"] = {
                "jsonrpc": "2.0",
                "id": internal_id,
                "result": {"echo": internal_id},
            }
            waiter["event"].set()

        with patch("host.write_native_message", side_effect=fake_write):
            r1 = host.call_extension({"jsonrpc": "2.0", "id": 1, "method": "tabs.list", "params": {}})
            r2 = host.call_extension({"jsonrpc": "2.0", "id": 1, "method": "tabs.list", "params": {}})

        # Same client id (1) but distinct internal correlation ids -> no collision.
        self.assertNotEqual(captured[0], captured[1])
        self.assertTrue(captured[0].startswith("rpc-"))
        # Client's original id (and int type) is restored on the response.
        self.assertEqual(r1["id"], 1)
        self.assertEqual(r2["id"], 1)
        self.assertIsInstance(r1["id"], int)
        # Each response carries its own internal echo -> matched to the right waiter.
        self.assertEqual(r1["result"]["echo"], captured[0])
        self.assertEqual(r2["result"]["echo"], captured[1])
        # Waiters cleaned up.
        self.assertNotIn(captured[0], host.pending_requests)
        self.assertNotIn(captured[1], host.pending_requests)

    def test_call_extension_falls_back_to_internal_id_when_client_omits_id(self):
        from unittest.mock import patch

        host.extension_ready = True

        def fake_write(msg):
            internal_id = msg["id"]
            with host.pending_lock:
                waiter = host.pending_requests.get(internal_id)
            waiter["response"] = {"jsonrpc": "2.0", "id": internal_id, "result": {}}
            waiter["event"].set()

        with patch("host.write_native_message", side_effect=fake_write):
            r = host.call_extension({"jsonrpc": "2.0", "method": "tabs.list", "params": {}})

        # No client id supplied -> response carries the internal id, never None.
        self.assertTrue(str(r["id"]).startswith("rpc-"))

    def test_event_tab_id_extraction(self):
        self.assertEqual(host.event_tab_id({"params": {"source": {"tabId": 7}}}), 7)
        self.assertEqual(host.event_tab_id({"params": {"tabId": 9}}), 9)
        self.assertIsNone(host.event_tab_id({"params": {"version": "1.0.0"}}))
        self.assertIsNone(host.event_tab_id({}))
        self.assertIsNone(host.event_tab_id("not-a-dict"))

    def test_apply_ws_subscription(self):
        client = {"lock": None, "tabs": None}

        # List of ints -> set; duplicates collapse, bools/strings dropped.
        r = host.apply_ws_subscription(client, {"id": 1, "params": {"tabIds": [1, 2, 2, True, "x"]}})
        self.assertEqual(client["tabs"], {1, 2})
        self.assertEqual(r["result"]["subscribed"], [1, 2])

        # null -> clears filter (receive all).
        r = host.apply_ws_subscription(client, {"id": 2, "params": {"tabIds": None}})
        self.assertIsNone(client["tabs"])
        self.assertIsNone(r["result"]["subscribed"])

        # Wrong type -> error, filter unchanged.
        r = host.apply_ws_subscription(client, {"id": 3, "params": {"tabIds": "bad"}})
        self.assertIn("error", r)
        self.assertIsNone(client["tabs"])

    def test_broadcast_websocket_filters_by_tab_subscription(self):
        class FakeSock:
            def __init__(self):
                self.sent = []

            def sendall(self, data):
                self.sent.append(data)

        sub_sock = FakeSock()
        all_sock = FakeSock()
        sub_client = host.register_websocket(sub_sock)
        sub_client["tabs"] = {123}
        host.register_websocket(all_sock)  # tabs stays None -> receive all
        try:
            # Tab-scoped event for a subscribed tab -> both clients.
            host.broadcast_websocket({"jsonrpc": "2.0", "method": "cdp.event",
                                      "params": {"source": {"tabId": 123}, "method": "Network.x"}})
            # Tab-scoped event for another tab -> only the unfiltered client.
            host.broadcast_websocket({"jsonrpc": "2.0", "method": "cdp.event",
                                      "params": {"source": {"tabId": 999}}})
            # Global event (no tab id) -> both clients.
            host.broadcast_websocket({"jsonrpc": "2.0", "method": "extension.ready",
                                      "params": {"version": "1.0.0"}})
        finally:
            host.unregister_websocket(sub_sock)
            host.unregister_websocket(all_sock)

        self.assertEqual(len(sub_sock.sent), 2)  # tab123 + global
        self.assertEqual(len(all_sock.sent), 3)  # all three

    def test_websocket_subscription_status_summary(self):
        class FakeSock:
            def sendall(self, data):
                pass

        published = []
        host.write_native_message = lambda message: published.append(message)
        all_sock = FakeSock()
        sub_sock = FakeSock()
        all_client = host.register_websocket(all_sock)
        self.assertEqual(host.current_ws_subscription_status(), {"all": True, "tabIds": []})

        sub_client = host.register_websocket(sub_sock)
        host.apply_ws_subscription(sub_client, {"id": 1, "params": {"tabIds": [5, 3, 3]}})
        # One unfiltered client still requires all CDP events.
        self.assertEqual(host.current_ws_subscription_status(), {"all": True, "tabIds": []})

        host.apply_ws_subscription(all_client, {"id": 2, "params": {"tabIds": [9]}})
        self.assertEqual(host.current_ws_subscription_status(), {"all": False, "tabIds": [3, 5, 9]})

        host.unregister_websocket(sub_sock)
        self.assertEqual(host.current_ws_subscription_status(), {"all": False, "tabIds": [9]})
        host.unregister_websocket(all_sock)
        self.assertEqual(host.current_ws_subscription_status(), {"all": False, "tabIds": []})
        self.assertTrue(all(message["method"] == "bridge.subscriptionStatus" for message in published))

    def test_handle_native_request_rejects_unknown_methods(self):
        from unittest.mock import patch
        request = {
            "jsonrpc": "2.0",
            "id": "bad-method",
            "method": "tabs.list",
            "params": {}
        }
        with patch("host.call_extension") as call_extension, patch("host.write_native_message") as write_native_message:
            host.handle_native_request(request)

        call_extension.assert_not_called()
        write_native_message.assert_called_once()
        response = write_native_message.call_args.args[0]
        self.assertEqual(response["id"], "bad-method")
        self.assertEqual(response["error"]["code"], -32601)

if __name__ == "__main__":
    unittest.main()
