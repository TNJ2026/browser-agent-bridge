#!/usr/bin/env python3
import sys
import time
from pathlib import Path

# Add scripts directory to path if needed
sys.path.append(str(Path(__file__).resolve().parent))
from browser_bridge_client import BrowserBridgeClient, BrowserBridgeError

def run_test():
    client = BrowserBridgeClient()
    print("Testing connection and health...")
    health = client.health()
    print(f"Health: {health}")
    if not health.get("extensionReady"):
        print("Error: Chrome extension is not connected to the native host yet. Open side panel or reload extension!")
        return 1

    print("\nStep 1: Creating a new tab on en.wikipedia.org...")
    tab_info = client.rpc("tabs.create", {"url": "https://en.wikipedia.org/", "active": True})
    tab_id = tab_info["tab"]["id"]
    print(f"Created Tab ID: {tab_id}")

    print("\nWaiting for page to load...")
    client.rpc("page.waitForLoad", {"tabId": tab_id})

    print("\nStep 2: Querying the search input element...")
    query_result = client.rpc("dom.query", {"tabId": tab_id, "selector": "input#searchInput"})
    elements = query_result.get("elements", [])
    if not elements:
        print("Error: Search input element 'input#searchInput' not found on the page!")
        return 1
    print(f"Found search input: {elements[0]}")

    print("\nStep 3: Typing 'Python' into the search input...")
    client.rpc("dom.type", {"tabId": tab_id, "selector": "input#searchInput", "text": "Python (programming language)", "replace": True})

    print("\nStep 4: Clicking the search button...")
    client.rpc("dom.click", {"tabId": tab_id, "selector": "#searchform button"})

    print("\nStep 5: Waiting for the target text on the results page...")
    client.rpc("page.waitForText", {"tabId": tab_id, "text": "Python is a high-level", "timeoutMs": 15000})
    print("SUCCESS: Target text 'Python is a high-level' found on the page!")
    
    return 0

if __name__ == "__main__":
    try:
        sys.exit(run_test())
    except BrowserBridgeError as e:
        print(f"E2E Test Failed with BrowserBridgeError: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}")
        sys.exit(1)
