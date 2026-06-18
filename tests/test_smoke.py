#!/usr/bin/env python3
import sys
import time
from pathlib import Path

# Add scripts directory to path for importing client
sys.path.append(str(Path(__file__).resolve().parent.parent / "scripts"))
from browser_bridge_client import BrowserBridgeClient, BrowserBridgeError

def run_smoke_test():
    client = BrowserBridgeClient()
    health = client.health()
    if not health.get("extensionReady"):
        print("Error: Chrome extension is not connected to the native host yet. Open side panel or reload extension!")
        return 1

    # 0. Test CSP bypass configuration APIs
    print("\n0. Testing CSP bypass configuration...")
    orig_csp = client.rpc("extension.getCspBypass", {})
    print(f"Original CSP status: {orig_csp}")
    client.rpc("extension.setCspBypass", {"enabled": False})
    new_csp = client.rpc("extension.getCspBypass", {})
    print(f"New CSP status after disabling: {new_csp}")
    if new_csp.get("enabled") is not False:
        raise RuntimeError("Failed to disable CSP bypass")
    client.rpc("extension.setCspBypass", {"enabled": True})
    restored_csp = client.rpc("extension.getCspBypass", {})
    print(f"Restored CSP status: {restored_csp}")
    if restored_csp.get("enabled") is not True:
        raise RuntimeError("Failed to restore CSP bypass")




    local_page = Path(__file__).resolve().parent / "smoke_test.html"
    file_url = f"file://{local_page.resolve()}"
    print(f"Loading local test page: {file_url}")

    # 1. Create a new tab and wait for it to load
    print("\n1. Creating tab...")
    tab_info = client.rpc("tabs.create", {"url": file_url, "active": True})
    tab_id = tab_info["tab"]["id"]
    print(f"Tab ID: {tab_id}")

    try:
        client.rpc("page.waitForLoad", {"tabId": tab_id})

        # 2. Query elements
        print("\n2. Querying input...")
        query_res = client.rpc("dom.query", {"tabId": tab_id, "selector": "input#input-field"})
        elements = query_res.get("elements", [])
        if not elements:
            raise RuntimeError("Input element not found")
        print(f"Query succeeded: {elements[0]}")

        # 3. Type text into input
        print("\n3. Typing text...")
        client.rpc("dom.type", {"tabId": tab_id, "selector": "input#input-field", "text": "Scraper Test Value", "replace": True})

        # 4. Select from dropdown
        print("\n4. Selecting option B...")
        select_res = client.rpc("dom.select", {"tabId": tab_id, "selector": "select#select-field", "value": "B"})
        print(f"Select result: {select_res}")

        # 5. Click the submit button
        print("\n5. Clicking submit button...")
        click_res = client.rpc("dom.click", {"tabId": tab_id, "selector": "button#submit-btn"})
        print(f"Click result: {click_res}")

        # 6. Wait for text
        print("\n6. Waiting for text change...")
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "Scraper Test Value", "timeoutMs": 5000})
        print("SUCCESS: Local E2E Smoke Test passed!")
        
        return 0

    finally:
        # Cleanup: Close the tab
        print("\nCleaning up: Closing test tab...")
        client.rpc("tabs.close", {"tabId": tab_id})

if __name__ == "__main__":
    try:
        sys.exit(run_smoke_test())
    except Exception as e:
        print(f"Smoke Test Failed: {e}")
        sys.exit(1)
