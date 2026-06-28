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
scripts/rpc.sh '{"jsonrpc":"2.0","id":"1","method":"session.start","params":{"url":"https://example.com"}}'
scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"2","method":"extension.info","params":{}}'
scripts/ws-rpc.js --listen
scripts/browser_bridge_client.py rpc session.get '{"sessionId":"SESSION_ID"}'
scripts/doctor.py
```

The WebSocket helper writes newline-delimited JSON. Ignore notification lines when waiting for a response; match responses by `id`.

## Authentication

Authentication is required by default. Start the native host with `BROWSER_AGENT_BRIDGE_TOKEN`; otherwise `/rpc`, `/events`, and `/ws` reject requests. For local debugging only, `BROWSER_AGENT_BRIDGE_ALLOW_NO_AUTH=1` explicitly disables this requirement.

On macOS, `native/host-wrapper.macos.sh` sources `~/.browser-agent-bridge.env` before launching `native/host.py`, so use that file for persistent token auth.
The installer also pins `BROWSER_AGENT_BRIDGE_EXTENSION_ID` in the wrapper so local HTTP/WebSocket requests from other Chrome extensions are rejected.

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

## Action Observer (State Diffing)

Mutating and navigation operations (such as `locator.click`, `locator.fill`, `dom.click`, `page.navigate`, `page.reload`, etc.) capture the state of the tab before and after the action. A compact description of what changed is appended to the JSON-RPC response in a `whatChanged` property. This lets agents skip taking a full snapshot after every action, reducing round-trip latency.

By default the observer is **lightweight**: URL changes, new popups, and a cheap focused-element delta only. Pass `"a11yDiff": true` (or `"observe": "full"`) to also include the accessibility-tree structural diff (costs a full before/after tree capture). Pass `"observe": false` to skip the observer entirely.

The `whatChanged` object has the following optional properties:

- **`urlChanged`**: `true` if the tab URL changed.
  - **`fromUrl`**: The original URL.
  - **`toUrl`**: The new URL.
- **`newPopups`**: An array of newly created tab objects `{ tabId, url, title }` detected during the action.
- **`focusChanged`**: `true` if the active element changed.
  - **`focusedElement`**: `{ ref, tag, role, name }` describing the newly focused element, or `null`.
- **`a11yDiff`**: A structural difference of the interactive/text elements in the accessibility tree:
  - **`added`**: Array of newly appeared nodes `{ tag, role, name, text, value }`.
  - **`removed`**: Array of disappeared nodes `{ tag, role, name, text }`.
  - **`changed`**: Array of nodes whose value changed `{ tag, role, name, fromValue, toValue }`.

Example:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "ok": true,
    "element": { "ref": "ref_1" },
    "whatChanged": {
      "focusChanged": true,
      "focusedElement": { "ref": "ref_2", "tag": "input", "role": "textbox", "name": "Email" },
      "a11yDiff": {
        "changed": [
          { "tag": "input", "role": "checkbox", "name": "Subscribe", "fromValue": "false", "toValue": "true" }
        ]
      }
    }
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

### `extension.getCspBypass`

Gets whether temporary per-origin Content Security Policy (CSP) bypass is enabled, and whether a temporary dynamic rule is currently active.

```json
{"jsonrpc":"2.0","id":"get-csp","method":"extension.getCspBypass","params":{}}
```

This defaults to enabled for new installs. The user can enable or disable it in the side panel. When enabled, `tabs.create`, `session.start`, `page.navigate`, and `page.executeJavaScript` may temporarily strip CSP response headers for the target origin. Pass `"bypassCSP": false` on a call to opt out. Pass `"cspBypassTtlMs"` to request a TTL between 10 seconds and 10 minutes; the default is 3 minutes.

### `native.status`

Returns Native Messaging status from the extension.

```json
{"jsonrpc":"2.0","id":"native","method":"native.status","params":{}}
```

### `native.saveDataUrl`

Native-host local method. Saves a data URL to disk and returns the file path. Useful with `page.screenshot`.
By default, files are written under `BROWSER_AGENT_BRIDGE_SAVE_DIR` or `~/Downloads/browser-agent-bridge`.
The `directory` parameter requires the native host to start with `BROWSER_AGENT_BRIDGE_ALLOW_CUSTOM_SAVE_DIR=1`.

```json
{"jsonrpc":"2.0","id":"save","method":"native.saveDataUrl","params":{"dataUrl":"data:image/png;base64,...","filename":"page.png"}}
```

### `native.sitePatterns`

Native-host local method. Lists Agent-maintained site summaries from
`skills/browser-agent-bridge/references/site-patterns/*.md`. The side panel uses
this method to show reusable site knowledge below Settings after Bridge is
started.

```json
{"jsonrpc":"2.0","id":"patterns","method":"native.sitePatterns","params":{}}
```

### `tabs.list`

Parameters:

```json
{"query":{"groupId":1}}
```

Lists tabs only inside an Agent-managed tab group. `query.groupId` is required
and must refer to an Agent-managed group. Other Chrome `tabs.query` options may
be included, but unscoped tab listing is rejected.

### `tabs.create`

```json
{"url":"https://example.com","active":true}
```

### `tabs.activate`

```json
{"tabId":123}
```

The tab must already be in an Agent-managed tab group.

### `tabs.close`

```json
{"tabId":123}
```

or:

```json
{"tabIds":[123,124]}
```

All target tabs must already be in Agent-managed tab groups.

### `tabs.group`

Groups tabs that are already Agent-managed. If `groupId` is provided, that group
must also already be Agent-managed. If `groupId` is not provided, a new
Agent-managed group is created.

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

### `session.createTab`

Creates a new tab inside an existing Agent session group and records it in the session. The tab is created in the session group's window.

```json
{"sessionId":"uuid","url":"https://example.com","active":true}
```

### `session.addTab`

Adds an existing Agent-managed tab to an Agent session group and records it in
the session. The tab must be in the same Chrome window as the session group.
Tabs outside Agent-managed groups are rejected.

```json
{"sessionId":"uuid","tabId":123}
```

### `session.closeTab`

Closes one tab from an Agent session and removes it from the session metadata.

```json
{"sessionId":"uuid","tabId":123}
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

### `page.waitForPopup`

Waits for a popup opened by the target tab (matched by `openerTabId`). Optional `url`, `urlContains`, or `urlRegex` filter the popup target. Call it before the action that opens the popup; a short lookback (default `popupLookbackMs` 3000, max 10000; `0` to disable) also catches a popup opened just before the call. The popup is moved into the opener's Agent-managed group so it can be driven; pass `"adopt":false` to leave it ungrouped. On timeout the error includes `data.code:"PAGE_WAIT_FOR_POPUP_TIMEOUT"`.

```json
{"tabId":123,"urlContains":"login-success","timeoutMs":30000}
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

### `page.pdf`

Prints the page to a PDF via CDP `Page.printToPDF` and returns a `data:application/pdf` URL. Pass the returned `dataUrl` to `native.saveDataUrl` (with a `.pdf` filename) to save it.

```json
{"tabId":123,"landscape":false,"printBackground":true}
```

### `page.executeJavaScript`

Runs script in the page. Use sparingly.

```json
{"tabId":123,"script":"document.title","world":"MAIN","cspBypassTtlMs":180000}
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

### `dom.hover`

Hovers over an element by CSS selector and optional zero-based `index` (dispatches `mouseover` and `mouseenter` events).

```json
{"tabId":123,"selector":"button[type=submit]","index":0,"frameSelector":"iframe[name=app]"}
```

`frameSelector` requires a same-origin iframe. Cross-origin frames are blocked by the browser and return an explicit accessibility error.

### `dom.scroll`

Scrolls a specific element or the entire page/window.

* `tabId` (number, required)
* `selector` (string, optional): Selector of the element to scroll. If omitted, the main page/window is scrolled.
* `index` (number, optional): Zero-based index of the matching selector, defaults to 0.
* `x` (number, optional): Horizontal scroll position/offset (pixels), defaults to 0.
* `y` (number, optional): Vertical scroll position/offset (pixels), defaults to 0.
* `mode` (string, optional): `'scrollBy'` (scroll relative to current position) or `'scrollTo'` (scroll to absolute position). Defaults to `'scrollBy'`.
* `behavior` (string, optional): `'auto'` or `'smooth'`. Defaults to `'auto'`.
* `frameSelector` (string, optional): Selector of a same-origin iframe.

```json
{"tabId":123,"selector":"div.scrollable-list","x":0,"y":300,"mode":"scrollBy","behavior":"auto"}
```

### `locator.count`

Finds elements using a Playwright-like locator shape. Locator fields can be
passed directly or under `locator`. Supported fields are `selector`, `text`,
`role`, `name`, `label`, `placeholder`, `exact`, `caseSensitive`, `visible`,
`frameSelector`, and `within`. `within` takes a nested locator (same fields, may
itself nest `within`) and scopes the match to descendants of the parent
locator's matches — Playwright's `page.locator(parent).locator(child)`.

```json
{"tabId":123,"role":"button","name":"Submit","visible":true}
```

```json
{"tabId":123,"role":"button","name":"Save","within":{"selector":".card","hasText":"Billing"}}
```

### `locator.textContent`

Returns the text of the matched element at `index` (default `0`).

```json
{"tabId":123,"text":"Order total","index":0}
```

### `locator.waitFor`

Waits for a locator state: `attached`, `visible` (default), `hidden`, or
`detached`.

```json
{"tabId":123,"label":"Email","state":"visible","timeoutMs":30000}
```

### `locator.click`

Clicks the matched element at `index` (default `0`). By default this auto-waits
for the element to be visible, enabled, and have a stable bounding box. Use
`timeoutMs` and `intervalMs` to tune the wait, `strict:true` to require exactly
one match, `stable:false` to skip the bounding-box stability check, or
`force:true` to bypass actionability checks.

```json
{"tabId":123,"role":"button","name":"Submit","timeoutMs":30000}
```

### `locator.fill`

Fills an input, textarea, select-like value field, or contenteditable element.
By default this auto-waits for the element to be visible, enabled, editable,
and have a stable bounding box.
For flat params, `text` is the value to fill. To locate by text and fill a
different value, use the nested form.

```json
{"tabId":123,"label":"Search","text":"browser bridge"}
```

```json
{"tabId":123,"locator":{"text":"Search"},"value":"browser bridge"}
```

### `computer.click`

Coordinates are CSS viewport coordinates.

```json
{"tabId":123,"x":300,"y":240,"button":"left","clickCount":1}
```

`computer.click`, `computer.drag`, and `computer.hover` do not show the page visual indicator by default. Pass `"showIndicator": true` to show the dot/label for a specific call, and optionally pass `"indicatorLabel"`.

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

For combination shortcut keys (e.g. Copy/Paste/Select All), modifiers can be prepended with a `+`:

```json
{"tabId":123,"key":"Control+a"}
```

### `computer.scroll`

Dispatches a wheel event.

```json
{"tabId":123,"x":400,"y":400,"deltaX":0,"deltaY":600}
```

### `computer.hover`

Moves the mouse cursor to specific CSS viewport coordinates.

```json
{"tabId":123,"x":300,"y":240}
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
Recordings are persisted in Chrome local extension storage with privacy defaults: 24-hour retention, 500 actions per recording, screenshots off by default, and typed text/value fields redacted unless `includeText` is true.

```json
{"tabId":123,"name":"Checkout flow","captureScreenshots":false,"includeText":false,"retentionMs":86400000,"maxActions":500}
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

Returns URL policy. Default blocked patterns include `chrome://*`, `chrome-extension://*`, and `*://chromewebstore.google.com/*`.

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
{"url":"https://example.com","method":"dom.click"}
```
