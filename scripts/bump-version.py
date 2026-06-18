#!/usr/bin/env python3
import sys
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def bump(part):
    manifest_path = ROOT / "extension" / "manifest.json"
    if not manifest_path.exists():
        print(f"Error: manifest.json not found at {manifest_path}")
        return 1

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        version = manifest.get("version", "0.0.0")
        parts = list(map(int, version.split(".")))
    except Exception as e:
        print(f"Error parsing manifest.json: {e}")
        return 1

    if part == "major":
        parts[0] += 1
        parts[1] = 0
        parts[2] = 0
    elif part == "minor":
        parts[1] += 1
        parts[2] = 0
    elif part == "patch":
        parts[2] += 1
    else:
        print(f"Unknown semver component: '{part}'. Choose from: major, minor, patch")
        return 1

    new_version = ".".join(map(str, parts))
    manifest["version"] = new_version
    try:
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Successfully bumped version from {version} to {new_version}")
    except Exception as e:
        print(f"Failed to write updated manifest.json: {e}")
        return 1
    return 0

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: scripts/bump-version.py [major|minor|patch]")
        sys.exit(1)
    sys.exit(bump(sys.argv[1].lower()))
