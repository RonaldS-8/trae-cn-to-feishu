# TraeCN-to-Feishu

Bridge Trae CN built-in AI models to Feishu (Lark) IM — 在飞书中远程使用 Trae CN 的 AI 能力。

## Features

- **飞书机器人** — 通过飞书聊天窗口与 Trae CN AI 对话
- **流式输出** — 消息编辑模拟实时流式输出，含工具调用进度展示
- **权限管理** — 飞书交互卡片按钮审批 AI 的文件操作权限
- **自动降级** — 优先 Extension API，失败后自动降级到窗口自动化
- **模式检测** — 根据消息内容自动切换 Code / Plan / Ask 模式
- **多模型调度** — 通过命令切换 AI 模型
- **零数据库** — JSON 文件持久化，无需安装数据库

## Architecture

```
Feishu (IM)
    ↕ WebSocket (长连接)
Bridge Daemon (Node.js)
    ↕ HTTP API (主路径: Extension Provider)
    ↕ pywinauto (降级路径: 窗口自动化)
Trae CN (内置模型)
```

## Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| Node.js | ≥ 20.0.0 | Runtime |
| Python | ≥ 3.8 | Window automation fallback (Windows only) |
| pywinauto | latest | Window automation library |
| Feishu App | — | Enterprise self-built app with bot capability |

## Quick Start

### 1. Setup Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and create an enterprise self-built app
2. Add **Bot** capability
3. Grant permissions: `im:message:receive_v1`, `im:message:send_as_bot`, `im:message:update`, `im:message.reaction:create`
4. Configure **Event Subscription** with **Long Connection** mode
5. Note down **App ID** and **App Secret**
6. Get **Chat ID**: Feishu mobile app → bot chat → top-right menu → find Chat ID

### 2. Install & Configure

```powershell
git clone https://github.com/your-username/traecn-to-feishu.git
cd traecn-to-feishu
npm install
```

Create config file at `~/.traecn-to-feishu/config.env`:

```env
# Required
CTI_FEISHU_APP_ID=cli_xxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Runtime mode: auto | extension | window
CTI_RUNTIME=auto

# Default working directory (Trae CN project path)
CTI_DEFAULT_WORKDIR=C:\Users\You\Projects\my-project

# Optional
CTI_FEISHU_CHAT_ID=oc_xxxxxxxxxxxx
CTI_FEISHU_DOMAIN=feishu
CTI_DEFAULT_MODEL=claude-3.5-sonnet
CTI_DEFAULT_MODE=code
```

### 3. Run

```powershell
# Development
npm run dev

# Production
npm run build
npm start
```

## Chat Commands

Send these commands to the bot in Feishu:

| Command | Description |
|---------|-------------|
| `/mode code` | Switch to Code mode (AI can edit files) |
| `/mode plan` | Switch to Plan mode (AI plans first) |
| `/mode ask` | Switch to Ask mode (Q&A only) |
| `/model <name>` | Switch AI model |
| `/perm allow <id>` | Approve permission request |
| `/perm deny <id>` | Deny permission request |
| `/help` | Show help |

**Auto mode detection**: In Code mode, the system automatically detects intent based on keywords:
- "写/实现/修复/修改" → Code mode
- "计划/规划/方案/设计" → Plan mode
- "解释/什么是/为什么/帮助" → Ask mode

## Provider Comparison

| Feature | Extension API (Primary) | Window Automation (Fallback) |
|---------|------------------------|------------------------------|
| Communication | HTTP API (port 3000) | pywinauto keyboard simulation |
| Response | API polling | Window text monitoring |
| Reliability | High | Medium (requires window focus) |
| Requires Python | No | Yes |
| Requires Trae foreground | No | Yes |

## API Server

The bridge daemon starts an HTTP API server on port 3100:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/config` | GET | Config status |
| `/api/send-to-trae` | POST | Forward message to Trae CN |
| `/api/ai-response` | POST | Receive AI response from Trae CN |
| `/api/response/:id` | GET | Poll for response |
| `/api/status` | GET | Bridge status |

## Streaming Output

- **Message edit simulation**: Feishu message updates in real-time during AI generation (throttled at 500ms)
- **Tool progress**: Streaming card shows tool call status (🔄 running / ✅ complete / ❌ error)
- **Typing indicator**: ⌨️ reaction added to user message while processing
- **Permission card**: Interactive card with Allow/Allow Session/Deny buttons, auto-updates on click

## Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `CTI_RUNTIME` | `auto` | Runtime mode: `window` / `extension` / `auto` |
| `CTI_FEISHU_APP_ID` | — | Feishu App ID (**required**) |
| `CTI_FEISHU_APP_SECRET` | — | Feishu App Secret (**required**) |
| `CTI_FEISHU_DOMAIN` | `feishu` | `feishu` (China) or `lark` (International) |
| `CTI_FEISHU_CHAT_ID` | — | Default Feishu chat ID |
| `CTI_FEISHU_ALLOWED_USERS` | — | Comma-separated open_id whitelist |
| `CTI_DEFAULT_WORKDIR` | `cwd` | Default working directory |
| `CTI_DEFAULT_MODEL` | — | Default AI model |
| `CTI_DEFAULT_MODE` | `code` | Default mode: `code` / `plan` / `ask` |
| `CTI_MESSAGE_TIMEOUT_FIRST` | `20000` | First timeout (ms) |
| `CTI_MESSAGE_TIMEOUT_RETRY` | `20000` | Retry timeout (ms) |
| `CTI_TRAE_MSG_SUFFIX` | — | Suffix appended to Trae messages |
| `CTI_AUTO_APPROVE` | `false` | Auto-approve permissions |

## Project Structure

```
traecn-to-feishu/
├── src/
│   ├── core/                    # Core abstractions
│   │   ├── types.ts             # Shared type definitions
│   │   ├── host.ts              # Interface contracts
│   │   ├── context.ts           # DI container
│   │   ├── bridge-manager.ts    # Message orchestration
│   │   ├── conversation-engine.ts # SSE stream consumer
│   │   ├── delivery-layer.ts    # Message delivery (chunk/retry/dedup)
│   │   ├── permission-broker.ts # Permission management
│   │   ├── mode-detector.ts     # Context-aware mode detection
│   │   └── security/validators.ts # Input sanitization
│   ├── feishu/                  # Feishu adapter
│   │   ├── feishu-adapter.ts    # Message send/receive + streaming
│   │   └── feishu-markdown.ts   # Markdown → Feishu format
│   ├── providers/               # Model providers
│   │   ├── auto-provider.ts     # Auto-fallback dispatcher
│   │   ├── extension-provider.ts # Extension API (HTTP)
│   │   └── window-provider.ts   # Window automation (pywinauto)
│   ├── api-server.ts            # Local HTTP API server
│   ├── config.ts                # Configuration management
│   ├── store.ts                 # JSON file storage
│   ├── logger.ts                # Logging with secret masking
│   ├── sse-utils.ts             # SSE event formatting
│   └── main.ts                  # Daemon entry point
├── scripts/
│   ├── trae_window.py           # Window injection script
│   └── trae_monitor.py          # Response monitoring script
├── TECHNICAL_DOC.md             # Detailed technical documentation
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Feishu not receiving messages | Check App ID/Secret, confirm event subscription with long connection |
| Trae CN no response | Ensure Trae CN is running; window mode requires foreground |
| Message send failed | Check Feishu app permissions (`im:message:send_as_bot`) |
| Permission card not showing | Enable card interaction in Feishu app settings |
| Extension API connection failed | Check if Trae CN local API is running on port 3000 |
| Frequent fallback triggers | Check Extension API availability in logs |

## Data Directory

```
~/.traecn-to-feishu/
├── config.env           # Configuration
├── data/                # Persistent data
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/
└── logs/                # Logs (auto-rotated, 10MB/file, max 5 files)
    └── bridge.log
```

Override with `CTI_HOME` environment variable.

## License

MIT
