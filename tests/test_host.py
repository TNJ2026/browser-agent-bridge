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
    def test_extension_for_mime(self):
        self.assertEqual(host.extension_for_mime("image/png"), ".png")
        self.assertEqual(host.extension_for_mime("image/jpeg"), ".jpg")
        self.assertEqual(host.extension_for_mime("application/json"), ".json")
        self.assertEqual(host.extension_for_mime("text/plain"), ".txt")
        self.assertEqual(host.extension_for_mime("unknown/mime"), ".bin")

    def test_safe_filename(self):
        self.assertEqual(host.safe_filename("test_file.png"), "test_file.png")
        self.assertEqual(host.safe_filename("test/\\?*|:file.png"), "test-file.png")
        self.assertTrue(host.safe_filename("...").startswith("artifact-"))  # falls back if empty/dots only

    def test_auth_checks(self):
        # Default: AUTH_TOKEN is empty in unit tests
        host.AUTH_TOKEN = ""
        self.assertTrue(host.is_authorized({}))
        self.assertTrue(host.is_authorized({"Authorization": "Bearer test-token"}))

        # With token enabled
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
            original_safe_filename = host.safe_filename
            try:
                host.safe_filename = lambda x: "../escaped.txt"
                with self.assertRaises(ValueError):
                    host.save_data_url(params)
            finally:
                host.safe_filename = original_safe_filename

    def test_origin_validation(self):
        class Dummy:
            pass
        dummy = Dummy()
        dummy.is_origin_allowed = host.RpcRequestHandler.is_origin_allowed.__get__(dummy)
        
        self.assertTrue(dummy.is_origin_allowed(None))
        self.assertTrue(dummy.is_origin_allowed(""))
        self.assertTrue(dummy.is_origin_allowed("http://localhost:3000"))
        self.assertTrue(dummy.is_origin_allowed("http://localhost"))
        self.assertTrue(dummy.is_origin_allowed("http://127.0.0.1:8000"))
        self.assertTrue(dummy.is_origin_allowed("chrome-extension://aodcpicfepmdmpfaflncbndcicoemdje"))
        
        self.assertFalse(dummy.is_origin_allowed("https://example.com"))
        self.assertFalse(dummy.is_origin_allowed("http://malicious.com:8765"))

if __name__ == "__main__":
    unittest.main()
