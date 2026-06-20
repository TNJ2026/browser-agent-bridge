# JSON-RPC Protocol

Requests sent to `POST http://127.0.0.1:8765/rpc` are forwarded to the Chrome extension. Agents can also connect to `ws://127.0.0.1:8765/ws` for the same JSON-RPC request/response protocol plus streamed extension notifications.

The local HTTP/WebSocket bridge is available only while the user has clicked Start Bridge in the extension side panel. Stop Bridge disconnects the Native Messaging host and pauses automatic reconnects.

## Endpoints

```text
POST http://127.0.0.1:8765/rpc
GET  http://127.0.0.1:8765/health
GET  http://127.0.0.1:8765/events
WS   ws://127.0.0.1:8765/ws
```

`/ws` sends a `bridge.ready` notification after the handshake. Native extension notifications are delivered as JSON-RPC notifications with `method` and `params`.

The repo includes two helper scripts:

```bash
scripts/rpc.sh '{"jsonrpc":"2.0","id":"1","method":"tabs.list","params":{}}'
scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"2","method":"extension.info","params":{}}'
scripts/ws-rpc.js --listen
scripts/browser_bridge_client.py rpc tabs.list '{"query":{"active":true,"currentWindow":true}}'
scripts/doctor.py
```

`scripts/ws-rpc.js` prints one JSON message per line. Notifications do not have `id`; request responses have the matching `id`.

## Authentication

Authentication is required by default. Start the native host with `BROWSER_AGENT_BRIDGE_TOKEN`; otherwise `/rpc`, `/events`, and `/ws` reject requests. For local debugging only, `BROWSER_AGENT_BRIDGE_ALLOW_NO_AUTH=1` explicitly disables this requirement.

On macOS, `native/host-wrapper.macos.sh` loads `~/.browser-agent-bridge.env` before starting the host. Put `BROWSER_AGENT_BRIDGE_TOKEN=...` there when Chrome launches the native host.
The installer also pins `BROWSER_AGENT_BRIDGE_EXTENSION_ID` in the wrapper so local HTTP/WebSocket requests from other Chrome extensions are rejected.

These endpoints require a bearer token by default:

```text
POST /rpc
GET  /events
WS   /ws
```

Header:

```text
Authorization: Bearer <token>
```

`GET /health` does not require auth and includes `authRequired`, `authConfigured`, and `allowNoAuth`.

## Request

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "page.readText",
  "params": {
    "tabId": 123
  }
}
```

## Response

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "url": "https://example.com",
    "title": "Example Domain",
    "text": "..."
  }
}
```

Errors use standard JSON-RPC shape:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "error": {
    "code": -32000,
    "message": "Tab 123 not found"
  }
}
```

## Method Sketch

### `extension.info`

Returns extension metadata, native status, and tool list.

```json
{}
```

### `extension.reload`

Schedules `chrome.runtime.reload()` after returning the JSON-RPC response. Useful after the extension has loaded a version that supports this method.

```json
{}
```

### `extension.getCspBypass`

Gets whether temporary per-origin Content Security Policy (CSP) bypass is enabled, and whether a temporary dynamic rule is currently active.

```json
{}
```

This defaults to enabled for new installs. The user can enable or disable it in the side panel. When enabled, `tabs.create`, `session.start`, `page.navigate`, and `page.executeJavaScript` may temporarily strip CSP response headers for the target origin. Pass `"bypassCSP": false` on a call to opt out. Pass `"cspBypassTtlMs"` to request a TTL between 10 seconds and 10 minutes; the default is 3 minutes.

### `native.saveDataUrl`

Native-host local method. Saves a data URL to disk and returns the file path. This is useful with `page.screenshot`.
By default, files are written under `BROWSER_AGENT_BRIDGE_SAVE_DIR` or `~/Downloads/browser-agent-bridge`.
The `directory` parameter is accepted only when the native host is started with `BROWSER_AGENT_BRIDGE_ALLOW_CUSTOM_SAVE_DIR=1`.

```json
{
  "dataUrl": "data:image/png;base64,...",
  "filename": "page.png"
}
```

### `native.sitePatterns`

Native-host local method. Lists Agent-maintained site summaries from
`skills/browser-agent-bridge/references/site-patterns/*.md`. The side panel uses
this method to show reusable site knowledge below Settings after Bridge is
started.

```json
{}
```

### `tabs.list`

```json
{ "query": { "active": true, "currentWindow": true } }
```

### `tabs.create`

```json
{ "url": "https://example.com", "active": true }
```

### `session.start`

Creates a managed Chrome tab group and main tab.

```json
{ "name": "Agent Task", "url": "https://example.com", "active": true, "color": "cyan" }
```

### `session.list`

```json
{}
```

### `session.get`

```json
{ "sessionId": "uuid" }
```

### `session.createTab`

Creates a new tab inside an existing Agent session group and records it in the session. The tab is created in the session group's window.

```json
{ "sessionId": "uuid", "url": "https://example.com", "active": true }
```

### `session.addTab`

Adds an existing tab to an Agent session group and records it in the session. The tab must be in the same Chrome window as the session group.

```json
{ "sessionId": "uuid", "tabId": 123 }
```

### `session.closeTab`

Closes one tab from an Agent session and removes it from the session metadata.

```json
{ "sessionId": "uuid", "tabId": 123 }
```

### `session.stop`

Ungroups tabs by default. Set `closeTabs` to close managed tabs.

```json
{ "sessionId": "uuid", "closeTabs": false }
```

### `page.navigate`

```json
{ "tabId": 123, "url": "https://example.com", "wait": true }
```

### `page.waitForLoad`

Waits until Chrome reports the tab load status as complete.

```json
{ "tabId": 123, "timeoutMs": 30000 }
```

### `page.waitForSelector`

Polls for a CSS selector. Set `visible` to require a visible box. Use `frameSelector` for a same-origin iframe.

```json
{ "tabId": 123, "selector": "main button", "visible": true, "timeoutMs": 30000, "frameSelector": "iframe[name=app]" }
```

### `page.waitForText`

Polls the whole page, or a selector subtree, for text. Use `frameSelector` for a same-origin iframe.

```json
{ "tabId": 123, "text": "Signed in", "selector": "main", "timeoutMs": 30000, "frameSelector": "iframe[name=app]" }
```

### `page.executeJavaScript`

```json
{ "tabId": 123, "script": "document.title", "world": "MAIN", "cspBypassTtlMs": 60000 }
```

### `page.domSnapshot`

Uses CDP `DOMSnapshot.captureSnapshot`.

```json
{ "tabId": 123, "computedStyles": [], "includeDOMRects": true }
```

### `page.screenshot`

Captures the visible tab and returns a `dataUrl`.

```json
{ "tabId": 123, "format": "png" }
```

To save a screenshot to disk, pass the returned `dataUrl` to `native.saveDataUrl`.

### `dom.query`

Returns a bounded list of matching elements with text, value, visibility, and viewport rect. Use `frameSelector` for a same-origin iframe.

```json
{ "tabId": 123, "selector": "button, input, a", "limit": 50, "frameSelector": "iframe[name=app]" }
```

### `dom.click`

Clicks one element by CSS selector and optional zero-based `index`.

```json
{ "tabId": 123, "selector": "button[type=submit]", "index": 0, "frameSelector": "iframe[name=app]" }
```

### `dom.type`

Types into an input, textarea, or contenteditable element. `replace` defaults to true.

```json
{ "tabId": 123, "selector": "input[name=q]", "text": "browser bridge", "replace": true, "frameSelector": "iframe[name=app]" }
```

### `dom.select`

Sets a native `<select>` value and dispatches input/change events.

```json
{ "tabId": 123, "selector": "select[name=country]", "value": "US", "frameSelector": "iframe[name=app]" }
```

### `dom.hover`

Hovers over an element by CSS selector and optional zero-based `index` (dispatches `mouseover` and `mouseenter` events).

```json
{ "tabId": 123, "selector": "button[type=submit]", "index": 0, "frameSelector": "iframe[name=app]" }
```

`frameSelector` requires a same-origin iframe. Cross-origin frames are blocked by the browser and return an explicit accessibility error.

### `computer.click`

Coordinates are CSS viewport coordinates.

```json
{ "tabId": 123, "x": 300, "y": 240, "button": "left" }
```

`computer.click`, `computer.drag`, and `computer.hover` do not show the page visual indicator by default. Pass `"showIndicator": true` to show the dot/label for a specific call, and optionally pass `"indicatorLabel"`.

### `computer.drag`

```json
{ "tabId": 123, "fromX": 100, "fromY": 100, "toX": 400, "toY": 300, "steps": 12 }
```

### `computer.type`

```json
{ "tabId": 123, "text": "hello" }
```

### `computer.scroll`

```json
{ "tabId": 123, "x": 400, "y": 400, "deltaY": 600 }
```

### `computer.key`

Dispatches one key or combination shortcut (e.g. "Enter", "Control+a", "Meta+c").

```json
{ "tabId": 123, "key": "Control+a" }
```

### `computer.hover`

Moves the mouse cursor to specific CSS viewport coordinates.

```json
{ "tabId": 123, "x": 300, "y": 240 }
```

### `downloads.list`

```json
{ "limit": 50, "query": "report" }
```

### `recording.start`

Starts recording browser actions for a tab or group. Screenshots are off by default because they can make exports large.
Recordings are stored in Chrome local extension storage with privacy defaults: 24-hour retention, 500 actions per recording, screenshots off by default, and typed text/value fields redacted unless `includeText` is true.

```json
{ "tabId": 123, "name": "Checkout flow", "captureScreenshots": false, "includeText": false, "retentionMs": 86400000, "maxActions": 500 }
```

or:

```json
{ "groupId": 5, "name": "Research flow", "captureScreenshots": true }
```

### `recording.stop`

```json
{ "recordingId": "uuid" }
```

### `recording.status`

```json
{}
```

or:

```json
{ "recordingId": "uuid" }
```

### `recording.export`

Return JSON payload:

```json
{ "recordingId": "uuid" }
```

Download JSON through Chrome:

```json
{ "recordingId": "uuid", "download": true, "filename": "flow.json" }
```

### `recording.clear`

```json
{ "recordingId": "uuid" }
```

or clear all in-memory recordings:

```json
{}
```

### `policy.get`

Returns URL policy. Defaults block Chrome privileged pages and Chrome Web Store.

```json
{}
```

### `policy.set`

URL and method patterns use `*` wildcards. Method patterns match JSON-RPC method names.
This method changes the local security policy and requires runtime approval when approval is enabled.

```json
{
  "blockedUrlPatterns": ["chrome://*", "chrome-extension://*", "https://bank.example/*"],
  "allowedUrlPatterns": ["https://example.com/safe/*"],
  "blockedMethods": ["page.executeJavaScript", "computer.*"],
  "allowedMethods": []
}
```

### `policy.checkUrl`

```json
{ "url": "https://example.com", "method": "dom.click" }
```
