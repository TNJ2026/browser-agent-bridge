# Local Browser Agent Bridge

An unpacked Chrome extension plus Native Messaging host that exposes browser-control tools to a local agent.

The extension does not contain an agent or model client. It only provides browser capabilities through JSON-RPC:

```text
Local Agent -> HTTP/WebSocket on 127.0.0.1:8765 -> Native Host -> Chrome Extension -> Chrome APIs/CDP
```

## What Works

- Native Messaging connection to `native/host.py`
- Local HTTP JSON-RPC endpoint for agents
- Local WebSocket JSON-RPC endpoint for long-lived agent sessions and extension events
- Tab list/create/activate/close/group
- Session workspace management backed by Chrome tab groups
- Page navigation, text extraction, accessibility tree, screenshot
- DOM snapshot capture through CDP
- JavaScript execution in the page
- Mouse click, drag, text insertion, key press, wheel scroll via Chrome Debugger Protocol
- Console and network event buffers
- Download listing
- Basic URL allow/block policy
- Basic JSON-RPC method allow/block policy
- Workflow recording with optional screenshots and JSON export
- Recording state persisted in `chrome.storage.local`
- Page visual indicator overlay
- Side panel connection status and smoke test

## Install For Local Development

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and choose this repo's `extension/` directory.
4. Copy the extension ID shown by Chrome.
5. Install the Native Messaging manifest:

```bash
scripts/install-native-host-macos.sh <extension-id>
```

6. Reload the extension in `chrome://extensions`.
7. Open the extension side panel. It should show `Connected`.

The native host starts when the extension connects to it. It then listens on:

```text
http://127.0.0.1:8765/rpc
ws://127.0.0.1:8765/ws
```

Use HTTP `/rpc` for one-shot JSON-RPC calls. Use WebSocket `/ws` when an agent wants one long-lived connection; it accepts the same JSON-RPC request shape and also streams extension notifications such as `extension.ready`.

## Local Token Auth

Token auth is optional and controlled by the native host environment:

```bash
export BROWSER_AGENT_BRIDGE_TOKEN="$(openssl rand -hex 32)"
```

For Chrome-launched Native Messaging on macOS, put the token in the wrapper env file so the host process can see it:

```bash
printf 'BROWSER_AGENT_BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > ~/.browser-agent-bridge.env
chmod 600 ~/.browser-agent-bridge.env
source ~/.browser-agent-bridge.env
```

When `BROWSER_AGENT_BRIDGE_TOKEN` is set, `/rpc`, `/events`, and `/ws` require:

```text
Authorization: Bearer <token>
```

`/health` stays readable and reports whether auth is enabled through `authRequired`. The bundled helpers automatically send the bearer token when `BROWSER_AGENT_BRIDGE_TOKEN` is present in their environment.

## Packaged Extension

The packaged MV3 extension zip is written to:

```text
dist/local-browser-agent-bridge-0.1.0.zip
```

## Try It

List tabs:

```bash
scripts/rpc.sh '{"jsonrpc":"2.0","id":"1","method":"tabs.list","params":{}}'
```

Create a tab:

```bash
scripts/rpc.sh '{"jsonrpc":"2.0","id":"2","method":"tabs.create","params":{"url":"https://example.com"}}'
```

Read page text:

```bash
scripts/rpc.sh '{"jsonrpc":"2.0","id":"3","method":"page.readText","params":{"tabId":123}}'
```

Click at viewport coordinates:

```bash
scripts/rpc.sh '{"jsonrpc":"2.0","id":"4","method":"computer.click","params":{"tabId":123,"x":300,"y":240}}'
```

Use the WebSocket endpoint:

```bash
scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"5","method":"extension.info","params":{}}'
```

Listen for bridge and extension notifications:

```bash
scripts/ws-rpc.js --listen
```

Use the Python client:

```bash
scripts/browser_bridge_client.py health
scripts/browser_bridge_client.py rpc tabs.list '{"query":{"active":true,"currentWindow":true}}'
```

Run diagnostics:

```bash
scripts/doctor.py
scripts/doctor.py --json
```

Build a release bundle:

```bash
scripts/build-release.sh
```

## JSON-RPC Methods

```text
extension.info
extension.reload
native.status
native.saveDataUrl
tabs.list
tabs.create
tabs.activate
tabs.close
tabs.group
session.start
session.list
session.get
session.stop
page.navigate
page.waitForLoad
page.waitForSelector
page.waitForText
page.readText
page.accessibilityTree
page.screenshot
page.executeJavaScript
page.domSnapshot
dom.query
dom.click
dom.type
dom.select
computer.click
computer.drag
computer.type
computer.key
computer.scroll
console.read
network.read
downloads.list
recording.start
recording.stop
recording.status
recording.export
recording.clear
indicator.set
policy.get
policy.set
policy.checkUrl
```

## Notes

- This is intended for local development or internal deployment.
- `scripts/ws-rpc.js` prints one JSON message per line. The first line is usually a `bridge.ready` notification; request responses include the matching `id`.
- `chrome.debugger` cannot attach to restricted pages such as `chrome://` and may conflict with DevTools or another debugger.
- `page.screenshot` uses `chrome.tabs.captureVisibleTab`, so it focuses the target tab/window first.
- The default URL policy blocks `chrome://*`, `chrome-extension://*`, and `chromewebstore.google.com/*`.
- Recordings are persisted in Chrome local extension storage, but large screenshot-heavy recordings should be exported and cleared.
- The first version intentionally has no built-in LLM/agent logic and no cloud service dependency.
