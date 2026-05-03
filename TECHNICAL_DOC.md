# TraeCN-to-Feishu 技术文档

## 目录

1. [架构概览](#1-架构概览)
2. [核心模块详解](#2-核心模块详解)
3. [消息流转全链路](#3-消息流转全链路)
4. [模型提供者体系](#4-模型提供者体系)
5. [飞书适配器](#5-飞书适配器)
6. [流式输出机制](#6-流式输出机制)
7. [权限管理](#7-权限管理)
8. [模式检测与多模型调度](#8-模式检测与多模型调度)
9. [存储层](#9-存储层)
10. [API Server](#10-api-server)
11. [安全设计](#11-安全设计)
12. [配置系统](#12-配置系统)
13. [日志系统](#13-日志系统)
14. [部署与运维](#14-部署与运维)

---

## 1. 架构概览

### 1.1 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        飞书 (Lark)                          │
│                   IM Platform / User Side                   │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket (长连接)
                       │ @larksuiteoapi/node-sdk WSClient
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  桥接守护进程 (Bridge Daemon)                 │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ FeishuAdapter│  │ BridgeManager│  │   API Server     │  │
│  │  (消息收发)   │  │  (编排调度)   │  │  (端口3100)      │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                     │            │
│  ┌──────┴───────┐  ┌──────┴───────┐            │            │
│  │ DeliveryLayer│  │ Conversation │            │            │
│  │  (投递/重试)  │  │   Engine     │            │            │
│  └──────────────┘  └──────┬───────┘            │            │
│                           │                     │            │
│              ┌────────────┴────────────┐        │            │
│              │    AutoLLMProvider      │        │            │
│              │  (自动降级调度)           │        │            │
│              └───┬────────────────┬────┘        │            │
│                  │                │              │            │
│     ┌────────────▼──────┐ ┌──────▼───────────┐  │            │
│     │ExtensionLLMProvider│ │WindowLLMProvider │  │            │
│     │  (HTTP API主路径)   │ │(窗口自动化降级)   │  │            │
│     └────────┬──────────┘ └──────┬───────────┘  │            │
│              │                   │              │            │
│  ┌───────────┴───────────────────┴──────────────┴──────────┐ │
│  │                    JsonFileStore                        │ │
│  │              (JSON文件持久化存储)                         │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                       │                       │
          HTTP API (端口3000)          pywinauto (键盘模拟)
                       │                       │
                       ▼                       ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│    Trae CN 扩展端点       │  │     Trae CN 窗口             │
│  (本地HTTP/SSE服务)       │  │   (pywinauto自动化)          │
└──────────────────────────┘  └──────────────────────────────┘
```

### 1.2 设计原则

| 原则 | 实现方式 |
|------|---------|
| 依赖注入 (DI) | `BridgeContext` 通过 `globalThis` 注入，所有模块通过 `getBridgeContext()` 获取依赖 |
| 接口抽象 | `LLMProvider`、`BridgeStore`、`PermissionGateway` 等核心接口定义在 `host.ts` |
| 自动降级 | `AutoLLMProvider` 优先Extension API，失败3次后降级到窗口自动化 |
| 最小依赖 | 仅依赖 `@larksuiteoapi/node-sdk`，零外部HTTP框架 |
| 零数据库 | JSON文件持久化，无需安装数据库 |

### 1.3 目录结构

```
src/
├── core/                    # 核心抽象层
│   ├── types.ts             # 共享类型定义
│   ├── host.ts              # 接口定义 (LLMProvider, BridgeStore等)
│   ├── context.ts           # DI容器
│   ├── bridge-manager.ts    # 桥接编排器 (消息流转总控)
│   ├── conversation-engine.ts # 对话引擎 (SSE流消费)
│   ├── delivery-layer.ts    # 消息投递 (分块/重试/去重)
│   ├── permission-broker.ts # 权限代理 (飞书卡片权限)
│   ├── mode-detector.ts     # 上下文感知模式检测
│   └── security/
│       └── validators.ts    # 输入校验
├── feishu/                  # 飞书适配层
│   ├── feishu-adapter.ts    # 飞书消息收发 + 流式编辑
│   └── feishu-markdown.ts   # Markdown→飞书格式转换
├── providers/               # 模型提供者
│   ├── auto-provider.ts     # 自动降级调度
│   ├── extension-provider.ts # Extension API (HTTP)
│   └── window-provider.ts   # 窗口自动化 (pywinauto)
├── api-server.ts            # 本地HTTP API Server
├── config.ts                # 配置管理
├── store.ts                 # JSON文件存储实现
├── logger.ts                # 日志 (密钥脱敏)
├── sse-utils.ts             # SSE事件格式化
└── main.ts                  # 守护进程入口
scripts/
├── trae_window.py           # 窗口注入脚本
└── trae_monitor.py          # 响应监控脚本
```

---

## 2. 核心模块详解

### 2.1 类型系统 (`types.ts` + `host.ts`)

类型系统分为两层：

- **`types.ts`**：数据传输对象 (DTO)，定义消息、通道、SSE事件等结构
- **`host.ts`**：接口契约，定义 `LLMProvider`、`BridgeStore`、`PermissionGateway` 等抽象

**核心类型关系：**

```
InboundMessage                    OutboundMessage
├── messageId                     ├── address: ChannelAddress
├── address: ChannelAddress       ├── text: string
├── text: string                  ├── parseMode: 'HTML'|'Markdown'|'plain'
├── timestamp: number             ├── inlineButtons: InlineButton[][]
├── callbackData?: string         └── replyToMessageId?: string
└── attachments?: FileAttachment

ChannelBinding                    BridgeSession
├── id: string                    ├── id: string
├── channelType: string           ├── working_directory: string
├── chatId: string                ├── model: string
├── sessionId: string             └── system_prompt?: string
├── workingDirectory: string
├── model: string
└── mode: 'code'|'plan'|'ask'
```

**`LLMProvider` 接口：**

```typescript
interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}
```

所有模型提供者（Extension、Window、Auto）都实现此接口。`streamChat` 返回一个 `ReadableStream<string>`，内容为SSE格式文本流：

```
event: text
data: "Hello"

event: tool_use
data: {"id":"tool_1","name":"read_file","status":"running"}

event: permission_request
data: {"permissionRequestId":"perm_123","toolName":"write_file"}

event: result
data: {"text":"...","tokenUsage":{...}}

event: done
data: ""
```

### 2.2 DI容器 (`context.ts`)

采用 `globalThis` 单例模式实现轻量级DI：

```typescript
interface BridgeContext {
  store: BridgeStore;        // 持久化存储
  llm: LLMProvider;          // 模型提供者
  permissions: PermissionGateway;  // 权限网关
  lifecycle: LifecycleHooks;       // 生命周期钩子
}
```

- `initBridgeContext(ctx)` — 在 `main.ts` 启动时调用一次
- `getBridgeContext()` — 所有模块通过此函数获取依赖，无需传参

**为什么不用第三方DI框架？** 本项目依赖关系简单且固定（4个核心依赖），使用 `globalThis` 单例足以满足需求，避免引入额外依赖。

---

## 3. 消息流转全链路

### 3.1 入站消息流（飞书 → Trae CN）

```
用户在飞书发消息
    │
    ▼
FeishuAdapter (WSClient长连接接收)
    │ 解析消息内容、去重、鉴权
    ▼
FeishuAdapter.enqueue() → 消息队列
    │
    ▼
BridgeManager.runMessageLoop() → consumeOne()
    │
    ▼
BridgeManager.handleMessage()
    ├── 1. 审计日志
    ├── 2. 回调数据处理 (权限按钮点击)
    ├── 3. 命令解析 (/mode, /model, /help, /perm)
    ├── 4. 模式检测 (detectMode)
    ├── 5. resolveBinding() → 获取/创建ChannelBinding
    └── 6. processWithSessionLock() → 会话锁保证串行
         │
         ▼
    ConversationEngine.processMessage()
         ├── 获取会话锁 (acquireSessionLock)
         ├── 记录用户消息 (addMessage)
         ├── 构建对话历史 (getMessages, limit=50)
         ├── 调用 LLMProvider.streamChat()
         ├── 消费SSE流 (consumeStream)
         │    ├── text事件 → onPartialText → FeishuAdapter.onStreamText()
         │    ├── tool_use事件 → onToolEvent → 更新工具进度
         │    └── permission_request → onPermissionRequest → PermissionBroker
         └── 记录AI响应 (addMessage)
              │
              ▼
    DeliveryLayer.deliver()
         ├── 去重检查 (checkDedup)
         ├── 文本分块 (chunkText, 飞书限制30000字符)
         ├── 逐块发送 (sendWithRetry, 最多3次重试)
         └── 审计日志
```

### 3.2 出站消息流（Trae CN → 飞书）

**Extension API路径：**

```
ExtensionLLMProvider.streamChat()
    │
    ├── HTTP POST → Trae CN本地API (端口3000) /api/send-to-trae
    │    Body: { message, model, workingDirectory }
    │
    └── 轮询 GET → /api/response/:sessionId (每2秒一次, 最多150次)
         │
         ▼
    返回SSE流 → ConversationEngine消费
```

**窗口自动化路径：**

```
WindowLLMProvider.streamChat()
    │
    ├── execPython(trae_window.py, [message])
    │    → pywinauto定位Trae窗口 → 粘贴消息 → 回车发送
    │
    └── execPython(trae_monitor.py, [timeout])
         → 监控Trae响应区域文本变化 → 返回响应
```

### 3.3 会话绑定机制

每个飞书聊天（chatId）绑定一个 `ChannelBinding`，包含：

- `sessionId` — 对话会话ID，关联消息历史
- `sdkSessionId` — Trae CN SDK会话ID（用于续接对话）
- `workingDirectory` — 工作目录
- `model` — 当前模型
- `mode` — 当前模式 (code/plan/ask)

首次消息时自动创建绑定，后续消息复用同一绑定。

---

## 4. 模型提供者体系

### 4.1 AutoLLMProvider（自动降级）

```
AutoLLMProvider
├── extensionProvider: ExtensionLLMProvider  (主路径)
├── windowProvider: WindowLLMProvider        (降级路径)
├── activeProvider: 'extension' | 'window'
├── failCount: number                        (连续失败计数)
└── COOLDOWN_MS = 5 * 60 * 1000             (冷却期5分钟)
```

**降级策略：**

1. 默认使用 Extension API
2. Extension 连续失败 3 次 → 切换到窗口自动化
3. 冷却期 5 分钟后 → 自动重试 Extension
4. 单次请求中 Extension 流失败 → 立即降级到窗口自动化处理该请求

### 4.2 ExtensionLLMProvider

通过HTTP与Trae CN本地API通信：

| 步骤 | 方法 | 端点 | 说明 |
|------|------|------|------|
| 发送消息 | POST | `/api/send-to-trae` | 将用户消息转发到Trae CN |
| 轮询响应 | GET | `/api/response/:sessionId` | 每2秒轮询一次，最多150次（5分钟） |

**请求超时**：单次HTTP请求120秒，总轮询时间最长5分钟。

### 4.3 WindowLLMProvider

通过Python脚本实现窗口自动化：

| 步骤 | 脚本 | 说明 |
|------|------|------|
| 注入消息 | `trae_window.py` | pywinauto定位Trae窗口 → 剪贴板粘贴 → 回车 |
| 监控响应 | `trae_monitor.py` | 轮询Trae响应区域文本变化 |

**限制**：
- 仅Windows平台
- 需要Trae CN窗口在前台可见
- 依赖pywinauto和pyperclip

---

## 5. 飞书适配器

### 5.1 消息接收

使用 `@larksuiteoapi/node-sdk` 的 `WSClient` 长连接模式接收消息：

```typescript
wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => { ... },
    'card.action.trigger': async (data) => { ... },
  })
});
```

**消息处理流程：**

1. **去重**：`seenMessageIds` Map 缓存最近1000条消息ID
2. **过滤**：忽略非用户消息和机器人自身消息
3. **解析**：支持text和post两种消息类型，提取纯文本
4. **@提及清理**：移除@机器人的mention标记
5. **鉴权**：检查用户是否在白名单内
6. **附件处理**：下载图片等附件（通过 `im.messageResource.get`）

### 5.2 消息发送

根据内容复杂度选择发送方式：

```
hasComplexMarkdown(text)?
    ├── Yes → 发送交互式卡片 (msg_type: 'interactive')
    │         buildCardContent() → { schema: '2.0', body: { elements: [{ tag: 'markdown' }] } }
    │
    └── No  → 发送富文本帖子 (msg_type: 'post')
              buildPostContent() → { zh_cn: { content: [[{ tag: 'md' }]] } }
```

**复杂Markdown判定**：包含代码块（\`\`\`）或表格（`|...|`）。

### 5.3 飞书Markdown预处理

`preprocessFeishuMarkdown()` 处理飞书卡片Markdown的已知问题：
- 代码块前必须换行：`text.replace(/([^\n])```/g, '$1\n```')`

`htmlToFeishuMarkdown()` 将HTML转换为飞书兼容Markdown：
- `<b>` → `**bold**`
- `<code>` → `` `code` ``
- HTML实体解码

---

## 6. 流式输出机制

### 6.1 消息编辑模拟

飞书不支持真正的流式输出，通过**消息编辑API**模拟：

```
AI开始生成
    │
    ▼
创建新消息 (im.message.create)
    │ 内容: "正在思考..."
    │
    ▼ (每500ms)
编辑消息 (im.message.patch)
    │ 内容: 逐步追加AI生成的文本
    │
    ▼
AI生成完成
    │
    ▼
最终编辑 (im.message.patch)
    │ 内容: 完整AI响应
```

### 6.2 EditPreviewState

```typescript
interface EditPreviewState {
  chatId: string;
  messageId: string;          // 已创建的消息ID（用于后续编辑）
  lastSentText: string;       // 上次发送的文本
  lastSentAt: number;         // 上次发送时间戳
  throttleTimer: Timer|null;  // 节流定时器
  pendingText: string;        // 待发送的最新文本
  activeTools: ToolCallInfo[];// 当前工具调用状态
}
```

**节流策略**：
- 最小编辑间隔：500ms (`EDIT_THROTTLE_MS`)
- 如果距离上次编辑不足500ms，设置定时器延迟发送
- 新文本到达时取消旧定时器，更新 `pendingText`

### 6.3 流式卡片

当有工具调用时，使用 `buildStreamingCard()` 渲染带工具进度的卡片：

```json
{
  "schema": "2.0",
  "header": {
    "title": { "tag": "plain_text", "content": "🤖 Trae AI" },
    "template": "blue"
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "🔄 `read_file`\n✅ `write_file`" },
      { "tag": "hr" },
      { "tag": "markdown", "content": "AI生成的文本内容..." }
    ]
  }
}
```

### 6.4 Typing指示器

- `onMessageStart()` — 在用户消息上添加 ⌨️ 表情回应
- `onMessageEnd()` — 删除表情回应

---

## 7. 权限管理

### 7.1 权限请求流程

```
Trae CN AI请求权限 (SSE: permission_request事件)
    │
    ▼
PermissionBroker.forwardPermissionRequest()
    │ 构建权限说明文本
    │ 创建飞书交互卡片 (含Allow/Allow Session/Deny按钮)
    ▼
飞书用户点击按钮
    │
    ▼
FeishuAdapter.handleCardAction()
    ├── 更新卡片状态 (buildResolvedPermissionCard)
    │   Allow → 绿色卡片 "✅ Permission Allowed"
    │   Deny  → 红色卡片 "❌ Permission Denied"
    └── 生成callbackData消息 → BridgeManager
         │
         ▼
    PermissionBroker.handlePermissionCallback()
         ├── 验证callbackData格式 (perm:action:id)
         ├── 检查权限链接是否有效
         ├── 标记为已解决 (markPermissionLinkResolved)
         └── 调用 permissions.resolvePendingPermission()
```

### 7.2 权限卡片结构

```json
{
  "schema": "2.0",
  "header": {
    "title": "⚠️ Permission Required",
    "template": "orange"
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "Tool: write_file\nInput: {...}" },
      { "tag": "hr" },
      {
        "tag": "column_set",
        "columns": [
          { "tag": "button", "text": "✅ Allow", "type": "primary", "value": { "callback_data": "perm:allow:id123" } },
          { "tag": "button", "text": "🔓 Allow Session", "type": "default", "value": { "callback_data": "perm:allow_session:id123" } },
          { "tag": "button", "text": "❌ Deny", "type": "danger", "value": { "callback_data": "perm:deny:id123" } }
        ]
      }
    ]
  }
}
```

### 7.3 权限命令

除了点击按钮，也可以通过文本命令：

```
/perm allow <permissionRequestId>     — 批准一次
/perm allow_session <permissionRequestId>  — 批准本次会话
/perm deny <permissionRequestId>      — 拒绝
```

---

## 8. 模式检测与多模型调度

### 8.1 上下文感知模式检测 (`mode-detector.ts`)

基于关键词评分的轻量级模式检测：

```typescript
detectMode(text: string, currentMode: BridgeMode): ModeDetectionResult
```

**关键词分类：**

| 模式 | 关键词示例 | 含义 |
|------|-----------|------|
| code | 写、实现、修复、修改、bug、重构、测试 | AI可读写执行代码 |
| plan | 计划、规划、方案、设计、架构、如何 | AI先规划再审批 |
| ask | 解释、什么是、为什么、帮助、文档 | 仅问答不修改代码 |

**评分算法：**

```
planScore = count(text ∩ PLAN_KEYWORDS)
askScore  = count(text ∩ ASK_KEYWORDS)
codeScore = count(text ∩ CODE_KEYWORDS)

confidence = maxScore / (totalScore + 1)  // +1避免除零

if confidence > 0.5 && detectedMode != currentMode:
    切换模式
```

**仅在 `code` 模式下启用自动检测**（`shouldAutoDetect(binding)` 返回 `binding.mode === 'code'`），避免在用户已手动选择 plan/ask 时被覆盖。

### 8.2 多模型调度

通过飞书命令切换模型：

```
/model claude-3.5-sonnet
/model gpt-4o
```

切换后模型名持久化到 `BridgeSession.model`，后续请求自动使用新模型。

### 8.3 模式切换命令

```
/mode code  → 💻 Code Mode — AI can read, write, and execute code
/mode plan  → 📋 Plan Mode — AI plans first, then asks for approval
/mode ask   → ❓ Ask Mode — AI answers questions without code changes
```

模式持久化到 `ChannelBinding.mode`。

---

## 9. 存储层

### 9.1 JsonFileStore

基于JSON文件的持久化存储，数据目录：`~/.traecn-to-feishu/data/`

**文件结构：**

```
~/.traecn-to-feishu/
├── config.env              # 配置文件
├── data/
│   ├── sessions.json       # 会话数据
│   ├── bindings.json       # 通道绑定
│   ├── permissions.json    # 权限链接
│   ├── offsets.json        # 消息偏移量
│   ├── dedup.json          # 去重键
│   ├── audit.json          # 审计日志
│   └── messages/
│       ├── <sessionId>.json  # 每个会话的消息历史
│       └── ...
└── logs/
    ├── bridge.log          # 当前日志
    ├── bridge.log.1        # 轮转日志
    └── ...
```

### 9.2 写入安全

- **原子写入**：先写 `.tmp` 文件，再 `fs.renameSync` 替换，防止写入中断导致数据损坏
- **会话锁**：`acquireSessionLock()` / `releaseSessionLock()` 防止并发处理同一会话
  - 锁有TTL（默认600秒），自动过期
  - 处理过程中每60秒续约一次

### 9.3 数据清理

- **去重键**：`cleanupExpiredDedup()` 清理24小时前的去重记录
- **审计日志**：超过10000条时裁剪到5000条
- **消息ID缓存**：超过1000条时裁剪

---

## 10. API Server

### 10.1 概述

桥接守护进程启动时在端口3100启动HTTP API Server，用于：
1. 接收Trae CN扩展回传的AI响应
2. 提供健康检查和状态查询
3. 支持外部程序发送消息到Trae CN

### 10.2 端点详情

| 端点 | 方法 | 请求体 | 响应 | 说明 |
|------|------|--------|------|------|
| `/health` | GET | — | `{ status, running, startedAt, adapters }` | 健康检查 |
| `/api/config` | GET | — | `{ status }` | 配置状态 |
| `/api/send-to-trae` | POST | `{ message, model?, workingDirectory? }` | `{ success, message }` | 转发消息到Trae |
| `/api/ai-response` | POST | `{ session_id, content, user_message_id? }` | `{ success }` | Trae回传AI响应 |
| `/api/response/:id` | GET | — | `{ success, content }` | 轮询获取响应 |
| `/api/status` | GET | — | `{ running, startedAt, adapters }` | 桥接状态 |

### 10.3 响应等待机制

API Server内部使用 `Promise` + `Map` 实现异步响应等待：

```typescript
const pendingResponses = new Map<string, PendingResponse>();

// Extension Provider 发送消息后轮询
waitForResponse(sessionId) → Promise<string>
    // 创建Promise，存入Map，设置120秒超时定时器

// Trae CN扩展回传响应时
registerResponse(sessionId, text)
    // 从Map取出Promise，resolve(text)，清除定时器
```

### 10.4 认证

- 可选的Token认证：在 `config.env` 中设置 `CTI_BRIDGE_API_TOKEN`
- 请求时通过 `x-Bridge-Token` Header传递
- 未配置Token时跳过认证

---

## 11. 安全设计

### 11.1 输入校验 (`validators.ts`)

```typescript
sanitizeInput(text: string): string
    // 1. 移除控制字符 (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F)
    // 2. 截断到50000字符

isDangerousInput(text: string): boolean
    // 检测路径遍历 (../) 和命令注入字符 (<>|&;`$)
```

### 11.2 日志脱敏 (`logger.ts`)

自动遮蔽以下敏感信息：

| 模式 | 示例 | 脱敏后 |
|------|------|--------|
| App Secret | `CTI_FEISHU_APP_SECRET=abc123` | `CTI_FEISHU_APP_SECRET=****` |
| Bearer Token | `Bearer eyJhbGci...` | `****` |
| Access Token | `tenant_access_token: abc123` | `tenant_access_token: ****` |

### 11.3 用户白名单

`CTI_FEISHU_ALLOWED_USERS` 配置项限制可交互的飞书用户，逗号分隔的 `open_id` 列表。留空则允许所有人。

### 11.4 消息去重

- `checkDedup(key)` / `insertDedup(key)` — 防止重复处理同一条消息
- 去重键24小时后自动过期
- 投递层也使用去重防止重复发送

---

## 12. 配置系统

### 12.1 配置文件

路径：`~/.traecn-to-feishu/config.env`

格式：`KEY=VALUE`，支持 `#` 注释，支持引号包裹值。

### 12.2 配置项一览

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `CTI_RUNTIME` | `auto` | 运行模式: `window` / `extension` / `auto` |
| `CTI_ENABLED_CHANNELS` | `feishu` | 启用的IM通道 |
| `CTI_DEFAULT_WORKDIR` | `process.cwd()` | 默认工作目录 |
| `CTI_DEFAULT_MODEL` | — | 默认AI模型 |
| `CTI_DEFAULT_MODE` | `code` | 默认模式 |
| `CTI_FEISHU_APP_ID` | — | 飞书应用App ID（必填） |
| `CTI_FEISHU_APP_SECRET` | — | 飞书应用App Secret（必填） |
| `CTI_FEISHU_DOMAIN` | `feishu` | 飞书域名: `feishu`(国内) / `lark`(海外) |
| `CTI_FEISHU_ALLOWED_USERS` | — | 允许的用户open_id列表 |
| `CTI_FEISHU_CHAT_ID` | — | 默认飞书聊天ID |
| `CTI_MESSAGE_TIMEOUT_FIRST` | `20000` | 首次超时(ms) |
| `CTI_MESSAGE_TIMEOUT_RETRY` | `20000` | 重试超时(ms) |
| `CTI_TRAE_MSG_SUFFIX` | — | 追加到Trae消息的后缀 |
| `CTI_AUTO_APPROVE` | `false` | 自动批准权限请求 |

### 12.3 配置加载流程

```
main.ts
    │
    ▼
loadConfig()
    ├── 尝试读取 config.env
    ├── 解析 KEY=VALUE 格式
    ├── 应用默认值
    └── 返回 Config 对象
    │
    ▼
configToSettings(config)
    └── 转换为 Map<string, string> 供 JsonFileStore 使用
```

---

## 13. 日志系统

### 13.1 日志格式

```
[2025-01-15T10:30:45.123Z] [info] [feishu-adapter] Started (botOpenId: ou_xxx)
[2025-01-15T10:30:46.456Z] [warn] [auto-provider] Extension failed (fail count: 2)
[2025-01-15T10:30:47.789Z] [error] [bridge-manager] Message handling error: timeout
```

### 13.2 日志轮转

- 单文件最大 10MB (`MAX_LOG_SIZE`)
- 最多保留 5 个轮转文件 (`MAX_LOG_FILES`)
- 轮转命名：`bridge.log` → `bridge.log.1` → `bridge.log.2` → ...

### 13.3 日志级别

| 级别 | 输出位置 | 用途 |
|------|---------|------|
| debug | 文件 | 调试信息 |
| info | 文件 | 正常运行信息 |
| warn | 文件 + stderr | 警告 |
| error | 文件 + stderr | 错误 |

---

## 14. 部署与运维

### 14.1 构建与运行

```powershell
# 安装依赖
npm install

# 开发模式
npm run dev

# 生产构建
npm run build

# 生产运行
npm start
```

### 14.2 健康检查

```powershell
# 检查守护进程状态
curl http://127.0.0.1:3100/health

# 响应示例
{
  "status": "ok",
  "running": true,
  "startedAt": "2025-01-15T10:30:00.000Z",
  "adapters": [{
    "channelType": "feishu",
    "running": true,
    "connectedAt": "2025-01-15T10:30:00.000Z",
    "lastMessageAt": null,
    "error": null
  }]
}
```

### 14.3 日志查看

```powershell
# 查看最新日志
Get-Content "$env:USERPROFILE\.traecn-to-feishu\logs\bridge.log" -Tail 50

# 实时跟踪日志
Get-Content "$env:USERPROFILE\.traecn-to-feishu\logs\bridge.log" -Wait -Tail 20
```

### 14.4 数据目录

```
%USERPROFILE%\.traecn-to-feishu\
├── config.env           # 配置
├── data\                # 持久化数据
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   ├── offsets.json
│   ├── dedup.json
│   ├── audit.json
│   └── messages\
└── logs\                # 日志
    ├── bridge.log
    └── bridge.log.1
```

可通过环境变量 `CTI_HOME` 覆盖数据根目录。

### 14.5 故障排查

| 问题 | 排查步骤 |
|------|---------|
| 飞书收不到消息 | 检查 App ID/Secret 是否正确，确认事件订阅已配置长连接 |
| Trae CN无响应 | 检查Trae CN是否运行，窗口自动化模式需Trae在前台 |
| 消息发送失败 | 检查飞书应用权限（im:message:send_as_bot） |
| 权限卡片不显示 | 检查飞书应用是否开启了卡片交互能力 |
| Extension API连接失败 | 检查Trae CN本地API是否在端口3000运行 |
| 自动降级频繁触发 | 检查Extension API可用性，查看日志中fail count |
