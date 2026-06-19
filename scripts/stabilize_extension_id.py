#!/usr/bin/env python3
import sys
import os
import json
import struct
import base64
import hashlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def main():
    key_pem = ROOT / "key.pem"
    manifest_json = ROOT / "extension" / "manifest.json"

    print("Step 1: Generating private key if not exists...")
    if not key_pem.exists():
        try:
            subprocess.run(
                "openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out key.pem",
                shell=True,
                cwd=ROOT,
                check=True
            )
            print("Generated key.pem")
        except Exception as e:
            print(f"Failed to generate private key: {e}")
            return 1

    print("\nStep 2: Extracting public key in DER format (Base64)...")
    try:
        res = subprocess.run(
            "openssl rsa -in key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A",
            shell=True,
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True
        )
        pub_key_base64 = res.stdout.strip()
    except Exception as e:
        print(f"Failed to extract public key DER: {e}")
        return 1

    print("\nStep 3: Injecting key into manifest.json...")
    try:
        manifest = json.loads(manifest_json.read_text(encoding="utf-8"))
        manifest["key"] = pub_key_base64
        # Format manifest nicely
        manifest_json.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("Updated extension/manifest.json")
    except Exception as e:
        print(f"Failed to update manifest.json: {e}")
        return 1

    print("\nStep 4: Calculating new stable Extension ID...")
    try:
        pub_key_der = base64.b64decode(pub_key_base64)
        sha = hashlib.sha256(pub_key_der).hexdigest()
        ext_id = "".join(chr(int(c, 16) + 97) for c in sha[:32])
        print(f"Calculated Stable Extension ID: {ext_id}")
    except Exception as e:
        print(f"Failed to calculate ID: {e}")
        return 1

    print("\nStep 5: Updating Native Messaging Manifest using installer...")
    try:
        installer = ROOT / "scripts" / "install-native-host-unix.sh"
        subprocess.run([str(installer), ext_id], check=True)
    except Exception as e:
        print(f"Failed to run native host installer: {e}")
        return 1

    print("\nSUCCESS: Extension ID stabilized!")
    print(f"Your stable Extension ID is now: {ext_id}")
    print("Please reload the extension in chrome://extensions to apply.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
