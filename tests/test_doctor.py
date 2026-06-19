#!/usr/bin/env python3
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

# Add scripts folder to import path
sys.path.append(str(Path(__file__).resolve().parent.parent / "scripts"))
import doctor

class TestDoctor(unittest.TestCase):
    def test_overall_status(self):
        self.assertEqual(doctor.overall_status([{"status": "pass"}]), "pass")
        self.assertEqual(doctor.overall_status([{"status": "pass"}, {"status": "warn"}]), "warn")
        self.assertEqual(doctor.overall_status([{"status": "pass"}, {"status": "fail"}]), "fail")
        self.assertEqual(doctor.overall_status([]), "pass")

    def test_check_repo_files_all_present(self):
        checks = []
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_root = Path(tmpdir)
            required = [
                "extension/manifest.json",
                "extension/service-worker.js",
                "native/host.py",
                "native/host-wrapper.sh",
                "native/host-wrapper.win.bat",
                "native/com.local.browser_agent_bridge.json",
                "scripts/install-native-host-unix.sh",
                "scripts/rpc.sh",
                "scripts/ws-rpc.js",
                "scripts/browser_bridge_client.py",
            ]
            for path in required:
                full_path = tmp_root / path
                full_path.parent.mkdir(parents=True, exist_ok=True)
                full_path.touch()

            with patch("doctor.ROOT", tmp_root):
                doctor.check_repo_files(checks)

            self.assertEqual(len(checks), 1)
            self.assertEqual(checks[0]["status"], "pass")
            self.assertIn("required project files exist", checks[0]["message"])

    def test_check_repo_files_missing(self):
        checks = []
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_root = Path(tmpdir)
            with patch("doctor.ROOT", tmp_root):
                doctor.check_repo_files(checks)

            self.assertEqual(len(checks), 1)
            self.assertEqual(checks[0]["status"], "fail")
            self.assertIn("missing", checks[0]["message"])

    def test_native_manifest_candidates_linux(self):
        with patch("doctor.Path.home", return_value=Path("/home/alice")):
            paths = doctor.native_manifest_candidates("linux")
        self.assertIn(Path("/home/alice/.config/google-chrome/NativeMessagingHosts/com.local.browser_agent_bridge.json"), paths)
        self.assertIn(Path("/home/alice/.config/chromium/NativeMessagingHosts/com.local.browser_agent_bridge.json"), paths)

    def test_check_native_manifest_installed(self):
        checks = []
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_root = Path(tmpdir)
            host_wrapper = tmp_root / "native" / "host-wrapper.sh"
            host_wrapper.parent.mkdir(parents=True)
            host_wrapper.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            host_wrapper.chmod(0o755)
            manifest = tmp_root / "manifest.json"
            manifest.write_text(
                """{
  "name": "com.local.browser_agent_bridge",
  "description": "Browser Agent Bridge native messaging host",
  "path": "%s",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://abc/"]
}
""" % str(host_wrapper),
                encoding="utf-8",
            )

            with patch("doctor.current_platform", return_value="macos"), patch("doctor.find_native_manifest", return_value=manifest):
                doctor.check_native_manifest(checks)

        statuses = {check["name"]: check["status"] for check in checks}
        self.assertEqual(statuses["native.manifest.installed"], "pass")
        self.assertEqual(statuses["native.manifest.path"], "pass")

    def test_check_wrapper_windows(self):
        checks = []
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_root = Path(tmpdir)
            wrapper = tmp_root / "native" / "host-wrapper.win.bat"
            wrapper.parent.mkdir(parents=True)
            wrapper.write_text(
                "@echo off\nset BROWSER_AGENT_BRIDGE_EXTENSION_ID=abc\nset ENV_FILE=%USERPROFILE%\\.browser-agent-bridge.env\npython host.py\n",
                encoding="utf-8",
            )
            with patch("doctor.ROOT", tmp_root), patch("doctor.current_platform", return_value="windows"):
                doctor.check_wrapper(checks)

        self.assertEqual(checks[0]["status"], "pass")

if __name__ == "__main__":
    unittest.main()
