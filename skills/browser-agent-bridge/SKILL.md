---
name: browser-agent-bridge
description: Use the local Chrome Native Messaging browser-control bridge extension from an agent. Trigger when a user asks Codex/agent to inspect or control Chrome through the locally built Browser Agent Bridge, call browser tools exposed at http://127.0.0.1:8765/rpc or ws://127.0.0.1:8765/ws, verify the bridge/native host connection, troubleshoot the extension connection, or automate Chrome tabs/pages without embedding an LLM client in the extension.
---

# Browser Agent Bridge

Use the local Browser Agent Bridge extension as a browser tool runtime. The extension contains no agent; an agent calls the native host HTTP or WebSocket endpoint, which forwards JSON-RPC over Native Messaging to Chrome.

```text
Agent -> 127.0.0.1:8765 /rpc or /ws -> native/host.py -> Chrome extension -> Chrome APIs/CDP
```

## Quick Start

1. Check bridge health:

```bash
curl -sS http://127.0.0.1:8765/health
```

2. If healthy and `extensionReady` is true, call JSON-RPC:

```bash
curl -sS -H 'content-type: application/json' \
  -X POST http://127.0.0.1:8765/rpc \
  --data '{"jsonrpc":"2.0","id":"1","method":"tabs.list","params":{}}'
```

3. If `/health` reports `authRequired: true`, include `Authorization: Bearer $BROWSER_AGENT_BRIDGE_TOKEN`. The bundled `scripts/rpc.sh` and `scripts/ws-rpc.js` helpers do this automatically when the environment variable is set.

4. Use `POST /rpc` for one-shot calls. Use `ws://127.0.0.1:8765/ws` for a long-lived agent session or when you need streamed extension notifications.

WebSocket helper:

```bash
scripts/ws-rpc.js '{"jsonrpc":"2.0","id":"ws-1","method":"extension.info","params":{}}'
```

Notification stream:

```bash
scripts/ws-rpc.js --listen
```

Python client:

```bash
scripts/browser_bridge_client.py rpc tabs.list '{"query":{"active":true,"currentWindow":true}}'
```

5. Prefer `tabs.list` first to discover `tabId`. Use active/current-window query when the user's task concerns the current tab:

```json
{"query":{"active":true,"currentWindow":true}}
```

6. For detailed method parameters, read `references/protocol.md`.

## Troubleshooting

If `/health` fails, the native host is not running. Native Messaging starts it only after Chrome loads the extension and connects.

If `/health` works and `authRequired` is true, make sure the agent process has the same `BROWSER_AGENT_BRIDGE_TOKEN` as the native host.

On macOS, the native wrapper loads `~/.browser-agent-bridge.env`. If token auth is enabled, the user's shell or agent process should source the same file before using `scripts/rpc.sh` or `scripts/ws-rpc.js`.

If `/health` works but `extensionReady` is false:

- Tell the user to load or reload the unpacked extension from the repo's `extension/` directory.
- Tell the user to run `scripts/install-native-host-macos.sh <extension-id>` after copying the Chrome extension ID.
- Tell the user to reload the extension again after installing the native manifest.

For a full setup check, run:

```bash
scripts/doctor.py
```

If doctor reports new tools as "not exposed", reload the unpacked extension in `chrome://extensions`.

If `extension.reload` is already exposed, you can reload the extension through RPC:

```bash
scripts/browser_bridge_client.py rpc extension.reload
```

The extension ID is stabilized via a hardcoded key in `manifest.json`. The stable Extension ID is: `aodcpicfepmdmpfaflncbndcicoemdje`.

## Operating Rules

- Do not use this skill for public web research; this bridge controls the user's local Chrome.
- Page CSP (Content Security Policy) response headers are automatically stripped by the extension (`declarativeNetRequest`) by default, allowing you to run custom scripts (`page.executeJavaScript`) on any domain. You can check the current toggle state using `extension.getCspBypass`. It can only be changed by the user in the sidepanel UI.
- **Bookmarks & History Search**: When asked to locate internal pages or pages the user previously visited, call `history.search` or `bookmarks.search` JSON-RPC methods. This queries the local browser profile databases directly and resolves URLs without querying the public internet.
- **Runtime Permission Approval**: By default, sensitive operations (tab list/session state, history/bookmarks search, downloads records, screenshots/DOM snapshots, console/network logs) are intercepted by the extension and prompt the user in the sidepanel UI for approval (Allow once, Always for session, or Deny).
  - If the sidepanel is closed when making a sensitive call, the request fails with a `BrowserBridgeError`. If this happens, **explicitly ask the user to open the sidepanel** so they can approve the request.
  - If the user denies the request, the call will fail. Respect this choice and do not retry repeatedly; instead, explain the limitation to the user or ask for the information directly.
- **Domain Experience Accumulation**: Before automating a website, check the `skills/browser-agent-bridge/references/site-patterns/` folder. If a `{domain}.md` exists, read it for selector tricks, known traps, or navigation flows. If you find new selector paths or bypasses during execution, document them in a `{domain}.md` file in that folder to help future sessions.
- Do not execute high-risk actions such as purchases, sending messages, deleting data, changing account settings, or submitting sensitive forms unless the user explicitly asked for that exact action.
- Prefer read-only methods first: `tabs.list`, `page.readText`, `page.accessibilityTree` (which prunes intermediate layout containers and consolidates element child texts), `page.screenshot`.
- Prefer `session.start` for multi-step tasks that should stay isolated in a Chrome tab group.
- Check `policy.get` before operating on sensitive domains or using high-risk methods; use `policy.set` only when the user asks to change local allow/block rules.
- Use `page.executeJavaScript` only when read-only methods are insufficient or when the user explicitly wants page scripting.
- Prefer `dom.query`, `dom.click`, `dom.type`, `dom.select`, `dom.hover`, and `dom.scroll` for ordinary page controls before falling back to viewport coordinates.
- Use `frameSelector` with `dom.*` and page wait methods for same-origin iframes. Cross-origin iframes are not accessible through DOM methods.
- Use `page.waitForLoad`, `page.waitForSelector`, or `page.waitForText` after navigation or UI actions instead of sleeping blindly.
- Use `computer.*` methods for visible UI automation. Coordinates are CSS viewport coordinates. Use `computer.hover` for cursor movements, and `computer.key` with combinations (e.g. "Control+a", "Meta+c") for keyboard shortcuts.
- If a call returns a restricted-page/debugger error, explain that Chrome blocks extension automation on pages such as `chrome://`, Chrome Web Store, or pages controlled by another debugger.

## Common Workflows

### Inspect Current Page

1. `tabs.list` with `{ "query": { "active": true, "currentWindow": true } }`
2. `page.readText` for visible text
3. `page.accessibilityTree` for interactable elements
4. `page.screenshot` when visual confirmation matters

### Locate Local Pages (Bookmarks/History)

When the user asks to look up or navigate to a page they have visited before, or mentions an internal system (e.g. "my dashboard", "the wiki page", "the code repo I visited yesterday"):
1. Call `history.search` or `bookmarks.search` with a query of the system name or keywords.
2. If URLs are returned, select the most relevant one.
3. Call `page.navigate` (or `session.start` if isolating) to open and inspect that URL.

### Interact (Click, Type, Hover)


1. Read the accessibility tree or screenshot first.
2. Try `dom.query` to find stable selectors for the target control.
3. Call `dom.click`, `dom.type`, `dom.select`, `dom.hover`, or `dom.scroll` when selector targeting is reliable.
4. Call `page.waitForSelector` or `page.waitForText` when the action should change page state.
5. Fall back to `computer.click`, `computer.type`, `computer.key` (supporting combination shortcuts like "Control+a"), `computer.scroll`, or `computer.hover` when selector targeting is not enough.
6. Read the page again to verify the result.

### Debug A Page

1. Call `console.read` to attach CDP and collect console events.
2. Call `network.read` to attach CDP and collect network events.
3. Reproduce or navigate as needed.
4. Call the same read methods again.

### Work In An Isolated Session

1. Call `session.start` with a descriptive name and optional URL.
2. Use the returned `mainTabId` for page and computer methods.
3. Call `session.get` when you need current managed tabs.
4. Call `session.stop` when done; use `closeTabs: true` only if the user expects tabs to close.

### Record A Workflow

Recordings persist in Chrome local extension storage until cleared.

1. Call `recording.start` with a `tabId` or `groupId`; keep `captureScreenshots` false unless visual replay matters.
2. Perform `page.navigate`, `dom.*`, and `computer.*` actions normally.
3. Call `recording.stop`.
4. Call `recording.export`; use `download: true` when the user wants a JSON artifact saved through Chrome.
5. Call `recording.clear` after export for large or screenshot-heavy recordings.

## Repository Paths

From this project's root:

- Extension: `extension/`
- Native host: `native/host.py`
- Native manifest template: `native/com.local.browser_agent_bridge.json`
- macOS installer: `scripts/install-native-host-macos.sh`
- RPC helper: `scripts/rpc.sh`
- WebSocket helper: `scripts/ws-rpc.js`
- Python client: `scripts/browser_bridge_client.py`
- Doctor: `scripts/doctor.py`
- Release builder: `scripts/build-release.sh`
- Protocol reference: `skills/browser-agent-bridge/references/protocol.md`
