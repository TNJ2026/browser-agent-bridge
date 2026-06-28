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

By default a connection receives every notification. To receive only events scoped to specific tabs, send a host-local control message `bridge.subscribe` with `params.tabIds` (an array of tab ids). Tab-scoped events (those with a `params.source.tabId` or `params.tabId`) are then delivered only for those tabs; events with no tab id (such as `extension.ready`) always go to every connection. Send `bridge.subscribe` with `tabIds: null`, or `bridge.unsubscribe`, to receive all events again. These control messages are handled by the native host and are not forwarded to the extension.

High-volume CDP notifications (`cdp.event`) are forwarded by the extension only while a WebSocket client is connected. If all connected clients use tab-scoped subscriptions, the extension forwards CDP events only for the union of those tab ids. `/events` therefore records CDP events only when there is an active WebSocket subscriber for them.

```bash
scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"sub","method":"bridge.subscribe","params":{"tabIds":[123]}}'
```

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

## Action Observer (State Diffing)

Mutating and navigation operations (such as `locator.click`, `locator.fill`, `dom.click`, `page.navigate`, `page.reload`, etc.) capture the state of the tab before and after the action. A compact description of what changed is appended to the JSON-RPC response in a `whatChanged` property. This lets agents skip taking a full snapshot after every action, reducing round-trip latency.

By default the observer is **lightweight**: it reports URL changes, new popups, and a cheap focused-element delta only. Pass `"a11yDiff": true` (or `"observe": "full"`) to also include the accessibility-tree structural diff, which costs a full before/after tree capture. Pass `"observe": false` to skip the observer entirely (no `whatChanged` in the response).

The `whatChanged` object has the following optional properties:

- **`urlChanged`**: `true` if the tab URL changed.
  - **`fromUrl`**: The original URL.
  - **`toUrl`**: The new URL.
- **`newPopups`**: An array of newly created tab objects `{ tabId, url, title }` detected during the action.
- **`focusChanged`**: `true` if the active element changed.
  - **`focusedElement`**: `{ ref, tag, role, name }` describing the newly focused element, or `null`.
- **`a11yDiff`** (only when `a11yDiff: true`): A structural difference of the interactive/text elements in the accessibility tree:
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
Network interceptor hits (mock/redirect/block/modifyHeaders) are also recorded
as `interceptor` events so the timeline shows which requests were rerouted.
Text-like fields are redacted by default; pass `includeText:true` to keep them.

When a traced call fails on a tab, a lightweight page snapshot is attached to
the error event as `context` (target `url`, `title`, accessibility element
counts, and a visible-text preview). The text preview follows the same
redaction as `includeText`; `url`, `title`, and counts are always kept. Pass
`includeContext:false` to disable capture.

```json
{ "name": "debug checkout", "includeText": false, "includeContext": true, "maxEvents": 1000 }
```

### `trace.stop`

Stops the active trace, or a specific trace by `traceId`.

```json
{ "traceId": "uuid" }
```

### `trace.status`

Lists traces, or returns one trace summary when `traceId` is supplied. Each
summary includes `eventCount` and `errorCount` so a failing trace is
identifiable without exporting it.

```json
{}
```

### `trace.export`

Exports the active trace, or a specific trace by `traceId`. Pass
`download:true` to save it through Chrome downloads. Each error event carries
`error` (message) plus `errorData` with the structured `code` and `diagnostic`
of waits/locator/network failures, so the trace is a self-contained failure
postmortem.

```json
{ "traceId": "uuid", "download": false }
```

### `trace.exportHtml`

Exports the active trace, or a specific trace by `traceId`, as a standalone
HTML timeline. Pass `download:true` to save it through Chrome downloads. When a
trace has errors the HTML opens with a Failures section listing each failing
method and its error `code`, and every error event shows its structured
`errorData` diagnostic inline.

```json
{ "traceId": "uuid", "download": true, "filename": "trace.html" }
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

Ungroups tabs by default. Set `closeTabs` to close managed tabs. When tabs stay
open, their CDP debugger is detached so the "DevTools is debugging this browser"
banner clears. Clicking Stop Bridge detaches every attached tab for the same
reason.

```json
{ "sessionId": "uuid", "closeTabs": false }
```

### `page.navigate`

```json
{ "tabId": 123, "url": "https://example.com", "wait": true }
```

### `page.reload` / `page.goBack` / `page.goForward`

History navigation for a tab via the Chrome tabs API. `page.reload` accepts
`bypassCache`. All wait for the tab to finish loading unless `wait:false`, and
return the updated tab. `goBack`/`goForward` error if there is no entry in that
direction.

```json
{ "tabId": 123, "bypassCache": false }
```

Waits until Chrome reports the tab load status as complete.

```json
{ "tabId": 123, "timeoutMs": 30000 }
```

### `page.waitForNavigation`

Waits for a tab URL change, optionally matching the destination URL. Set
`waitUntil` to `commit` to return as soon as the URL changes, or omit it to
wait until Chrome reports the tab load status as complete.

```json
{ "tabId": 123, "urlContains": "/dashboard", "waitUntil": "load", "timeoutMs": 30000 }
```

URL filters can be `url` for exact match, `urlContains`, or `urlRegex`.
On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_NAVIGATION_TIMEOUT"` and `data.diagnostic` with
`currentUrl`, `urlChanged`, `waitUntil`, and `elapsedMs`.

### `page.waitForURL`

Polls the active tab URL until it matches `url`, `urlContains`, or `urlRegex`.
On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_URL_TIMEOUT"` and `data.diagnostic` with the
`currentUrl` and `urlPattern`.

```json
{ "tabId": 123, "urlRegex": "/dashboard(\\?|$)", "timeoutMs": 30000 }
```

### `page.waitForPopup`

Waits for a popup tab/window to be opened by the target tab (matched by
`openerTabId`). Supports optional `url`, `urlContains`, or `urlRegex` filters to
wait for the popup to reach a target URL. On timeout, the JSON-RPC error
includes `data.code: "PAGE_WAIT_FOR_POPUP_TIMEOUT"`.

A short lookback buffer means a popup opened **just before** the call is still
caught, so the usual click-then-wait order works: a popup opened by this tab
within `popupLookbackMs` (default 3000, max 10000) is collected even if it
appeared before `page.waitForPopup` ran. Each buffered popup is collected at
most once. Set `"popupLookbackMs": 0` to only consider popups opened after the
call starts.

The captured popup is moved into the opener's Agent-managed tab group so it can
be driven immediately (`page.*`, `locator.*`, etc.); the returned `tab.groupId`
reflects this. Because grouping co-locates tabs, a popup opened in a separate
window is moved into the opener's window. Pass `"adopt": false` to leave the
popup ungrouped (observe only; it then stays outside the Agent boundary).

```json
{ "tabId": 123, "urlContains": "login-success", "timeoutMs": 30000 }
```

### `page.waitForRequest`

Waits for a CDP `Network.requestWillBeSent` event. Supports `url`,
`urlContains`, `urlRegex`, `method`, `resourceType`,
`requestHeaderContains`/`headerContains`, and
`requestHeaderRegex`/`headerRegex`, `postDataContains`, and `postDataRegex`
filters. Pass `includeHeaders:true` to include redacted request headers in the
result.
On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_REQUEST_TIMEOUT"` and `data.diagnostic` with
filters, observed event count, and recent request candidates.

```json
{ "tabId": 123, "urlContains": "/api/items", "method": "POST", "headerContains": { "Content-Type": "json" }, "timeoutMs": 30000 }
```

### `page.waitForResponse`

Waits for a CDP `Network.responseReceived` event. Supports `url`,
`urlContains`, `urlRegex`, `status`, `method`, `resourceType`,
`responseHeaderContains`/`headerContains`, and
`responseHeaderRegex`/`headerRegex` filters. Pass `includeHeaders:true` to
include redacted response headers in the result.

Content filters wait for the response body to finish loading and match against
it: `mimeType` (substring of the response MIME type, no body fetch), `minSize`
/ `maxSize` (wire size in bytes from `loadingFinished`), `bodyContains`,
`bodyRegex`, and JSON matching via `jsonPath` (dot/bracket path, e.g.
`data.items[0].id`) optionally constrained by `jsonEquals` (deep equality) or
`jsonContains` (substring of the stringified value). When a body filter is used
the result includes `bodyMatched` and `bodyBytes`; pass `includeBody:true` to
also return a bounded `bodyPreview` (off by default for privacy).

On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_RESPONSE_TIMEOUT"` and `data.diagnostic` with
filters, observed event count, and recent response candidates.

```json
{ "tabId": 123, "urlContains": "/api/items", "status": 200, "method": "GET", "timeoutMs": 30000 }
```

```json
{ "tabId": 123, "urlContains": "/api/items", "jsonPath": "data.items[0].id", "jsonEquals": 7 }
```

### `page.waitForNetworkIdle`

Waits until new network activity has been idle for `idleMs` (default `500`).
Set `maxInflight` to allow a small number of still-open requests.
On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_NETWORK_IDLE_TIMEOUT"` and `data.diagnostic` with
`inflight`, `maxInflight`, `idleMs`, and `msSinceLastActivity`.

```json
{ "tabId": 123, "idleMs": 500, "maxInflight": 0, "timeoutMs": 30000 }
```

### `page.waitForDialog`

Waits for a JavaScript dialog (`alert`, `confirm`, `prompt`, or
`beforeunload`). Supports `type`, `message`, `messageContains`, and
`messageRegex` filters.
On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_DIALOG_TIMEOUT"` and `data.diagnostic`.

```json
{ "tabId": 123, "type": "confirm", "messageContains": "Delete", "timeoutMs": 30000 }
```

### `page.acceptDialog` / `page.dismissDialog`

Handles the currently open JavaScript dialog. Pass `promptText` when accepting
a prompt dialog.

```json
{ "tabId": 123, "promptText": "hello" }
```

### `page.frames`

Lists frames in a tab. Use a returned `frameId` with `page.*`, `dom.*`, and
`locator.*` methods to target same-origin or cross-origin frames. `frameUrl`
can also be passed to those methods to resolve the first matching frame URL.

When a frame-scoped operation fails (locator actionability/strict/expectation
timeouts, `page.waitForSelector`, `page.waitForText`), the error `diagnostic`
carries a `frame` object with `frameId`, `url`, `name`, and a `framePath` — the
root-to-target ancestor chain (`[{frameId,url,name}, ...]`) — so failures inside
nested iframes are traceable. The human-readable message appends `(path: 0 > 7 >
12)` when the target is more than one frame deep.

```json
{ "tabId": 123 }
```

### `page.waitForSelector`

Polls for a CSS selector. Set `visible` to require a visible box. Use
`frameId`, `frameUrl`, or `frameSelector` to target a frame.
On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_SELECTOR_TIMEOUT"` and `data.diagnostic` with
`selector`, `foundInDom`, `visible`, `tagName`, and `frame`. `foundInDom` with
`visible:false` distinguishes a hidden element from a missing one.

```json
{ "tabId": 123, "selector": "main button", "visible": true, "timeoutMs": 30000, "frameId": 7 }
```

### `page.waitForText`

Polls the whole page, or a selector subtree, for text. Use `frameId`,
`frameUrl`, or `frameSelector` to target a frame.
On timeout, the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_TEXT_TIMEOUT"` and `data.diagnostic` with `text`,
`selectorFound`, `observedTextLength`, `preview`, and `frame`.

```json
{ "tabId": 123, "text": "Signed in", "selector": "main", "timeoutMs": 30000, "frameId": 7 }
```

### `page.executeJavaScript`

```json
{ "tabId": 123, "script": "document.title", "world": "MAIN", "cspBypassTtlMs": 60000 }
```

### `page.waitForFunction`

Polls an in-page predicate until it is truthy. `expression` (alias `script`) is
an expression or a function source; when it is a function it is called with
`arg`. Use `world` (`MAIN`/`isolated`) and frame targeting (`frameId`/`frameUrl`/
`frameSelector`). On timeout the JSON-RPC error includes
`data.code: "PAGE_WAIT_FOR_FUNCTION_TIMEOUT"` and `data.diagnostic` with the
last predicate error (if any). Returns the predicate's value when it resolves
(primitive values only).

```json
{ "tabId": 123, "expression": "() => window.__appReady === true", "timeoutMs": 30000 }
```

### `expect.page.toHaveTitle`

Waits for the tab title to match `title` (exact), `titleContains`, or
`titleRegex`. On timeout: `data.code: "PAGE_EXPECT_TITLE_TIMEOUT"` with the
current title.

```json
{ "tabId": 123, "titleContains": "Dashboard" }
```

### `page.addInitScript` / `page.removeInitScript`

Registers a script (via CDP `Page.addScriptToEvaluateOnNewDocument`) to run
before any page script on every subsequent navigation/document in the tab —
useful for setting flags, stubbing, or installing probes ahead of page load.
Returns an `identifier`; pass it to `page.removeInitScript` to unregister. Pass
`runImmediately:true` to also evaluate it in the current document, and
`worldName` to target an isolated world.

```json
{ "tabId": 123, "script": "window.__agent = true;" }
```

### `page.domSnapshot`

Uses CDP `DOMSnapshot.captureSnapshot`.

```json
{ "tabId": 123, "computedStyles": [], "includeDOMRects": true }
```

### Emulation

A small set of CDP-backed emulation overrides for a tab. `page.clearEmulation`
resets device metrics, geolocation, media, and network conditions.

- `page.setViewport` — `Emulation.setDeviceMetricsOverride` (`width`, `height`,
  `deviceScaleFactor`, `mobile`).
- `page.emulateMedia` — `Emulation.setEmulatedMedia` (`media`, `colorScheme`,
  `reducedMotion`, `forcedColors`).
- `page.setGeolocation` — `Emulation.setGeolocationOverride` (`latitude`,
  `longitude`, `accuracy`). Grant the page's geolocation permission separately.
- `page.setLocale` — `Emulation.setLocaleOverride` + `setTimezoneOverride`
  (`locale`, `timezone`).
- `page.setOffline` — `Network.emulateNetworkConditions` (`offline`).
- `page.setExtraHTTPHeaders` — `Network.setExtraHTTPHeaders` (`headers` object
  added to every request for the tab; the result and recordings list header
  names only, since values may be auth tokens).
- `page.setUserAgent` — `Emulation.setUserAgentOverride` (`userAgent`, optional
  `acceptLanguage`, `platform`).
- `page.clearEmulation` — clears the device/geolocation/media/network overrides.

```json
{ "tabId": 123, "width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": true }
```

```json
{ "tabId": 123, "headers": { "X-Tenant": "acme" } }
```

```json
{ "tabId": 123, "colorScheme": "dark", "media": "screen" }
```

### `page.ariaSnapshot`

Returns a compact accessibility snapshot built from CDP
`Accessibility.getFullAXTree`: a nested `tree` of `{role, name, <props>, children}`
plus a stable, diff-friendly `snapshot` string (one `- role "name"[prop=val]`
line per node). Ignored nodes and transparent wrappers (`generic`/`none`/
`presentation`/`group`) are dropped and their children promoted, so the output
is a clean perception layer for an LLM. Use `maxDepth` to cap nesting and
`interestingOnly:false` to keep wrapper roles.

```json
{ "tabId": 123, "maxDepth": 12 }
```

### `page.accessibilityTree`

Returns a DOM-derived accessibility tree for agent perception. Nodes include
`ref`, `snapshotId`, and `frameId`; interactive nodes can be acted on directly
with `locator.clickRef` / `fillRef` / `pressRef` / `hoverRef` without rebuilding a
text/role locator.

By default it returns the verbose `nodes` array (each with `bounds`). Pass
`"format": "compact"` to instead get a `snapshot` string: one terse line per node
with the frame-scoped ref inlined as `[f<frameId>:<ref>]` and bounds dropped —
typically less than half the tokens, and the recommended perceive-to-act format
since the agent acts by `ref`, not coordinates. For example, `[f7:ref_3]` means
call a ref action with `frameId:7` and `ref:"ref_3"`. The response then carries
`snapshot`, `snapshotId`, `nodeCount`, and `truncated` (no `nodes`).

```json
{ "tabId": 123, "maxNodes": 1000 }
```

```json
{ "tabId": 123, "format": "compact" }
```

Compact lines look like `[ref_4] textbox "Email" ="a@b.com" type=email`, with
plain text rendered as indented lines.

### `expect.page.toMatchAriaSnapshot`

Retries until the page's aria snapshot matches `expected` (alias `snapshot`).
Matching is an ordered subset: each non-empty expected line must appear, in
order, as a substring of an actual snapshot line — so a partial expected tree
asserts presence and ordering without pinning the whole page. On timeout:
`data.code: "PAGE_EXPECT_ARIA_SNAPSHOT_TIMEOUT"` with `missing` (unmatched
expected lines) and an `actualPreview`.

```json
{ "tabId": 123, "expected": "- heading \"Welcome\"\n- button \"Save\"" }
```

### `page.screenshot`

Captures the visible tab and returns a `dataUrl`.

```json
{ "tabId": 123, "format": "png" }
```

To save a screenshot to disk, pass the returned `dataUrl` to `native.saveDataUrl`.

### `page.pdf`

Renders the page to PDF via CDP `Page.printToPDF` and returns a base64
`dataUrl` (`application/pdf`). Supports `landscape`, `printBackground` (default
`true`), `scale`, `paperWidth`/`paperHeight` (inches), `pageRanges`, and
`preferCSSPageSize`. Pass the `dataUrl` to `native.saveDataUrl` to write it to
disk (saved with a `.pdf` extension).

```json
{ "tabId": 123, "landscape": false, "printBackground": true }
```

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
On actionability timeout, the `dom.*` action methods raise a JSON-RPC error with
`data.code: "DOM_ACTIONABILITY_TIMEOUT"` and `data.diagnostic` (selector, action,
match counts, reasons, frame, and last element). A located element that has no
usable click point uses `data.code: "DOM_ELEMENT_NOT_ACTIONABLE"`. This mirrors
the `locator.*` diagnostics so both interaction surfaces report failures the
same way.
Successful responses also carry the `whatChanged` object described under
[Action Observer](#action-observer-state-diffing).

```json
{ "tabId": 123, "selector": "button[type=submit]", "index": 0, "timeoutMs": 30000, "frameSelector": "iframe[name=app]" }
```

### `dom.dragTo`

Drags from a source selector to a target selector using CDP mouse events.
Both source and target auto-wait for actionability unless `force:true` is set.

```json
{ "tabId": 123, "selector": ".card", "targetSelector": ".drop-zone", "steps": 12 }
```

### `dom.dispatchDragDrop`

Dispatches an HTML5 drag/drop event sequence with `DataTransfer`:
`dragstart`, `dragenter`, `dragover`, `drop`, and `dragend`. This is useful for
apps that listen for DOM drag events instead of mouse movement.

```json
{ "tabId": 123, "selector": ".card", "targetSelector": ".drop-zone", "data": { "text/plain": "card-1" } }
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

### `dom.setInputFiles`

Sets local file paths on an `<input type="file">` through CDP
`DOM.setFileInputFiles`, then dispatches input/change events. Use `files`,
`filePaths`, `filePath`, or `path`. Multiple files require the input to have
the `multiple` attribute.

```json
{ "tabId": 123, "selector": "input[type=file]", "files": ["/tmp/report.pdf"], "frameId": 7 }
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
`role`, `name`, `label`, `placeholder`, `hasText`, `hasNotText`,
`hasAttribute`, `hasNotAttribute`, `exact`, `regex`, `caseSensitive`, `visible`,
`includeHidden`, `checked`, `disabled`, `expanded`, `pressed`, `selected`,
`level`, `frameId`, `frameUrl`, `frameSelector`, and `within`. With `regex:true`
the text matchers (`text`, `hasText`, `hasNotText`, `name`, `label`,
`placeholder`) treat their value as a regular expression (case-insensitive
unless `caseSensitive`), which is the precise way to narrow "matched too many";
an invalid pattern simply never matches. `within` takes a nested locator
(same fields, may itself nest `within`) and scopes the match to descendants of
the parent locator's matches — the equivalent of Playwright's
`page.locator(parent).locator(child)`. The parent must carry its own matcher.
Role/name matching uses implicit HTML roles,
explicit ARIA roles, `aria-label`, `aria-labelledby`, associated labels,
heading levels, and common ARIA state filters. Locator matching pierces open
shadow roots by default. Closed shadow roots remain inaccessible.

```json
{ "tabId": 123, "role": "button", "name": "Submit", "visible": true }
```

```json
{ "tabId": 123, "role": "heading", "name": "Account", "level": 2 }
```

```json
{ "tabId": 123, "role": "button", "name": "Save", "within": { "selector": ".card", "hasText": "Billing" } }
```

### `locator.textContent`

Returns the text of the matched element at `index` (default `0`).

```json
{ "tabId": 123, "text": "Order total", "index": 0 }
```

### `locator.allTextContents`

Returns `textContent` for all matched elements, capped by `limit` (default `50`,
maximum `200`). Empty matches return an empty array.

```json
{ "tabId": 123, "selector": ".result-title", "limit": 100 }
```

### `locator.allInnerTexts`

Returns rendered `innerText` for all matched elements, capped by `limit`.

```json
{ "tabId": 123, "role": "listitem", "limit": 100 }
```

### `locator.getAttribute`

Returns an attribute value for the matched element at `index`.

```json
{ "tabId": 123, "selector": "a.result", "name": "href", "index": 0 }
```

### `locator.first` / `locator.last` / `locator.nth`

Returns an element summary for the first, last, or nth matched element. `nth`
accepts `nth` or `index`.

```json
{ "tabId": 123, "selector": ".result", "hasText": "OpenAI", "nth": 2 }
```

### `locator.waitFor`

Waits for a locator state: `attached`, `visible` (default), `hidden`, or
`detached`.

```json
{ "tabId": 123, "label": "Email", "state": "visible", "timeoutMs": 30000 }
```

### `locator.screenshot`

Captures a screenshot cropped to the matched element at `index`. By default it
waits for the element to be visible and stable, then returns a `dataUrl`.

```json
{ "tabId": 123, "role": "img", "name": "Chart", "format": "png" }
```

### `expect.locator.*`

Assertion-style waits for common locator conditions. The locator can be passed
directly or under `locator`. Text and attribute assertions support
`timeoutMs`, `intervalMs`, `contains`, `caseSensitive`, `normalizeWhitespace`,
and `regex:true` (match the expected value as a regular expression).

Available: `toBeVisible`, `toBeHidden`, `toBeEnabled` (pass `enabled:false` to
assert disabled), `toBeDisabled`, `toBeEditable`, `toBeChecked` (pass
`checked:false` to assert unchecked), `toHaveValue` (`expectedValue`/`value`,
supports `contains`/regex like the text assertions), `toHaveCount`,
`toHaveText`, and `toHaveAttribute`. State assertions retry until the element is
present and the condition holds, so they tolerate a not-yet-rendered element. On
timeout: `data.code: "LOCATOR_EXPECT_TIMEOUT"` with the expected/actual values
and candidate summaries. There is also a page-level `expect.page.toHaveTitle`.

```json
{ "tabId": 123, "locator": { "role": "button", "name": "Save" } }
```

```json
{ "tabId": 123, "selector": ".result", "count": 10 }
```

```json
{ "tabId": 123, "locator": { "selector": "h1" }, "expectedText": "Dashboard" }
```

```json
{ "tabId": 123, "locator": { "selector": "a.result" }, "attribute": "href", "expectedValue": "/items/1", "contains": true }
```

Supported methods are `expect.locator.toBeVisible`,
`expect.locator.toHaveCount`, `expect.locator.toHaveText`, and
`expect.locator.toHaveAttribute`.
On assertion timeout, the JSON-RPC error includes
`data.code: "LOCATOR_EXPECT_TIMEOUT"` and `data.diagnostic` with the assertion,
expected value, actual value, frame, match counts, and candidate summaries.

### `locator.click`

Clicks the matched element at `index` (default `0`) using a CDP mouse input
path. By default this auto-waits for the element to be visible, enabled, have a
stable bounding box, and for the clickable point to receive pointer events
without being covered by another element. Use `timeoutMs` and `intervalMs` to
tune the wait, `strict:true` to require exactly one match, `stable:false` to
skip the bounding-box stability check, or `force:true` to bypass actionability
checks.
On actionability timeout, the JSON-RPC error includes
`data.code: "LOCATOR_ACTIONABILITY_TIMEOUT"` and `data.diagnostic` with the
last match counts, reasons, frame, target element, and nearby candidate
summaries.
When `strict:true` and the locator resolves to more than one element, the error
instead uses `data.code: "LOCATOR_STRICT_MODE_VIOLATION"` and `data.diagnostic`
lists `count` and every conflicting candidate (`candidates`, capped by the
in-page collection limit, with `candidatesTruncated` when `count` exceeds it).
This applies to all auto-waiting locator actions (`locator.click`,
`locator.fill`, `locator.check`, `locator.selectOption`, drag, etc.).
Successful responses also carry the `whatChanged` object (see
[Action Observer](#action-observer-state-diffing)).

```json
{ "tabId": 123, "role": "button", "name": "Submit", "timeoutMs": 30000 }
```

### `locator.clickRef`

Clicks an element returned by `page.accessibilityTree` using its `ref`. This is
the deterministic perceive-to-act path for agents: read a snapshot, pick a node,
then pass its `ref`, `snapshotId`, and `frameId` directly without rebuilding a
locator from text. The ref is resolved in the page content script and clicked via
the same CDP mouse input path as `locator.click`.

Refs are valid for the latest accessibility snapshot in that frame. Passing
`snapshotId` is recommended; a stale id is rejected instead of clicking a newer
node that reused the same `ref_N`. Use `force:true` to bypass actionability
checks. Successful responses also carry the `whatChanged` object (see
[Action Observer](#action-observer-state-diffing)).

```json
{ "tabId": 123, "ref": "ref_4", "snapshotId": "snap_lx3...", "frameId": 0 }
```

### `locator.fillRef` / `locator.pressRef` / `locator.hoverRef` / `locator.selectOptionRef`

The act-by-ref siblings of `locator.clickRef`: they resolve a `ref` from
`page.accessibilityTree` the same way (with `snapshotId` / `frameId` / `force`)
and act on it without rebuilding a locator.

- **`locator.fillRef`** — focuses the ref and replaces its text. Requires `text`
  (or `value`). It focuses the element in-page and selects its existing content
  (works for input/textarea/contentEditable), then inserts the new text via real
  CDP input; pass `"replace": false` to insert at the caret instead.
- **`locator.pressRef`** — focuses the ref (without clicking, so a button is not
  activated), then sends `key` (e.g. `"Enter"`, `"Control+a"`) through the
  keyboard dispatcher.
- **`locator.hoverRef`** — moves the mouse over the ref (no click).
- **`locator.selectOptionRef`** — selects option(s) on a `<select>` ref. Accepts
  `value` / `label` / `index` (or arrays via `values`/`options`, same shape as
  `locator.selectOption`); returns the `selected` options. Honors `multiple`.

To toggle a checkbox/radio by ref, use `locator.clickRef` (clicking toggles it).

```json
{ "tabId": 123, "ref": "ref_4", "snapshotId": "snap_lx3...", "frameId": 0, "text": "alice@example.com" }
```

### `locator.fill`

Fills an input, textarea, select-like value field, or contenteditable element.
By default this auto-waits for the element to be visible, enabled, editable,
and have a stable bounding box. Text fields and contenteditable elements are
focused and filled through CDP text input; native selects use value assignment
plus input/change events.
For flat params, `text` is the value to fill. To locate by text and fill a
different value, use the nested form. Successful responses also carry the
`whatChanged` object (see [Action Observer](#action-observer-state-diffing)).

```json
{ "tabId": 123, "label": "Search", "text": "browser bridge" }
```

### `locator.focus`

Focuses the matched element (without clicking) and records the action. Accepts
the usual locator fields and `index`.

```json
{ "tabId": 123, "selector": "input[name=q]" }
```

### `locator.boundingBox`

Returns the matched element's `boundingBox` (`getBoundingClientRect`, in the
element's frame viewport coordinates) plus the element summary. Read-only — it
does not scroll the page or focus the element.

```json
{ "tabId": 123, "role": "button", "name": "Submit" }
```

```json
{ "tabId": 123, "locator": { "text": "Search" }, "value": "browser bridge" }
```

### `locator.press`

Focuses the matched element and presses a single key or shortcut (for example
`Enter`, `Tab`, `Control+a`). Auto-waits for the element to be visible, enabled,
and stable (no editable or hit-test requirement, so it works on buttons too).
Pass `force:true` to skip the wait, `delayMs` to hold the key.

```json
{ "tabId": 123, "selector": "input[name=q]", "key": "Enter" }
```

### `locator.pressSequentially`

Focuses the matched element and types `text` (alias `value`) character by
character, optionally with `delayMs` between keys. Auto-waits like `locator.fill`
(requires editable). Prefer `locator.fill` for setting a value directly; use this
when a field reacts to individual keystrokes. Typed text is redacted from
recordings unless `includeText:true`.

```json
{ "tabId": 123, "selector": "input[name=q]", "text": "brow", "delayMs": 50 }
```

### `locator.dragTo`

Drags from one locator to another. Pass the destination as `targetLocator`,
`target`, or `targetSelector`.

```json
{ "tabId": 123, "text": "Card A", "targetLocator": { "text": "Done" }, "steps": 12 }
```

### `locator.dispatchDragDrop`

Dispatches the same HTML5 drag/drop event sequence as `dom.dispatchDragDrop`,
using locator semantics for the source and destination. Source and target must
be in the same frame.

```json
{ "tabId": 123, "text": "Card A", "targetLocator": { "text": "Done" }, "data": { "text/plain": "card-a" } }
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

### `locator.setInputFiles`

Sets local file paths on a located `<input type="file">`. Supports the same
locator fields as `locator.click`, plus `files`, `filePaths`, `filePath`, or
`path`.

```json
{ "tabId": 123, "label": "Upload receipt", "files": ["/tmp/receipt.png"] }
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

### `keyboard.type`

Types text through CDP `Input.insertText`. Pass `delayMs` to insert one
character at a time.

```json
{ "tabId": 123, "text": "hello", "delayMs": 20 }
```

### `keyboard.compose`

Types `text` into the focused element as IME composition: drives
`compositionstart`/`compositionupdate` (via CDP `Input.imeSetComposition`) and
then commits with `compositionend`, so fields with composition handlers
(CJK/accented input, search-as-you-type that guards on composition) behave like
real IME input rather than a raw paste. By default each character extends the
composition incrementally; pass `segments` to control the composition steps
explicitly, `delayMs` to pace them, or `commit:false` to leave the composition
uncommitted (pending). Focus the target first (e.g. with `locator.click` or
`dom.click`); contenteditable elements are supported.

```json
{ "tabId": 123, "text": "你好", "delayMs": 30 }
```

### `keyboard.press`

Dispatches one key or shortcut with realistic key metadata such as `code`,
`windowsVirtualKeyCode`, and modifier key down/up events.

```json
{ "tabId": 123, "key": "Control+a" }
```

### `keyboard.down` / `keyboard.up`

Dispatches a single key down or key up event. Use `keyboard.press` for normal
shortcuts.

```json
{ "tabId": 123, "key": "Shift" }
```

### `computer.scroll`

```json
{ "tabId": 123, "x": 400, "y": 400, "deltaY": 600 }
```

### `computer.key`

Compatibility alias for a keyboard shortcut. Prefer `keyboard.press` for new
automation code.

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

### `downloads.waitFor`

Waits for a matching Chrome download. By default it waits for a new download
started after the call to reach `state:"complete"`. Set `includeExisting:true`
to match older downloads, or `state:"any"` to return as soon as a matching item
is visible.

```json
{ "filenameContains": "report", "state": "complete", "timeoutMs": 30000 }
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

### `console.read`

Retrieves collected console events (logs, warnings, errors) for the specified tab.

```json
{ "tabId": 123, "limit": 100 }
```

### `network.read`

Retrieves collected network request events for the specified tab.

```json
{ "tabId": 123, "limit": 100 }
```

### `cookies.get`

Reads cookies for a tab via CDP `Network.getCookies`. **Sensitive and
read-only**: it can return httpOnly session tokens (which page JavaScript cannot
read), so it uses its own `cookies` approval category that is **never
auto-allowed inside the Agent boundary** — every call prompts for approval
(unless runtime approval is disabled or the category was session-allowed). There
are intentionally no cookie write/delete methods.

Each cookie returns `name`, `domain`, `path`, `expires`, `size`, `httpOnly`,
`secure`, `sameSite`, and `session`. Values are **redacted by default**
(`valueLength` only); pass `includeValues:true` to receive the raw `value`.
Optional `urls` (array) scopes the query; `name`/`domain` filter the result.

```json
{ "tabId": 123, "name": "session_id", "includeValues": false }
```

### `network.getResponseBody`

Fetches a captured response body via CDP `Network.getResponseBody`, using a
`requestId` from `network.read` events or a `page.waitForResponse` result.
Returns `{ requestId, base64Encoded, body }`; `body` is the raw CDP body — text
when `base64Encoded` is `false`, otherwise a base64 string the caller decodes.
The body must still be in the network buffer (after the response finished
loading), and very large bodies may exceed the native host's 32 MB message
limit.

```json
{ "tabId": 123, "requestId": "12345.67" }
```
### `network.setBlockedUrls`

Blocks network requests matching specified URL patterns for the target tab. Pass an empty array `[]` to clear all blocked URLs.

```json
{ "tabId": 123, "urls": ["*.png", "*.jpg", "*google-analytics.com*"] }
```

### `network.setInterceptors`

Registers request interceptors for the specified tab using the CDP `Fetch` domain. Supports block, redirect, mock response, and modify headers actions. Pass an empty array `[]` or omit `rules` to disable request interception. Rules may include `urlPattern` or `urlRegex`, `id`, `method`/`methods`, `resourceType`/`resourceTypes`, `postDataContains`/`postDataRegex`, and `headerContains`/`headerRegex` filters for narrower matching, plus `times` for one-shot or limited-use routes.

```json
{
  "tabId": 123,
  "rules": [
    {
      "urlPattern": "*google-analytics.com*",
      "action": "block",
      "errorReason": "BlockedByClient",
      "resourceType": "Script"
    },
    {
      "urlPattern": "*/old-api/*",
      "action": "redirect",
      "targetUrl": "https://example.com/new-api/v2"
    },
    {
      "id": "mock-user-once",
      "urlRegex": "^https://api\\.example\\.com/v\\d+/mock-user$",
      "method": "GET",
      "postDataContains": "\"operationName\":\"GetUser\"",
      "headerRegex": { "X-Tenant": "^tenant-\\d+$" },
      "times": 1,
      "action": "mock",
      "responseCode": 200,
      "responseHeaders": { "Content-Type": "application/json" },
      "responseBody": "{\"id\":123,\"username\":\"mock_user\"}"
    },
    {
      "urlPattern": "*",
      "action": "modifyHeaders",
      "requestHeaders": {
        "Authorization": "Bearer injected-token",
        "X-Remove-Me": null
      }
    },
    {
      "urlPattern": "*/asset.bin",
      "action": "mock",
      "responseHeaders": { "Content-Type": "application/octet-stream" },
      "responseBodyBase64": "AAECAw=="
    }
  ]
}
```

For `modifyHeaders`, set a request header value to `null` to remove it case-insensitively.
For `mock`, use either `responseBody` for text or `responseBodyBase64` for already-encoded binary payloads.

### `network.interceptors.status`

Returns the active interceptor rules for the specified tab, including remaining `times` counts and recent match events. Sensitive request header values in rule snapshots are redacted.

```json
{ "tabId": 123 }
```

### `network.routeFromHAR`

Replays a HAR archive: converts `har.log.entries` into `mock` interceptor rules
so each recorded request URL + method is fulfilled with its recorded status,
headers, and body. This installs the rules like `network.setInterceptors` (and
replaces any existing rules for the tab). Transfer headers
(`content-encoding`/`content-length`/`transfer-encoding`) and HTTP/2 pseudo
headers are dropped; base64 entry bodies are replayed as-is.

Options: `urlFilter` (substring — only replay matching entries), `methods`
(array — only replay these request methods), `sequential` (serve each entry once
in order instead of repeatedly), and `notFound` — `fallback` (default, unmatched
requests go to the network) or `abort` (unmatched requests are blocked via a
trailing catch-all rule). Entries with no captured response (status 0) are
skipped. Returns `rulesCount`, `entriesRouted`, and the effective `notFound`.

```json
{ "tabId": 123, "har": { "log": { "entries": [] } }, "notFound": "abort" }
```

### `network.interceptors.clear`

Clears active interceptor rules for the specified tab and disables CDP Fetch interception.

```json
{ "tabId": 123 }
```

### `network.interceptors.events`

Returns recent interceptor match events for the specified tab. Optional filters
include `ruleId`, `action`, `method`, `urlContains`, and `since` (event
timestamp in milliseconds). `limit` defaults to 100 and is capped at 500.

```json
{ "tabId": 123, "limit": 50, "ruleId": "mock-user-once", "action": "mock" }
```

### `network.interceptors.clearEvents`

Clears recent interceptor match events for the specified tab without changing active rules.

```json
{ "tabId": 123 }
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
