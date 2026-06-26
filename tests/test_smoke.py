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
    upload_path = Path(__file__).resolve().parent / "smoke_upload.txt"
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
        client.rpc("page.executeJavaScript", {
            "tabId": tab_id,
            "script": "document.getElementById('same-origin-frame').scrollIntoView({block:'center', inline:'center'})"
        })
        time.sleep(0.5)
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
        try:
            client.rpc("locator.click", {"tabId": tab_id, "selector": "button", "index": 99, "timeoutMs": 250})
            raise RuntimeError("locator.click should have timed out with diagnostics")
        except BrowserBridgeError as error:
            diagnostic = (error.data or {}).get("diagnostic", {})
            if "LOCATOR_ACTIONABILITY_TIMEOUT" not in str(error.data) or not diagnostic.get("candidates"):
                raise RuntimeError(f"locator timeout diagnostics missing: {error} data={error.data}")
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

        # 4.5 New advanced Playwright-like APIs
        print("\n4.5 Testing advanced locator/page/download APIs...")
        first_res = client.rpc("locator.first", {"tabId": tab_id, "selector": "button", "hasText": "Submit"})
        print(f"Locator first result: {first_res}")
        nth_res = client.rpc("locator.nth", {"tabId": tab_id, "selector": "button", "nth": 1})
        print(f"Locator nth result: {nth_res}")
        text_list = client.rpc("locator.allInnerTexts", {"tabId": tab_id, "selector": "button", "limit": 10})
        if not any("Submit Action" in text for text in text_list.get("texts", [])):
            raise RuntimeError("locator.allInnerTexts failed")
        href_res = client.rpc("locator.getAttribute", {"tabId": tab_id, "selector": "a#download-link", "name": "download"})
        if href_res.get("value") != "browser-agent-bridge-smoke.txt":
            raise RuntimeError("locator.getAttribute failed")
        client.rpc("expect.locator.toHaveCount", {"tabId": tab_id, "selector": "body > button", "count": 7, "timeoutMs": 5000})
        client.rpc("expect.locator.toHaveText", {"tabId": tab_id, "locator": {"selector": "#screenshot-target"}, "expectedText": "Screenshot Target"})
        client.rpc("expect.locator.toHaveAttribute", {"tabId": tab_id, "locator": {"selector": "a#download-link"}, "attribute": "download", "expectedValue": "browser-agent-bridge-smoke.txt"})
        try:
            client.rpc("expect.locator.toHaveText", {"tabId": tab_id, "selector": "#screenshot-target", "expectedText": "Wrong Text", "timeoutMs": 250})
            raise RuntimeError("expect.locator.toHaveText should have timed out with diagnostics")
        except BrowserBridgeError as error:
            diagnostic = (error.data or {}).get("diagnostic", {})
            if (error.data or {}).get("code") != "LOCATOR_EXPECT_TIMEOUT" or diagnostic.get("assertion") != "toHaveText":
                raise RuntimeError(f"expect locator diagnostics missing: {error} data={error.data}")

        screenshot_res = client.rpc("locator.screenshot", {"tabId": tab_id, "selector": "#screenshot-target", "format": "png"})
        if not screenshot_res.get("dataUrl", "").startswith("data:image/png;base64,"):
            raise RuntimeError("locator.screenshot failed")

        upload_path.write_text("browser agent bridge upload smoke\n", encoding="utf-8")
        upload_res = client.rpc("locator.setInputFiles", {"tabId": tab_id, "label": "Upload Receipt", "files": [str(upload_path)]})
        print(f"Upload result: {upload_res}")
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "File Selected: smoke_upload.txt", "timeoutMs": 5000})

        client.rpc("locator.dispatchDragDrop", {
            "tabId": tab_id,
            "selector": "#drag-source",
            "targetSelector": "#drop-zone",
            "data": {"text/plain": "drag-smoke"}
        })
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "Dropped: drag-smoke", "timeoutMs": 5000})

        blocked_res = client.rpc("network.setBlockedUrls", {"tabId": tab_id, "urls": ["*google-analytics.com*"]})
        print(f"Blocked result: {blocked_res}")
        if not blocked_res.get("ok") or "*google-analytics.com*" not in blocked_res.get("urls", []):
            raise RuntimeError("network.setBlockedUrls failed")

        # Test network.setInterceptors
        intercept_res = client.rpc("network.setInterceptors", {
            "tabId": tab_id,
            "rules": [
                {
                    "id": "mock-user-post",
                    "urlRegex": "^https://my-mock-api\\.com/user$",
                    "method": "POST",
                    "postDataContains": "BridgeSmoke",
                    "headerContains": {"Content-Type": "text/plain"},
                    "times": 1,
                    "action": "mock",
                    "responseCode": 200,
                    "responseHeaders": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    },
                    "responseBody": '{"username": "bridge-smoke-user"}'
                }
            ]
        })
        print(f"Intercept result: {intercept_res}")
        if not intercept_res.get("ok") or intercept_res.get("rulesCount") != 1:
            raise RuntimeError("network.setInterceptors failed")
        intercept_status = client.rpc("network.interceptors.status", {"tabId": tab_id})
        if len(intercept_status.get("rules", [])) != 1:
            raise RuntimeError("network.interceptors.status failed")

        client.rpc("page.executeJavaScript", {
            "tabId": tab_id,
            "script": """
            fetch('https://my-mock-api.com/user', {
                method: 'POST',
                headers: {'Content-Type': 'text/plain'},
                body: 'operationName=BridgeSmoke'
            })
                .then(r => r.json())
                .then(data => {
                    document.getElementById('network-result').innerText = data.username;
                }).catch(err => {
                    document.getElementById('network-result').innerText = 'Mock Fail: ' + err.message;
                });
            """
        })
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "bridge-smoke-user", "timeoutMs": 5000})
        intercept_status = client.rpc("network.interceptors.status", {"tabId": tab_id})
        if intercept_status.get("rules") or not any(event.get("ruleId") == "mock-user-post" for event in intercept_status.get("events", [])):
            raise RuntimeError("network.interceptors.status did not record consumed mock rule")
        intercept_events = client.rpc("network.interceptors.events", {"tabId": tab_id, "limit": 5})
        if not any(event.get("ruleId") == "mock-user-post" for event in intercept_events.get("events", [])):
            raise RuntimeError("network.interceptors.events did not record consumed mock rule")
        clear_events = client.rpc("network.interceptors.clearEvents", {"tabId": tab_id})
        if not clear_events.get("ok"):
            raise RuntimeError("network.interceptors.clearEvents failed")
        if client.rpc("network.interceptors.events", {"tabId": tab_id}).get("events"):
            raise RuntimeError("network.interceptors.clearEvents did not clear events")

        clear_interceptors = client.rpc("network.interceptors.clear", {"tabId": tab_id})
        if not clear_interceptors.get("ok"):
            raise RuntimeError("network.interceptors.clear failed")
        cleared_status = client.rpc("network.interceptors.status", {"tabId": tab_id})
        if cleared_status.get("rules"):
            raise RuntimeError("network.interceptors.clear did not clear rules")

        block_intercept = client.rpc("network.setInterceptors", {
            "tabId": tab_id,
            "rules": [
                {
                    "id": "block-smoke",
                    "urlPattern": "*blocked-smoke.test*",
                    "action": "block",
                    "times": 1
                }
            ]
        })
        if not block_intercept.get("ok") or block_intercept.get("rulesCount") != 1:
            raise RuntimeError("network.setInterceptors block rule failed")
        client.rpc("page.executeJavaScript", {
            "tabId": tab_id,
            "script": """
            fetch('https://blocked-smoke.test/pixel')
                .then(() => {
                    document.getElementById('network-result').innerText = 'Block Fail';
                }).catch(() => {
                    document.getElementById('network-result').innerText = 'Blocked Done';
                });
            """
        })
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "Blocked Done", "timeoutMs": 5000})
        block_status = client.rpc("network.interceptors.status", {"tabId": tab_id})
        if not any(event.get("ruleId") == "block-smoke" for event in block_status.get("events", [])):
            raise RuntimeError("network.interceptors.status did not record block rule")
        block_events = client.rpc("network.interceptors.events", {"tabId": tab_id})
        if not any(event.get("ruleId") == "block-smoke" for event in block_events.get("events", [])):
            raise RuntimeError("network.interceptors.events did not record block rule")
        client.rpc("network.interceptors.clear", {"tabId": tab_id})

        client.rpc("page.executeJavaScript", {
            "tabId": tab_id,
            "script": "setTimeout(async () => { await fetch('data:application/json,%7B%22ok%22%3Atrue%7D'); document.getElementById('network-result').innerText = 'Network Done'; }, 250)"
        })
        client.rpc("page.waitForRequest", {"tabId": tab_id, "urlContains": "application/json", "timeoutMs": 5000})
        client.rpc("page.executeJavaScript", {
            "tabId": tab_id,
            "script": "setTimeout(async () => { await fetch('data:application/json,%7B%22ok%22%3Atrue%7D'); document.getElementById('network-result').innerText = 'Network Done'; }, 250)"
        })
        client.rpc("page.waitForResponse", {"tabId": tab_id, "urlContains": "application/json", "timeoutMs": 5000})
        client.rpc("page.waitForNetworkIdle", {"tabId": tab_id, "idleMs": 250, "timeoutMs": 5000})
        client.rpc("page.waitForText", {"tabId": tab_id, "text": "Network Done", "timeoutMs": 5000})

        client.rpc("page.executeJavaScript", {"tabId": tab_id, "script": "setTimeout(() => alert('Smoke Dialog'), 250)"})
        dialog_res = client.rpc("page.waitForDialog", {"tabId": tab_id, "messageContains": "Smoke", "timeoutMs": 5000})
        print(f"Dialog result: {dialog_res}")
        client.rpc("page.acceptDialog", {"tabId": tab_id})

        client.rpc("locator.click", {"tabId": tab_id, "selector": "#download-link"})
        download_res = client.rpc("downloads.waitFor", {
            "filenameContains": "browser-agent-bridge-smoke",
            "state": "complete",
            "includeExisting": True,
            "timeoutMs": 10000
        })
        print(f"Download result: {download_res}")

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
        upload_path.unlink(missing_ok=True)

if __name__ == "__main__":
    try:
        sys.exit(run_smoke_test())
    except Exception as e:
        print(f"Smoke Test Failed: {e}")
        sys.exit(1)
