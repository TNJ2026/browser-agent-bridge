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
                "native/host-wrapper.macos.sh",
                "native/com.local.browser_agent_bridge.json",
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

if __name__ == "__main__":
    unittest.main()
