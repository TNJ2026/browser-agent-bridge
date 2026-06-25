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
scripts/rpc.sh '{"jsonrpc":"2.0","id":"1","method":"session.start","params":{"url":"https://example.com"}}'
scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"2","method":"extension.info","params":{}}'
scripts/ws-rpc.js --listen
scripts/browser_bridge_client.py rpc session.get '{"sessionId":"SESSION_ID"}'
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
`runtime/site-patterns/*.md`. The side panel uses
this method to show reusable site knowledge below Settings after Bridge is
started.

```json
{}
```

### `trace.start`

Starts a lightweight debug trace. While active, each JSON-RPC call records
method, duration, status, selected params, compact result previews, and errors.
Text-like fields are redacted by default; pass `includeText:true` to keep them.

```json
{ "name": "debug checkout", "includeText": false, "maxEvents": 1000 }
```

### `trace.stop`

Stops the active trace, or a specific trace by `traceId`.

```json
{ "traceId": "uuid" }
```

### `trace.status`

Lists traces, or returns one trace summary when `traceId` is supplied.

```json
{}
```

### `trace.export`

Exports the active trace, or a specific trace by `traceId`. Pass
`download:true` to save it through Chrome downloads.

```json
{ "traceId": "uuid", "download": false }
```

### `trace.clear`

Clears one trace by `traceId`, or all traces when omitted.

```json
{}
```

### `tabs.list`

```json
{ "query": { "groupId": 1 } }
```

Lists tabs only inside an Agent-managed tab group. `query.groupId` is required.

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

Adds an existing Agent-managed tab to an Agent session group and records it in
the session. The tab must be in the same Chrome window as the session group.
Tabs outside Agent-managed groups are rejected.

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

### `page.frames`

Lists frames in a tab. Use a returned `frameId` with `page.*`, `dom.*`, and
`locator.*` methods to target same-origin or cross-origin frames. `frameUrl`
can also be passed to those methods to resolve the first matching frame URL.

```json
{ "tabId": 123 }
```

### `page.waitForSelector`

Polls for a CSS selector. Set `visible` to require a visible box. Use
`frameId`, `frameUrl`, or `frameSelector` to target a frame.

```json
{ "tabId": 123, "selector": "main button", "visible": true, "timeoutMs": 30000, "frameId": 7 }
```

### `page.waitForText`

Polls the whole page, or a selector subtree, for text. Use `frameId`,
`frameUrl`, or `frameSelector` to target a frame.

```json
{ "tabId": 123, "text": "Signed in", "selector": "main", "timeoutMs": 30000, "frameId": 7 }
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

Returns a bounded list of matching elements with text, value, visibility, and
viewport rect. Use `frameId`, `frameUrl`, or `frameSelector` to target a frame.
CSS selector matching pierces open shadow roots by default. Closed shadow roots
remain inaccessible to browser automation.

```json
{ "tabId": 123, "selector": "button, input, a", "limit": 50, "frameId": 7 }
```

### `dom.click`

Clicks one element by CSS selector and optional zero-based `index` using a
CDP mouse input path.
By default this auto-waits for the element to be visible, enabled, and have a
stable bounding box, and for the clickable point to receive pointer events
without being covered by another element. Use `timeoutMs` and `intervalMs` to
tune the wait, `strict:true` to require exactly one selector match,
`stable:false` to skip the bounding-box stability check, or `force:true` to
bypass actionability checks.

```json
{ "tabId": 123, "selector": "button[type=submit]", "index": 0, "timeoutMs": 30000, "frameSelector": "iframe[name=app]" }
```

### `dom.type`

Types into an input, textarea, or contenteditable element using CDP text input.
`replace` defaults to true.
By default this auto-waits for the element to be visible, enabled, editable,
and stable.

```json
{ "tabId": 123, "selector": "input[name=q]", "text": "browser bridge", "replace": true, "frameSelector": "iframe[name=app]" }
```

### `dom.select`

Sets a native `<select>` value and dispatches input/change events.
By default this auto-waits for the element to be visible, enabled, a native
select, and stable.

```json
{ "tabId": 123, "selector": "select[name=country]", "value": "US", "frameSelector": "iframe[name=app]" }
```

### `dom.hover`

Hovers over an element by CSS selector and optional zero-based `index` (dispatches `mouseover` and `mouseenter` events).
By default this auto-waits for the element to be visible, receive pointer
events, and be stable.

```json
{ "tabId": 123, "selector": "button[type=submit]", "index": 0, "frameSelector": "iframe[name=app]" }
```

`frameId` and `frameUrl` execute directly in the selected Chrome frame and can
target cross-origin frames when extension host permissions allow it.
`frameSelector` resolves an iframe element from the current DOM and is useful
for same-origin nested DOM traversal.

### `locator.count`

Finds elements using a Playwright-like locator shape. Locator fields can be
passed directly or under `locator`. Supported fields are `selector`, `text`,
`role`, `name`, `label`, `placeholder`, `exact`, `caseSensitive`, `visible`,
`includeHidden`, `checked`, `disabled`, `expanded`, `pressed`, `selected`,
`level`, `frameId`, `frameUrl`, and `frameSelector`. Role/name matching uses implicit HTML roles,
explicit ARIA roles, `aria-label`, `aria-labelledby`, associated labels,
heading levels, and common ARIA state filters. Locator matching pierces open
shadow roots by default. Closed shadow roots remain inaccessible.

```json
{ "tabId": 123, "role": "button", "name": "Submit", "visible": true }
```

```json
{ "tabId": 123, "role": "heading", "name": "Account", "level": 2 }
```

### `locator.textContent`

Returns the text of the matched element at `index` (default `0`).

```json
{ "tabId": 123, "text": "Order total", "index": 0 }
```

### `locator.waitFor`

Waits for a locator state: `attached`, `visible` (default), `hidden`, or
`detached`.

```json
{ "tabId": 123, "label": "Email", "state": "visible", "timeoutMs": 30000 }
```

### `locator.click`

Clicks the matched element at `index` (default `0`) using a CDP mouse input
path. By default this auto-waits for the element to be visible, enabled, have a
stable bounding box, and for the clickable point to receive pointer events
without being covered by another element. Use `timeoutMs` and `intervalMs` to
tune the wait, `strict:true` to require exactly one match, `stable:false` to
skip the bounding-box stability check, or `force:true` to bypass actionability
checks.

```json
{ "tabId": 123, "role": "button", "name": "Submit", "timeoutMs": 30000 }
```

### `locator.fill`

Fills an input, textarea, select-like value field, or contenteditable element.
By default this auto-waits for the element to be visible, enabled, editable,
and have a stable bounding box. Text fields and contenteditable elements are
focused and filled through CDP text input; native selects use value assignment
plus input/change events.
For flat params, `text` is the value to fill. To locate by text and fill a
different value, use the nested form.

```json
{ "tabId": 123, "label": "Search", "text": "browser bridge" }
```

```json
{ "tabId": 123, "locator": { "text": "Search" }, "value": "browser bridge" }
```

### `locator.check`

Checks a checkbox, switch, or radio-like element by locator. If already checked,
the call returns without clicking. The click path uses the same actionability
wait and CDP mouse input as `locator.click`.

```json
{ "tabId": 123, "role": "checkbox", "name": "Agree Terms" }
```

### `locator.uncheck`

Unchecks a checkbox or switch-like element by locator. Radios cannot be
unchecked.

```json
{ "tabId": 123, "role": "checkbox", "name": "Agree Terms" }
```

### `locator.selectOption`

Selects one or more native `<select>` options. Options can be matched by
`value`, `label`, or zero-based `index`. Use the nested `locator` form when the
select locator itself also needs a `label`.

```json
{ "tabId": 123, "locator": { "label": "Country" }, "option": { "label": "United States", "exact": true } }
```

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
