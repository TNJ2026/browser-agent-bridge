# Browser Agent Bridge (浏览器 Agent 桥接器)

An unpacked Chrome extension plus Native Messaging host that exposes high-fidelity browser-control tools to a local agent through JSON-RPC over HTTP and WebSocket.

这是一个未打包的 Chrome 浏览器插件及原生消息传递（Native Messaging）宿主程序。它通过 HTTP 和 WebSocket 上的 JSON-RPC 协议，向本地 Agent 暴露高保真的浏览器控制工具。

---

## 📖 Table of Contents / 目录
- [Architecture / 系统架构](#-architecture--系统架构)
- [Key Features / 主要特性](#-key-features--主要特性)
- [Installation / 安装指南](#-installation--安装指南)
- [Authentication / 本地安全认证](#-authentication--本地安全认证)
- [Quick Start & Examples / 快速上手与示例](#-quick-start--examples--快速上手与示例)
- [JSON-RPC API Reference / 接口参考](#-json-rpc-api-reference--接口参考)
- [Security & Privacy / 安全与隐私](#-security--privacy--安全与隐私)

---

## 📐 Architecture / 系统架构

The extension acts as a capabilities provider without containing any agent or model logic. It bridges local software to Chrome's internals:

该插件本身不包含任何 Agent 或模型逻辑，它作为一个纯粹的能力提供者，将本地软件与 Chrome 内部机制相连接：

```mermaid
graph TD
    Agent[Local Agent / 本地智能体] -->|HTTP / WS JSON-RPC| Host[Native Host / python3 native/host.py]
    Host -->|Stdio Native Messaging / 标准输入输出| Ext[Chrome Extension / service-worker.js]
    Ext -->|Chrome APIs & CDP / 浏览器底层 API| Browser[Chrome Browser / 谷歌浏览器]
```

- **HTTP Endpoint**: `http://127.0.0.1:8765/rpc` (For one-shot commands / 用于单次调用)
- **WebSocket Endpoint**: `ws://127.0.0.1:8765/ws` (For long-lived sessions and stream events / 用于长连接和事件流推送)

---

## 🌟 Key Features / 主要特性

- **Native Integration / 原生连接**: Fast and reliable communication via Chrome Native Messaging stdio channel.
- **Tab & Session Isolation / 标签与会话隔离**: Clean sandbox workspace management utilizing Chrome Tab Groups.
- **High-Fidelity Interaction / 高保真页面控制**: Perform clicks, drag-and-drop, scroll, and key combinations via Chrome DevTools Protocol (CDP).
- **Page Inspection / 页面状态感知**: Read full visible texts, capture screenshots, extract DOM snapshots, and retrieve structured accessibility trees.
- **Event Streaming / 实时事件缓冲**: Real-time buffering and access to page console logs and network events.
- **Workflow Recording / 交互录制归档**: Record browser interactions with automatic input-redaction policies to protect passwords and sensitive data.
- **Visual Overlays / 视觉交互高亮**: Dynamic visual indicators overlaid on active elements to trace Agent behavior.

---

## 🛠 Installation / 安装指南

### Prerequisites / 前置条件
- Google Chrome browser (version 116+)
- Python 3.x installed locally

### Step-by-Step Setup / 步骤说明

1. **Load Unpacked Extension / 加载未打包插件**
   - Open Chrome and navigate to `chrome://extensions`.
   - Enable **Developer mode** (右上角开启“开发者模式”).
   - Click **Load unpacked** (点击“加载已解压的扩展程序”) and select the `extension/` directory of this repository.
   - Copy the generated **Extension ID** (复制生成出的插件 ID，例如：`aodcpicfepmdmpfaflncbndcicoemdje`).

2. **Install Native Messaging Host / 安装原生消息宿主**
   Run the installation script with your Extension ID as the argument:
   
   使用复制的插件 ID 作为参数运行对应平台的安装脚本：
   
   - **macOS / Linux**:
     ```bash
     ./scripts/install-native-host-macos.sh <extension-id>
     ```
   - **Windows**:
     Open PowerShell as Administrator and run (以管理员权限打开 PowerShell 运行)：
     ```powershell
     powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host-win.ps1 <extension-id>
     ```


3. **Verify Connection / 验证连接**
   - Reload the extension in `chrome://extensions`.
   - Open the extension side panel. It should display **Connected / 已连接**.

---

## 🔒 Authentication / 本地安全认证

For security, local token authentication is enabled by default to prevent unauthorized local processes from hijacking your browser.

出于安全考虑，系统默认启用了本地 Token 认证，防止本地其他未授权进程篡改或劫持您的浏览器。

> [!IMPORTANT]
> The installation script automatically generates a secure token and saves it in `~/.browser-agent-bridge.env`.
> 
> 安装脚本会自动生成一个安全的随机 Token 并保存在本地的 `~/.browser-agent-bridge.env` 配置文件中。

To execute scripts or client tools, make sure to load this environment file:

运行脚本或客户端工具前，请确保已加载此环境变量文件：
```bash
source ~/.browser-agent-bridge.env
```

All API requests must include the Token in the HTTP/WebSocket headers:

所有的 API 请求都必须在 HTTP/WebSocket 请求头中包含该 Token：
```text
Authorization: Bearer <your-token-here>
```

---

## 🚀 Quick Start & Examples / 快速上手与示例

This bridge exposes a local JSON-RPC server. You can control it using Python, curl, or the built-in scripts.

该桥接器在本地启动了 JSON-RPC 服务。您可以通过 Python、curl 或是项目内置脚本来控制浏览器。

---

### 1. Python SDK Client / Python 客户端调用 (推荐)
The easiest way is to use the built-in `BrowserBridgeClient` in `scripts/browser_bridge_client.py`. It automatically loads your security token from `~/.browser-agent-bridge.env`.

推荐使用 `scripts/browser_bridge_client.py` 中内置的 `BrowserBridgeClient` 客户端，它会自动加载 `~/.browser-agent-bridge.env` 里的安全 Token：

```python
import sys
# Add scripts directory to path / 将 scripts 路径加入系统路径
sys.path.append("./scripts")
from browser_bridge_client import BrowserBridgeClient

# 1. Initialize client (Token loaded automatically) / 初始化客户端（自动读取 Token）
client = BrowserBridgeClient()

# 2. Start an isolated session workspace (creates a Tab Group) / 启动独立隔离会话（创建浏览器标签组）
print("Starting session...")
res = client.rpc("session.start", {"name": "Test Session", "url": "https://example.com"})
session_id = res["session"]["id"]
tab_id = res["tab"]["id"]

# 3. Wait for the page load / 等待网页加载完成
client.rpc("page.waitForLoad", {"tabId": tab_id})

# 4. Extract visible text from the page / 提取网页可视文本
text = client.rpc("page.readText", {"tabId": tab_id})
print("Page text content:", text[:200])

# 5. Extract structured clean accessibility tree / 获取网页无障碍树
tree = client.rpc("page.accessibilityTree", {"tabId": tab_id})
print("Accessibility tree structures loaded.")

# 6. Click an element using a CSS Selector / 通过 CSS 选择器点击元素
# client.rpc("dom.click", {"tabId": tab_id, "selector": "a"})

# 7. Take a screenshot for visual feedback / 对视口进行截图
# client.rpc("page.screenshot", {"tabId": tab_id})

# 8. Clean up and close the session workspace / 销毁并关闭会话工作区
print("Closing session...")
client.rpc("session.stop", {"sessionId": session_id})
```

---

### 2. Direct HTTP curl Command / 通过 curl 接口直接调用
You can perform raw HTTP POST requests to send JSON-RPC commands. Make sure to attach the bearer token.

您也可以直接通过 `curl` 命令行工具进行 JSON-RPC 接口请求。请确保在请求头中附带正确的 Bearer Token。

```bash
# Load token / 载入环境变量
source ~/.browser-agent-bridge.env

# Send a tabs.list request / 获取标签页列表
curl -X POST http://127.0.0.1:8765/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BROWSER_AGENT_BRIDGE_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": "get-tabs",
    "method": "tabs.list",
    "params": {}
  }'
```

---

### 3. Built-in Helper Scripts / 项目内置工具脚本

We provide multiple helper command-line utilities in the `scripts/` folder:

我们提供了一系列实用的终端助手工具：

- **Doctor Diagnostic Utility (运行系统健康诊断)**:
  ```bash
  python3 scripts/doctor.py
  ```
- **Quick HTTP RPC Client (快速 HTTP 接口调用)**:
  ```bash
  source ~/.browser-agent-bridge.env
  scripts/rpc.sh '{"jsonrpc":"2.0","id":"1","method":"tabs.list","params":{}}'
  ```
- **Interactive Python Client (Python 命令行客户端)**:
  ```bash
  # Check health / 获取健康状态
  python3 scripts/browser_bridge_client.py health
  
  # Call arbitrary RPC / 运行任意 RPC
  python3 scripts/browser_bridge_client.py rpc tabs.list '{"query":{"active":true}}'
  ```
- **WebSocket Event Listener & Client (Node.js 实时事件流监听)**:
  ```bash
  # Listen and stream events like console logs or page network events / 持续监听控制台与网络流事件
  node scripts/ws-rpc.js --listen
  ```

---


## 📡 JSON-RPC API Reference / 接口参考

| Category / 分类 | Method / 接口方法 | Description / 说明 |
| :--- | :--- | :--- |
| **System / 系统** | `extension.info` | Get extension version and configuration. / 获取插件版本与配置。 |
| | `extension.reload` | Force reload the extension background. / 强制重载插件后台。 |
| | `native.status` | Get Native host process status. / 获取 Native 进程运行状态。 |
| **Tabs / 标签页** | `tabs.list` | List open browser tabs. / 列出当前浏览器打开的标签页。 |
| | `tabs.create` | Create a new browser tab. / 打开新的标签页。 |
| | `tabs.activate` | Set target tab to active focus. / 激活并聚焦指定标签页。 |
| | `tabs.close` | Close specified tab(s). / 关闭指定的标签页。 |
| **Session / 会话** | `session.start` | Initialize an isolated workspace group. / 创建并初始化一个隔离的会话组。 |
| | `session.list` | List active workspace sessions. / 列出所有活跃的会话。 |
| | `session.get` | Get session details and its tab list. / 获取特定会话详情及标签。 |
| | `session.stop` | Close and teardown a session workspace. / 关闭会话并清除对应工作区。 |
| **Page / 页面动作** | `page.navigate` | Navigate to a specific URL. / 跳转至指定网址。 |
| | `page.readText` | Extract all visible text from the page. / 读取并提取页面上的可视文本。 |
| | `page.accessibilityTree` | Fetch structured clean accessibility tree. / 获取格式化的树状无障碍树。 |
| | `page.screenshot` | Take a high-resolution screenshot. / 对当前可视视口进行高解析度截图。 |
| | `page.domSnapshot` | Retrieve a structured CDP DOM snapshot. / 获取完整的 CDP 结构化 DOM 快照。 |
| **Interactive / 控制**| `dom.click` | Click on an element by its CSS selector. / 通过 CSS 选择器点击网页元素。 |
| | `dom.type` | Insert text into a specific selector. / 通过选择器向输入框内输入文本。 |
| | `computer.click` | Perform click at exact coordinate. / 在指定的屏幕坐标进行鼠标点击。 |
| | `computer.key` | Send keyboard stroke combinations. / 发送组合键盘按键（如 `Ctrl+A`）。 |
| | `computer.scroll` | Scroll by specific pixel offsets. / 按照像素偏移量进行页面滚动。 |
| **Privacy / 录制** | `recording.start` | Start recording user actions. / 开始录制用户与 Agent 操作流程。 |
| | `recording.stop` | Stop current recording session. / 停止并归档当前的录制。 |

---

## 🛡 Security & Privacy / 安全与隐私

- **Sensitive Operations Approval / 敏感操作交互授权**: 
  Actions involving tab listing, screenshot capture, file downloads, or network logs interception require user approval via the side panel. If the side panel is closed, requests will gracefully fail with a prompt asking the user to open it.
  
  涉及标签页列表、截图、文件下载或网络日志拦截等敏感操作时，系统会在侧边栏中弹窗提示用户授权。若侧边栏未打开，操作将被拦截并提示用户开启侧边栏进行确认。

- **Input Redaction / 输入脱敏机制**:
  To protect private data, keyboard entries and typed text are automatically redacted in the workflow recordings unless `includeText: true` is explicitly granted when starting a recording session.
  
  系统默认对键入的字符及输入框内容进行遮蔽。除非在调用 `recording.start` 时显式指定 `includeText: true`，否则在录制流中所有输入细节都将作为 `redacted` 处理，防止密码或隐私泄露。

- **URL Access Control / 域名白名单策略**:
  The default security policy strictly blocks operations on system pages (e.g., `chrome://*`, `chrome-extension://*`, and Google Chrome Web Store).
  
  系统内置安全拦截名单，默认严格禁止对浏览器系统页面、插件后台页面、以及谷歌应用商店执行任何自动化操控。
