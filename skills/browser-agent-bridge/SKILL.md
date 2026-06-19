---
name: browser-agent-bridge
description: Use the Chrome Native Messaging browser-control bridge extension (Browser Agent Bridge) from an agent. Trigger when a user asks Codex/agent to inspect or control Chrome through the locally built Browser Agent Bridge, call browser tools exposed at http://127.0.0.1:8765/rpc or ws://127.0.0.1:8765/ws, verify the bridge/native host connection, troubleshoot the extension connection, or automate Chrome tabs/pages without embedding an LLM client in the extension.
---

# Browser Agent Bridge

Use the Browser Agent Bridge extension as a browser tool runtime. The extension contains no agent; an agent calls the native host HTTP or WebSocket endpoint, which forwards JSON-RPC over Native Messaging to Chrome.

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

## Platform Setup

Agent-run installation scripts live under `scripts/` and should be executed from the repository root. Generated Native Messaging launchers live under `native/` because the browser manifest points to them at runtime.

The installation process registers the Python host as a Chrome Native Messaging Host. This creates a JSON manifest file that tells Chromium browsers how to launch the host program using stdin/stdout.

First, you can diagnose the current state using:
```bash
python3 scripts/doctor.py --skip-live
```

### Install or Repair the Native Host

#### 1. macOS / Linux (Unix) Setup
Run the unified installer script from the repository root:
```bash
# macOS/Linux, Google Chrome
./scripts/install-native-host-unix.sh <extension-id>

# macOS/Linux, specify a different Chromium browser or all of them
./scripts/install-native-host-unix.sh --browser chromium <extension-id>
./scripts/install-native-host-unix.sh --browser brave <extension-id>
./scripts/install-native-host-unix.sh --browser edge <extension-id>
./scripts/install-native-host-unix.sh --browser all <extension-id>
```

**What this script does under the hood:**
* **Detects OS & Python**: Identifies whether it is running on macOS (Darwin) or Linux, and finds `python3` or `python` on the system `$PATH`.
* **Generates Unix Launcher**: Writes `native/host-wrapper.sh`. This launcher sources the token environment file, sets `BROWSER_AGENT_BRIDGE_EXTENSION_ID` to pin the extension, and spawns `native/host.py` with forwarded arguments.
* **Secures Auth Token**: If `~/.browser-agent-bridge.env` does not exist, the script generates a 16-byte random token encoded as 32 hex characters, writes it, and runs `chmod 600`.
* **Installs Manifest JSON**: Writes the manifest JSON file into the user-specific Chrome/Chromium native messaging directory:
  * macOS Google Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.browser_agent_bridge.json`
  * Linux Google Chrome: `~/.config/google-chrome/NativeMessagingHosts/com.local.browser_agent_bridge.json`
  * The manifest defines the `"path"` pointing to `native/host-wrapper.sh` and `"allowed_origins"` pointing to `chrome-extension://<extension-id>/`.

*Note: `scripts/install-native-host-macos.sh` is kept as a compatibility wrapper that forwards directly to the Unix script.*

#### 2. Windows Setup
Run the PowerShell installer script from the repository root:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host-win.ps1 <extension-id>
```

**What this script does under the hood:**
* **Locates Python**: Searches the system PATH for the `python` or `py` executable.
* **Generates Windows Launcher**: Creates a Batch file `native/host-wrapper.win.bat` that reads `%USERPROFILE%\.browser-agent-bridge.env`, sets the target extension ID, and runs Python with argument forwarding (`%*`).
* **Secures Auth Token**: Generates a 16-byte random token and saves it in `%USERPROFILE%\.browser-agent-bridge.env`.
* **Installs Manifest JSON**: Writes the manifest JSON to `%LOCALAPPDATA%\Google\Chrome\NativeMessagingHosts\com.local.browser_agent_bridge.json`.
* **Registers via Registry**: Adds a registry value under `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.local.browser_agent_bridge` pointing to the manifest file path. Installing in `HKCU` ensures that administrator privileges are not required.

### Generated Token Files
* macOS/Linux: `~/.browser-agent-bridge.env`
* Windows: `%USERPROFILE%\.browser-agent-bridge.env`

## Automated Self-Setup / 自动安装与自愈机制

When initialized in a new user workspace, the Agent SHOULD proactively check the connection status. If a connection failure or diagnostic warning occurs, the Agent is authorized to automatically perform self-registration:

1. Run `python3 scripts/doctor.py --skip-live` to detect host configuration health.
2. If `native.manifest.path` or native wrapper diagnostics fail:
   - Identify the user's OS.
   - For macOS/Linux: run `./scripts/install-native-host-unix.sh aodcpicfepmdmpfaflncbndcicoemdje` to register the native messaging host. Use `--browser chromium|brave|edge|all` when the user is not using Google Chrome.
   - For Windows: run `powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host-win.ps1 aodcpicfepmdmpfaflncbndcicoemdje`.
3. Automatically load the generated token from `~/.browser-agent-bridge.env` on macOS/Linux or `%USERPROFILE%\.browser-agent-bridge.env` on Windows into the environment or credentials and proceed with client operations.
4. Reload the unpacked extension in `chrome://extensions`, then open the extension side panel so Chrome starts the native host.

## Troubleshooting

If `/health` fails, the native host is not running. Native Messaging starts it only after Chrome loads the extension and connects.

If `/health` works and `authRequired` is true, make sure the agent process has the same `BROWSER_AGENT_BRIDGE_TOKEN` as the native host.

On macOS/Linux, the native wrapper loads `~/.browser-agent-bridge.env`. On Windows, the batch wrapper loads `%USERPROFILE%\.browser-agent-bridge.env`. If token auth is enabled, the user's shell or agent process should load the same token before using `scripts/rpc.sh` or `scripts/ws-rpc.js`. The Python client auto-loads the default token file.

If `/health` works but `extensionReady` is false:

- Tell the user to load or reload the unpacked extension from the repo's `extension/` directory.
- Tell the user to run the platform installer after copying the Chrome extension ID: `scripts/install-native-host-unix.sh <extension-id>` on macOS/Linux or `scripts/install-native-host-win.ps1 <extension-id>` on Windows.
- Tell the user to reload the extension again after installing the native manifest.

For a full setup check, run:

```bash
scripts/doctor.py
```

Doctor `package.freshness` warnings mean the release zip is older than the extension source files. This does not block local unpacked-extension development, but rebuild the release package before distributing.

If doctor reports new tools as "not exposed", reload the unpacked extension in `chrome://extensions`.

If `extension.reload` is already exposed, you can reload the extension through RPC:

```bash
scripts/browser_bridge_client.py rpc extension.reload
```

The extension ID is stabilized via a hardcoded key in `manifest.json`. The stable Extension ID is: `aodcpicfepmdmpfaflncbndcicoemdje`.

## Operating Rules

- Do not use this skill for public web research; this bridge controls the user's local Chrome.
- Page CSP (Content Security Policy) response headers are not stripped globally. Temporary CSP bypass defaults to enabled for new installs, but only adds a short-lived dynamic rule for the target origin when `tabs.create`, `session.start`, `page.navigate`, or `page.executeJavaScript` needs it. Check the current state with `extension.getCspBypass`; the toggle can only be changed by the user in the sidepanel UI. Pass `bypassCSP:false` to opt out for a call.
- When CSP bypass is enabled, prefer the bypass-capable path for analyzing and extracting web page content: navigate/create the target tab with the default bypass behavior, then use `page.readText`, `page.accessibilityTree`, or `page.executeJavaScript` as needed. This is the preferred path for pages whose scripts or injected analysis helpers may be blocked by CSP.
- Browser history and bookmark search are intentionally not supported; ask the user for a URL or use currently open tabs instead.
- **Runtime Permission Approval**: By default, sensitive operations (tab list/session state, downloads records, screenshots/DOM snapshots, console/network logs, and `policy.set`) are intercepted by the extension and prompt the user in the sidepanel UI for approval (Allow once, Always for session, or Deny).
  - If the sidepanel is closed when making a sensitive call, the extension sends a Chrome notification and opens an extension approval popup window. The user can approve or deny from that popup.
  - If the user denies the request, the call will fail. Respect this choice and do not retry repeatedly; instead, explain the limitation to the user or ask for the information directly.
- **Domain Experience Accumulation**: Before automating a website, check the `skills/browser-agent-bridge/references/site-patterns/` folder. If a `{domain}.md` exists, read it for selector tricks, known traps, or navigation flows. At the end of every site-specific analysis, extraction, or automation task, actively decide whether the run revealed reusable site knowledge. If yes, update `skills/browser-agent-bridge/references/site-patterns/{domain}.md` even when recording was not enabled.
  - Save only reusable operational knowledge: stable selectors, reliable wait conditions, iframe/shadow DOM notes, CSP-bypass needs, login walls, pop-up handling, pagination/list/detail patterns, extraction scripts, known failure modes, and preferred bridge methods.
  - Do not save private user data, page contents copied from a session, credentials, personal account details, or one-off observations that are unlikely to help future runs.
  - Use concise sections such as `Selectors`, `Wait Conditions`, `Extraction`, `Navigation`, `CSP`, and `Pitfalls`; include the date when behavior may be time-sensitive.
- Do not execute high-risk actions such as purchases, sending messages, deleting data, changing account settings, or submitting sensitive forms unless the user explicitly asked for that exact action.
- Prefer read-only methods first: `tabs.list`, `page.readText`, `page.accessibilityTree` (which prunes intermediate layout containers and consolidates element child texts), `page.screenshot`.
- Prefer `session.start` for multi-step tasks that should stay isolated in a Chrome tab group. Use `session.createTab` for new tabs inside the session, `session.addTab` only when the user wants an existing tab adopted into the session, and `session.closeTab` to close one managed tab while keeping session metadata clean.
- Check `policy.get` before operating on sensitive domains or using high-risk methods; use `policy.set` only when the user asks to change local allow/block rules.
- Use `page.executeJavaScript` only when read-only methods are insufficient or when the user explicitly wants page scripting.
- Prefer `dom.query`, `dom.click`, `dom.type`, `dom.select`, `dom.hover`, and `dom.scroll` for ordinary page controls before falling back to viewport coordinates.
- Use `frameSelector` with `dom.*` and page wait methods for same-origin iframes. Cross-origin iframes are not accessible through DOM methods.
- Use `page.waitForLoad`, `page.waitForSelector`, or `page.waitForText` after navigation or UI actions instead of sleeping blindly.
- Use `computer.*` methods for visible UI automation. Coordinates are CSS viewport coordinates. `computer.click`, `computer.drag`, and `computer.hover` do not display the page dot/label unless `showIndicator:true` is passed. Use `computer.hover` for cursor movements, and `computer.key` with combinations (e.g. "Control+a", "Meta+c") for keyboard shortcuts.
- If a call returns a restricted-page/debugger error, explain that Chrome blocks extension automation on pages such as `chrome://`, Chrome Web Store, or pages controlled by another debugger.

## Common Workflows

### Inspect Current Page

1. `tabs.list` with `{ "query": { "active": true, "currentWindow": true } }`
2. Call `extension.getCspBypass`; if enabled, prefer the default CSP-bypass path while analyzing or extracting page content.
3. `page.readText` for visible text
4. `page.accessibilityTree` for interactable elements
5. Use `page.executeJavaScript` for structured extraction when read-only text/tree methods are insufficient.
6. `page.screenshot` when visual confirmation matters
7. After finishing site-specific work, update `references/site-patterns/{domain}.md` if you learned reusable selectors, waits, extraction logic, navigation patterns, CSP needs, or pitfalls.

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

Recordings persist in Chrome local extension storage with privacy defaults: 24-hour retention, 500 actions per recording, screenshots off by default, and typed text/value fields redacted unless `includeText:true` is passed.

1. Call `recording.start` with a `tabId` or `groupId`; keep `captureScreenshots` false unless visual replay matters and use `includeText:true` only when the user explicitly needs typed text captured.
2. Perform `page.navigate`, `dom.*`, and `computer.*` actions normally.
3. Call `recording.stop`.
4. Call `recording.export`; use `download: true` when the user wants a JSON artifact saved through Chrome.
5. Call `recording.clear` after export for large or screenshot-heavy recordings.

## Repository Paths

From this project's root:

- Extension: `extension/`
- Native host: `native/host.py`
- Native manifest template: `native/com.local.browser_agent_bridge.json`
- Generated Unix launcher: `native/host-wrapper.sh`
- Generated Windows launcher: `native/host-wrapper.win.bat`
- macOS/Linux installer: `scripts/install-native-host-unix.sh`
- Legacy macOS installer entrypoint: `scripts/install-native-host-macos.sh`
- Windows installer: `scripts/install-native-host-win.ps1`
- RPC helper: `scripts/rpc.sh`
- WebSocket helper: `scripts/ws-rpc.js`
- Python client: `scripts/browser_bridge_client.py`
- Doctor: `scripts/doctor.py`
- Release builder: `scripts/build-release.sh`
- Protocol reference: `skills/browser-agent-bridge/references/protocol.md`
