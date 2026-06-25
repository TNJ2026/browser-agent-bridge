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

    # 0. Test CSP bypass configuration APIs (read-only)
    print("\n0. Testing CSP bypass configuration...")
    orig_csp = client.rpc("extension.getCspBypass", {})
    print(f"Original CSP status: {orig_csp}")




    local_page = Path(__file__).resolve().parent / "smoke_test.html"
    file_url = local_page.resolve().as_uri()
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

        print("\n2.25 Testing locator APIs...")
        count_res = client.rpc("locator.count", {"tabId": tab_id, "label": "Text Input"})
        if count_res.get("count", 0) < 1:
            raise RuntimeError("Locator label count failed")
        wait_res = client.rpc("locator.waitFor", {"tabId": tab_id, "role": "button", "name": "Submit Action", "state": "visible"})
        print(f"Locator wait result: {wait_res}")
        heading_res = client.rpc("locator.count", {"tabId": tab_id, "role": "heading", "name": "ARIA Controls", "level": 2})
        if heading_res.get("count", 0) != 1:
            raise RuntimeError("Locator heading role/name/level failed")
        pressed_res = client.rpc("locator.count", {"tabId": tab_id, "role": "button", "name": "Pressed Toggle", "pressed": True})
        if pressed_res.get("count", 0) != 1:
            raise RuntimeError("Locator pressed role state failed")
        aria_click_res = client.rpc("locator.click", {"tabId": tab_id, "role": "button", "name": "ARIA Controls Labelled Action"})
        print(f"ARIA labelled click result: {aria_click_res}")
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "ARIA Done", "timeoutMs": 5000})
        frames_res = client.rpc("page.frames", {"tabId": tab_id})
        print(f"Frames result: {frames_res}")
        child_frames = [frame for frame in frames_res.get("frames", []) if frame.get("frameId") != 0]
        if not child_frames:
            raise RuntimeError("Expected iframe to appear in page.frames")
        frame_id = child_frames[0]["frameId"]
        frame_heading = client.rpc("locator.count", {"tabId": tab_id, "frameId": frame_id, "role": "heading", "name": "Frame Area", "level": 2})
        if frame_heading.get("count", 0) != 1:
            raise RuntimeError("Locator frame role/name/level failed")
        frame_click = client.rpc("locator.click", {"tabId": tab_id, "frameId": frame_id, "role": "button", "name": "Frame Action"})
        print(f"Frame click result: {frame_click}")
        client.rpc("page.waitForText", {"tabId": tab_id, "frameId": frame_id, "text": "Frame Done", "timeoutMs": 5000})
        shadow_heading = client.rpc("locator.count", {"tabId": tab_id, "role": "heading", "name": "Shadow Area", "level": 2})
        if shadow_heading.get("count", 0) != 1:
            raise RuntimeError("Locator shadow heading failed")
        shadow_fill = client.rpc("locator.fill", {"tabId": tab_id, "label": "Shadow Input", "text": "Shadow Typed"})
        print(f"Shadow fill result: {shadow_fill}")
        shadow_click = client.rpc("locator.click", {"tabId": tab_id, "role": "button", "name": "Shadow Action"})
        print(f"Shadow click result: {shadow_click}")
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "Shadow Done", "timeoutMs": 5000})
        text_res = client.rpc("locator.textContent", {"tabId": tab_id, "text": "Bridge Smoke Test"})
        print(f"Locator text result: {text_res}")
        covered_res = client.rpc("locator.click", {"tabId": tab_id, "role": "button", "name": "Covered Action", "timeoutMs": 3000})
        print(f"Covered click result: {covered_res}")
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "Covered Done", "timeoutMs": 5000})
        delayed_res = client.rpc("locator.click", {"tabId": tab_id, "role": "button", "name": "Delayed Action", "timeoutMs": 3000})
        print(f"Locator delayed click result: {delayed_res}")
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "Delayed Done", "timeoutMs": 5000})
        dom_delayed_res = client.rpc("dom.click", {"tabId": tab_id, "selector": "button#dom-delayed-btn", "timeoutMs": 3000})
        print(f"DOM delayed click result: {dom_delayed_res}")
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "DOM Delayed Done", "timeoutMs": 5000})

        # 2.5 Test Hover, Scroll and Shortcut Key APIs
        print("\n2.5 Testing Hover, Scroll and Shortcut Key APIs...")
        hover_res = client.rpc("dom.hover", {"tabId": tab_id, "selector": "button#submit-btn"})
        print(f"DOM hover result: {hover_res}")
        client.rpc("computer.hover", {"tabId": tab_id, "x": 100, "y": 100})
        client.rpc("computer.key", {"tabId": tab_id, "key": "Control+a"})
        scroll_res = client.rpc("dom.scroll", {"tabId": tab_id, "selector": "body", "x": 0, "y": 50, "mode": "scrollBy"})
        print(f"DOM scroll result: {scroll_res}")

        # 3. Type text into input
        print("\n3. Typing text...")
        client.rpc("locator.fill", {"tabId": tab_id, "label": "Text Input", "text": "Scraper Test Value"})

        # 4. Select from dropdown
        print("\n4. Selecting option B...")
        select_res = client.rpc("locator.selectOption", {"tabId": tab_id, "locator": {"label": "Dropdown Select"}, "option": {"label": "Option B", "exact": True}})
        print(f"Select result: {select_res}")
        check_res = client.rpc("locator.check", {"tabId": tab_id, "label": "Agree Terms"})
        print(f"Check result: {check_res}")
        checked_count = client.rpc("locator.count", {"tabId": tab_id, "role": "checkbox", "name": "Agree Terms", "checked": True})
        if checked_count.get("count", 0) != 1:
            raise RuntimeError("Locator check failed")
        uncheck_res = client.rpc("locator.uncheck", {"tabId": tab_id, "label": "Agree Terms"})
        print(f"Uncheck result: {uncheck_res}")
        unchecked_count = client.rpc("locator.count", {"tabId": tab_id, "role": "checkbox", "name": "Agree Terms", "checked": False})
        if unchecked_count.get("count", 0) != 1:
            raise RuntimeError("Locator uncheck failed")

        # 5. Click the submit button
        print("\n5. Clicking submit button...")
        click_res = client.rpc("locator.click", {"tabId": tab_id, "role": "button", "name": "Submit Action"})
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
