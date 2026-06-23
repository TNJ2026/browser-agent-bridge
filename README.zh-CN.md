# Browser Agent Bridge

Browser Agent Bridge 是一个未打包的 Chrome 扩展和 Native Messaging 宿主程序。它通过 HTTP 和 WebSocket 上的 JSON-RPC，把浏览器控制能力暴露给本地 Agent。

English documentation: [README.md](README.md)

## 目录

- [系统架构](#系统架构)
- [主要特性](#主要特性)
- [安装](#安装)
- [本地认证](#本地认证)
- [快速开始](#快速开始)
- [JSON-RPC 接口摘要](#json-rpc-接口摘要)
- [项目路径](#项目路径)
- [安全与隐私](#安全与隐私)

## 系统架构

扩展本身不包含 Agent 或模型逻辑。它只作为能力提供层，把本地程序连接到 Chrome API 和 Chrome DevTools Protocol。

```mermaid
graph TD
    Agent[本地 Agent] -->|HTTP / WS JSON-RPC| Host[Native Host / python3 native/host.py]
    Host -->|Stdio Native Messaging| Ext[Chrome Extension / service-worker.js]
    Ext -->|Chrome APIs & CDP| Browser[Chrome Browser]
```

- HTTP 接口：`http://127.0.0.1:8765/rpc`
- WebSocket 接口：`ws://127.0.0.1:8765/ws`

## 主要特性

- 通过 Chrome Native Messaging stdio 通道进行原生通信。
- 使用 Chrome Tab Groups 做标签页和会话隔离。
- 通过 Chrome DevTools Protocol 执行高保真页面交互。
- 支持读取可见文本、截图、DOM 快照和无障碍树。
- 支持页面 console 和 network 事件流。
- 支持工作流录制，并默认对输入内容脱敏。
- 支持可视化高亮，用于追踪 Agent 操作。

## 安装

前置条件：

- Google Chrome 116 或更高版本。
- 本地已安装 Python 3。

### 通过 CRX 安装 (Release)

每个 Release 版本中都会包含一个预构建的 `extension.crx` 文件。根据您使用的浏览器不同，您也许可以直接安装它：

1. 从最新的 Release 中下载 `extension.crx` 文件。
2. 打开浏览器的扩展管理页面（如 `chrome://extensions`、`edge://extensions` 等）。
3. 开启 **Developer mode** (开发者模式)。
4. 将 `extension.crx` 文件拖拽到该页面中。

> [!NOTE]
> **Google Chrome 和 Microsoft Edge** 通常会拦截并非从官方商店下载的 `.crx` 文件安装。如果安装被阻止，或安装后扩展被立即禁用，请直接放弃此方法，并使用下方的 **手动安装**（加载未打包扩展）方法。部分其他基于 Chromium 的浏览器可能会允许这种拖拽安装。

安装完扩展后，您仍然需要安装 Native Messaging host。请在安装后复制生成的扩展 ID，并继续执行 **手动安装** 部分的第 2 步。

### 手动安装

用户自己配置时使用这条路径。

1. 在 Chrome 中加载未打包扩展。
   - 打开 `chrome://extensions`。
   - 开启 Developer mode。
   - 点击 Load unpacked，选择本仓库的 `extension/` 目录。
   - 复制生成的扩展 ID，例如 `lpemchcojepfkbgjgoehfknibdjjppig`。

2. 用该扩展 ID 安装 Native Messaging host。

   macOS / Linux：

   ```bash
   ./scripts/install-native-host-unix.sh <extension-id>
   ```

   如果要注册到其他 Chromium 浏览器，可以传入 `--browser chromium`、`--browser brave`、`--browser edge` 或 `--browser all`。

   `scripts/install-native-host-macos.sh` 只是兼容入口，会转发到 `install-native-host-unix.sh`。

   Windows：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host-win.ps1 <extension-id>
   ```

   该脚本通过 `HKCU` 安装到当前用户，不需要管理员权限。

   在 macOS 上，安装器会把 native host 运行文件复制到 `~/Library/Application Support/Browser Agent Bridge/`，并让 Native Messaging manifest 指向这个位置。在 Windows 上，安装器会把运行文件复制到 `%LOCALAPPDATA%\Browser Agent Bridge\`，并让注册表/manifest 指向这个位置。这样 Native Messaging 不再依赖 release 下载或解压目录。

3. 验证连接。
   - 在 `chrome://extensions` 中重新加载扩展。
   - 打开扩展侧边栏，同意初始提示，然后点击 Start Bridge。
   - 侧边栏状态应显示 Connected。
   - 运行 `python3 scripts/doctor.py --skip-live` 检查平台相关的 Native Messaging 注册状态。

### 使用 Agent 执行安装

本地 coding agent 从本仓库配置 bridge 时使用这条路径。

1. 用户仍然需要在 Chrome 中手动加载未打包扩展：
   - 打开 `chrome://extensions`。
   - 开启 Developer mode。
   - 加载本仓库的 `extension/` 目录。
   - `extension/manifest.json` 内置固定 `key`，因此扩展 ID 是稳定的。

2. 让 Agent 安装 Browser Agent Bridge skill，便于后续会话自动使用。

   可以把本仓库的 skill 目录复制或软链到 Agent 的 skills 目录：

   ```bash
   mkdir -p ~/.codex/skills
   ln -s "$(pwd)/skills/browser-agent-bridge" ~/.codex/skills/browser-agent-bridge
   ```

   skill 目录内包含一份从仓库顶层 `scripts/` 复制过去的 `scripts/` 快照。这份快照用于离线参考和新鲜度检查；当本仓库可用时，Agent 应优先从仓库根目录执行顶层 `scripts/` 下的脚本。

   如果目标路径已存在，只有在现有版本是最新时才保留；否则替换为本仓库的 `skills/browser-agent-bridge/` 目录。这一步会写入仓库外路径，受沙箱限制的 Agent 应在执行前申请提升权限。

   安装 skill 后，重启 Agent 会话，让它发现新的 `browser-agent-bridge` 指令。

3. 仓库脚本更新后，让 Agent 同步 skill 内的脚本快照：

   ```bash
   scripts/sync-skill-scripts.sh
   ```

   `python3 scripts/doctor.py --skip-live` 如果发现快照缺失或过期，会用 `skill.scripts.snapshot` 给出 warning。如果 skill 已经安装到 `~/.codex/skills`，同步后需要重新复制或重新软链 `skills/browser-agent-bridge/`。

4. 让 Agent 在仓库根目录先执行诊断：

   ```bash
   python3 scripts/doctor.py --skip-live
   ```

5. 让 Agent 在安装 native host 前读取 `extension/manifest.json`，确认稳定扩展 ID。

   当前稳定 ID 是：

   ```text
   lpemchcojepfkbgjgoehfknibdjjppig
   ```

   Agent 可以用下面的命令在本地确认：

   ```bash
   python3 - <<'PY'
import base64
import hashlib
import json
from pathlib import Path
manifest = json.loads(Path("extension/manifest.json").read_text())
pub_key_der = base64.b64decode(manifest["key"])
sha = hashlib.sha256(pub_key_der).hexdigest()
extension_id = "".join(chr(int(char, 16) + 97) for char in sha[:32])
print(extension_id)
PY
   ```

6. 如果 native manifest、wrapper 或 token 文件需要安装或修复，Agent 应使用稳定扩展 ID 执行 `scripts/` 下的平台安装脚本。

   macOS / Linux：

   ```bash
   ./scripts/install-native-host-unix.sh lpemchcojepfkbgjgoehfknibdjjppig
   ```

   Windows：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host-win.ps1 lpemchcojepfkbgjgoehfknibdjjppig
   ```

   这些安装脚本会写入仓库外的位置，例如 `~/.browser-agent-bridge.env`、浏览器 Native Messaging manifest 目录，或 Windows `HKCU` 注册表项。在受沙箱限制的 Agent 环境中，Agent 应在执行前申请提升权限。

7. 用户在 `chrome://extensions` 中重新加载扩展，打开侧边栏，同意初始扩展权限申请，并点击 Start Bridge。

8. 让 Agent 验证连接：

   ```bash
   python3 scripts/doctor.py --skip-live
   scripts/browser_bridge_client.py health
   ```

平台诊断：

- macOS：检查 `~/Library/Application Support/.../NativeMessagingHosts/` 下 Chrome、Chromium、Brave、Edge 的用户级 manifest 路径。
- Linux：检查 `~/.config/.../NativeMessagingHosts/` 下 Chrome、Chromium、Brave、Edge 的用户级 manifest 路径。
- Windows：检查 `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.local.browser_agent_bridge`，以及该注册表项默认值指向的 manifest 路径。

如果 doctor 报告 `package.freshness` warning，表示发布包里的扩展目录比扩展源码旧。这不影响本地加载未打包扩展开发；发布前重新构建 release 包即可。

## 本地认证

系统默认开启本地 token 认证，用于防止未授权的本地进程控制浏览器。

安装脚本会生成 token 文件：

- macOS/Linux：`~/.browser-agent-bridge.env`
- Windows：`%USERPROFILE%\.browser-agent-bridge.env`

macOS/Linux shell 命令可这样加载：

```bash
source ~/.browser-agent-bridge.env
```

Windows 下 Python client 会自动读取 `%USERPROFILE%\.browser-agent-bridge.env`。手动 PowerShell 调用可这样加载：

```powershell
$env:BROWSER_AGENT_BRIDGE_TOKEN = (Get-Content "$env:USERPROFILE\.browser-agent-bridge.env" | Where-Object { $_ -like 'BROWSER_AGENT_BRIDGE_TOKEN=*' }).Split('=', 2)[1]
```

通过 HTTP 或 WebSocket 调用认证接口时，需要包含：

```text
Authorization: Bearer <your-token>
```

## 快速开始

推荐使用 `scripts/browser_bridge_client.py` 中的 `BrowserBridgeClient`。它会在 macOS、Linux、Windows 上自动读取默认 token 文件。

### 手动使用

```python
import sys
sys.path.append("./scripts")
from browser_bridge_client import BrowserBridgeClient

client = BrowserBridgeClient()

res = client.rpc("session.start", {"name": "Test Session", "url": "https://example.com"})
session_id = res["session"]["id"]
tab_id = res["tab"]["id"]

client.rpc("page.waitForLoad", {"tabId": tab_id})
text = client.rpc("page.readText", {"tabId": tab_id})
tree = client.rpc("page.accessibilityTree", {"tabId": tab_id})

client.rpc("session.stop", {"sessionId": session_id})
```

直接 HTTP 调用示例：

```bash
source ~/.browser-agent-bridge.env

curl -X POST http://127.0.0.1:8765/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BROWSER_AGENT_BRIDGE_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": "start-session",
    "method": "session.start",
    "params": {"url": "https://example.com"}
  }'
```

内置辅助脚本：

```bash
python3 scripts/doctor.py
scripts/rpc.sh '{"jsonrpc":"2.0","id":"1","method":"session.start","params":{"url":"https://example.com"}}'
python3 scripts/browser_bridge_client.py health
python3 scripts/browser_bridge_client.py rpc session.get '{"sessionId":"SESSION_ID"}'
node scripts/ws-rpc.js --listen
```

### Agent 使用

安装完成并启用 `browser-agent-bridge` skill 后，Agent 可以结合 skill 指令和内置辅助脚本使用 bridge，而不需要手写 HTTP 请求：

```bash
scripts/browser_bridge_client.py health
scripts/browser_bridge_client.py rpc session.start '{"url":"https://example.com"}'
scripts/browser_bridge_client.py rpc page.readText '{"tabId":123}'
```

执行站点级浏览或抓取任务时，Agent 应该：

1. 先调用 `session.start` 创建隔离的 Agent 标签组，或对已有 Agent session 调用 `session.get`。
2. 优先使用只读方法，例如 `page.readText`、`page.accessibilityTree` 和 `dom.query`。
3. 仅在必要时使用 `page.executeJavaScript`、`dom.*` 或 `computer.*`。
4. 尊重运行时审批。侧边栏未打开时，扩展会打开审批弹窗。
5. 将可复用的站点 selector、等待条件、提取逻辑、CSP 需求和坑点记录到 `runtime/site-patterns/{domain}.md`。

只有侧边栏里的 bridge 控制处于 Start 状态时，本地 HTTP/WebSocket bridge 才可用。如果用户点击 Stop Bridge，`scripts/browser_bridge_client.py health` 等辅助脚本会失败，直到用户再次点击 Start Bridge。

## JSON-RPC 接口摘要

| 分类 | 方法 | 说明 |
| :--- | :--- | :--- |
| System | `extension.info` | 获取扩展版本和配置。 |
| System | `extension.reload` | 重新加载扩展后台。 |
| System | `native.status` | 获取 native host 进程状态。 |
| Tabs | `tabs.list` | 列出浏览器标签页。 |
| Tabs | `tabs.create` | 创建浏览器标签页。 |
| Tabs | `tabs.activate` | 激活并聚焦标签页。 |
| Tabs | `tabs.close` | 关闭标签页。 |
| Session | `session.start` | 创建隔离工作区。 |
| Session | `session.list` | 列出活跃会话。 |
| Session | `session.get` | 获取会话详情。 |
| Session | `session.stop` | 关闭会话工作区。 |
| Page | `page.navigate` | 导航到 URL。 |
| Page | `page.readText` | 提取页面可见文本。 |
| Page | `page.accessibilityTree` | 获取结构化无障碍树。 |
| Page | `page.screenshot` | 截取页面截图。 |
| Page | `page.domSnapshot` | 获取 CDP DOM 快照。 |
| Interactive | `dom.click` | 通过 CSS selector 点击。 |
| Interactive | `dom.type` | 向 selector 对应元素输入文本。 |
| Interactive | `computer.click` | 按视口坐标点击。 |
| Interactive | `computer.key` | 发送组合键。 |
| Interactive | `computer.scroll` | 按像素偏移滚动。 |
| Recording | `recording.start` | 开始工作流录制。 |
| Recording | `recording.stop` | 停止工作流录制。 |

## 项目路径

- 扩展目录：`extension/`
- Native host：`native/host.py`
- Native manifest 模板：`native/com.local.browser_agent_bridge.json`
- macOS/Linux 安装器：`scripts/install-native-host-unix.sh`
- 旧 macOS 兼容入口：`scripts/install-native-host-macos.sh`
- Windows 安装器：`scripts/install-native-host-win.ps1`
- Windows 启动器：`native/host-wrapper.win.bat`
- 诊断工具：`scripts/doctor.py`
- 发布包构建：`scripts/build-release.sh`

## 安全与隐私

- 浏览器标签页读取和控制被隔离在 Agent 托管的标签组内。目标在 Agent 标签组外的调用会被直接拒绝。
- Agent 边界内的敏感操作，以及下载记录和策略修改等操作，仍按运行时授权机制处理；已限定在 Agent 托管标签组内的操作可免额外授权。
- 如果侧边栏未打开，敏感调用会触发 Chrome 通知，并打开扩展审批弹窗。
- Native Messaging host 默认不会自动启动。用户需要在侧边栏点击 Start Bridge 来运行它，点击 Stop Bridge 会断开连接并暂停自动重连。
- 工作流录制默认会对输入文本脱敏，除非显式使用 `includeText: true`。
- 默认策略禁止自动化 `chrome://*`、`chrome-extension://*` 和 Chrome Web Store 页面。
