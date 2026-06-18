# Browser Agent Bridge Protocol

Endpoint:

```text
POST http://127.0.0.1:8765/rpc
GET  http://127.0.0.1:8765/health
GET  http://127.0.0.1:8765/events
WS   ws://127.0.0.1:8765/ws
```

Use `POST /rpc` for simple one-shot requests. Use `/ws` for long-running agent sessions; it accepts the same JSON-RPC request shape and streams notifications from the native host. After the WebSocket handshake, the bridge sends:

```json
{"jsonrpc":"2.0","method":"bridge.ready","params":{"extensionReady":true,"extensionVersion":"0.1.0"}}
```

Extension notifications are delivered as JSON-RPC notifications:

```json
{"jsonrpc":"2.0","method":"extension.ready","params":{"version":"0.1.0"}}
```

Helpers:

```bash
scripts/rpc.sh '{"jsonrpc":"2.0","id":"1","method":"tabs.list","params":{}}'
scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"2","method":"extension.info","params":{}}'
scripts/ws-rpc.js --listen
scripts/browser_bridge_client.py rpc tabs.list '{"query":{"active":true,"currentWindow":true}}'
scripts/doctor.py
```

The WebSocket helper writes newline-delimited JSON. Ignore notification lines when waiting for a response; match responses by `id`.

## Authentication

If the native host was started with `BROWSER_AGENT_BRIDGE_TOKEN`, these endpoints require a bearer token:

On macOS, `native/host-wrapper.macos.sh` sources `~/.browser-agent-bridge.env` before launching `native/host.py`, so use that file for persistent token auth.

```text
POST /rpc
GET  /events
WS   /ws
```

Use:

```text
Authorization: Bearer <token>
```

`GET /health` remains unauthenticated and reports `authRequired`. The bundled `scripts/rpc.sh` and `scripts/ws-rpc.js` helpers send this header automatically when `BROWSER_AGENT_BRIDGE_TOKEN` is set.

## Request Shape

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

## Methods

### `extension.info`

Returns extension metadata, native status, and method list.

```json
{"jsonrpc":"2.0","id":"info","method":"extension.info","params":{}}
```

### `extension.reload`

Schedules `chrome.runtime.reload()` after returning the JSON-RPC response. It only works after the loaded extension version exposes this method.

```json
{"jsonrpc":"2.0","id":"reload","method":"extension.reload","params":{}}
```

### `native.status`

Returns Native Messaging status from the extension.

```json
{"jsonrpc":"2.0","id":"native","method":"native.status","params":{}}
```

### `native.saveDataUrl`

Native-host local method. Saves a data URL to disk and returns the file path. Useful with `page.screenshot`.

```json
{"jsonrpc":"2.0","id":"save","method":"native.saveDataUrl","params":{"dataUrl":"data:image/png;base64,...","filename":"page.png","directory":"~/Downloads/browser-agent-bridge"}}
```

### `tabs.list`

Parameters:

```json
{"query":{"active":true,"currentWindow":true}}
```

Chrome `tabs.query` options are passed through.

### `tabs.create`

```json
{"url":"https://example.com","active":true}
```

### `tabs.activate`

```json
{"tabId":123}
```

### `tabs.close`

```json
{"tabId":123}
```

or:

```json
{"tabIds":[123,124]}
```

### `tabs.group`

Adds tab(s) to a tab group. If `groupId` is not provided, a new group is created.

```json
{"tabIds":[123,124],"groupId":1,"title":"Agent","color":"cyan"}
```

### `session.start`

Creates a managed tab group and records session metadata in extension storage.

```json
{"name":"Agent Task","url":"https://example.com","active":true,"color":"cyan"}
```

### `session.list`

```json
{}
```

### `session.get`

```json
{"sessionId":"uuid"}
```

### `session.stop`

Ungroups tabs unless `closeTabs` is true.

```json
{"sessionId":"uuid","closeTabs":false}
```

### `page.navigate`

```json
{"tabId":123,"url":"https://example.com","wait":true,"timeoutMs":30000}
```

### `page.waitForLoad`

Waits until Chrome reports the tab load status as complete.

```json
{"tabId":123,"timeoutMs":30000}
```

### `page.waitForSelector`

Polls for a CSS selector. Set `visible` to require a visible box. Use `frameSelector` for a same-origin iframe.

```json
{"tabId":123,"selector":"main button","visible":true,"timeoutMs":30000,"frameSelector":"iframe[name=app]"}
```

### `page.waitForText`

Polls the whole page, or a selector subtree, for text. Use `frameSelector` for a same-origin iframe.

```json
{"tabId":123,"text":"Signed in","selector":"main","timeoutMs":30000,"frameSelector":"iframe[name=app]"}
```

### `page.readText`

Returns `url`, `title`, `text`, and current selection.

```json
{"tabId":123}
```

### `page.accessibilityTree`

Returns simplified interactable/accessibility nodes.

```json
{"tabId":123,"maxNodes":1000}
```

### `page.screenshot`

Focuses the tab/window and captures the visible tab.

```json
{"tabId":123,"format":"png"}
```

For JPEG:

```json
{"tabId":123,"format":"jpeg","quality":75}
```

To save a screenshot to disk, pass the returned `dataUrl` to `native.saveDataUrl`.

### `page.executeJavaScript`

Runs script in the page. Use sparingly.

```json
{"tabId":123,"script":"document.title","world":"MAIN"}
```

Use `"world":"isolated"` to run in the isolated extension world.

### `page.domSnapshot`

Uses CDP `DOMSnapshot.captureSnapshot`.

```json
{"tabId":123,"computedStyles":[],"includeDOMRects":true}
```

### `dom.query`

Returns matching elements with text, value, visibility, and viewport rect. Use `frameSelector` for a same-origin iframe.

```json
{"tabId":123,"selector":"button, input, a","limit":50,"frameSelector":"iframe[name=app]"}
```

### `dom.click`

Clicks one element by CSS selector and optional zero-based `index`.

```json
{"tabId":123,"selector":"button[type=submit]","index":0,"frameSelector":"iframe[name=app]"}
```

### `dom.type`

Types into an input, textarea, or contenteditable element. `replace` defaults to true.

```json
{"tabId":123,"selector":"input[name=q]","text":"browser bridge","replace":true,"frameSelector":"iframe[name=app]"}
```

### `dom.select`

Sets a native `<select>` value and dispatches input/change events.

```json
{"tabId":123,"selector":"select[name=country]","value":"US","frameSelector":"iframe[name=app]"}
```

`frameSelector` requires a same-origin iframe. Cross-origin frames are blocked by the browser and return an explicit accessibility error.

### `computer.click`

Coordinates are CSS viewport coordinates.

```json
{"tabId":123,"x":300,"y":240,"button":"left","clickCount":1}
```

### `computer.drag`

```json
{"tabId":123,"fromX":100,"fromY":100,"toX":400,"toY":300,"steps":12}
```

### `computer.type`

Inserts text through CDP.

```json
{"tabId":123,"text":"hello"}
```

### `computer.key`

Dispatches one key.

```json
{"tabId":123,"key":"Enter"}
```

### `computer.scroll`

Dispatches a wheel event.

```json
{"tabId":123,"x":400,"y":400,"deltaX":0,"deltaY":600}
```

### `console.read`

Attaches debugger, enables Runtime events, and returns buffered console events.

```json
{"tabId":123,"limit":100}
```

### `network.read`

Attaches debugger, enables Network events, and returns buffered network events.

```json
{"tabId":123,"limit":100}
```

### `downloads.list`

```json
{"limit":50,"query":"report"}
```

### `recording.start`

Starts recording browser actions for a tab or group. Screenshots are off by default.
Recordings are persisted in Chrome local extension storage until cleared.

```json
{"tabId":123,"name":"Checkout flow","captureScreenshots":false}
```

or:

```json
{"groupId":5,"name":"Research flow","captureScreenshots":true}
```

### `recording.stop`

```json
{"recordingId":"uuid"}
```

### `recording.status`

```json
{}
```

or:

```json
{"recordingId":"uuid"}
```

### `recording.export`

Return JSON payload:

```json
{"recordingId":"uuid"}
```

Download JSON through Chrome:

```json
{"recordingId":"uuid","download":true,"filename":"flow.json"}
```

### `recording.clear`

```json
{"recordingId":"uuid"}
```

or clear all in-memory recordings:

```json
{}
```

### `indicator.set`

Shows or hides the page visual indicator.

```json
{"tabId":123,"visible":true,"x":300,"y":240,"label":"agent"}
```

Hide:

```json
{"tabId":123,"visible":false}
```

### `policy.get`

Returns URL policy. Default blocked patterns include `chrome://*`, `chrome-extension://*`, and `chromewebstore.google.com/*`.

```json
{}
```

### `policy.set`

URL and method patterns use `*` wildcards. Method patterns match JSON-RPC method names.

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
{"url":"https://example.com","method":"dom.click"}
```

### `history.search`

Exposed by the native host to search the local browser (Chrome and Edge) history database.

Parameters:

```json
{"query":"github","limit":20,"since":"7d","browser":"chrome"}
```

* `query` (string, optional): Keywords to search, space-separated.
* `limit` (int, optional): Max results, defaults to 20.
* `since` (string or number, optional): Time window (e.g., "1d", "7h", "30m", or seconds).
* `browser` (string, optional): "chrome" or "edge" to filter.

### `bookmarks.search`

Exposed by the native host to search the local browser (Chrome and Edge) bookmarks.

Parameters:

```json
{"query":"github","browser":"chrome"}
```

* `query` (string, optional): Keywords to search, space-separated.
* `browser` (string, optional): "chrome" or "edge" to filter.
