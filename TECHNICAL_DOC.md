# TraeCN-to-Feishu 技术文档

本文面向想学习本项目实现方式的读者，尽量把系统设计、消息流、窗口自动化、飞书适配和调试方法讲清楚。

## 1. 项目目标

Trae CN 是桌面 IDE，飞书是 IM 平台。这个项目要做的事情是：

1. 用户在飞书里给机器人发消息。
2. Node.js 桥接服务通过飞书长连接收到消息。
3. 桥接服务把消息发送给 Trae CN。
4. Trae CN 的 Builder 生成回复。
5. 桥接服务读取 Trae 窗口里的回复。
6. 桥接服务把回复发回飞书。

当前最重要的实现路径是 `window` 模式，也就是 Windows 屏幕自动化。它不需要修改 Trae，也不依赖 Trae 插件 API，但代价是要面对 UIA 控件树不稳定、富文本拆分、窗口必须可见等问题。

## 2. 总体架构

```text
Feishu user
  |
  | im.message.receive_v1
  v
FeishuAdapter
  |
  v
BridgeManager
  |
  v
ConversationEngine
  |
  v
WindowLLMProvider
  |
  | Python scripts
  v
Trae CN window
  |
  | UIA text / raw UI JSON
  v
FeishuAdapter.send()
  |
  v
Feishu chat
```

核心模块：

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| 入口 | `src/main.ts` | 加载配置、初始化上下文、启动 API Server 和飞书适配器 |
| 配置 | `src/config.ts` | 读取 `.traecn-to-feishu/config.env` |
| 飞书适配 | `src/feishu/feishu-adapter.ts` | 接收飞书事件、发送飞书消息 |
| 编排 | `src/core/bridge-manager.ts` | 消息循环、命令处理、会话锁 |
| 对话引擎 | `src/core/conversation-engine.ts` | 调用 LLMProvider 并消费 SSE |
| Provider | `src/providers/window-provider.ts` | 调用 Python 脚本发送消息和监测回复 |
| 窗口发送 | `scripts/trae_window.py` | 定位 Trae 输入框、粘贴消息、回车 |
| 窗口监测 | `scripts/trae_monitor.py` | 读取 Trae Builder 回复 |
| UIA dump | `scripts/dump_ui.py` | 打印 Trae 窗口控件树 |
| 存储 | `src/store.ts` | JSON 文件持久化 |
| 日志 | `src/logger.ts` | 文件日志和敏感信息遮蔽 |

## 3. 配置加载

默认配置目录：

```text
<project>/.traecn-to-feishu/
```

默认配置文件：

```text
<project>/.traecn-to-feishu/config.env
```

`src/config.ts` 中：

```ts
export const CTI_HOME = process.env.CTI_HOME || path.join(process.cwd(), '.traecn-to-feishu');
export const CONFIG_PATH = path.join(CTI_HOME, 'config.env');
```

这意味着，如果不设置 `CTI_HOME`，配置和数据目录都在当前项目根目录下。

### 3.1 关键配置

| 配置 | 说明 |
| --- | --- |
| `CTI_RUNTIME` | `window` / `extension` / `auto`，当前推荐 `window` |
| `CTI_FEISHU_APP_ID` | 飞书自建应用 App ID |
| `CTI_FEISHU_APP_SECRET` | 飞书自建应用 App Secret |
| `CTI_FEISHU_DOMAIN` | 国内飞书用 `feishu`，海外 Lark 用 `lark` |
| `CTI_DEFAULT_WORKDIR` | Trae 当前项目目录 |
| `CTI_DEFAULT_MODEL` | 模型名记录 |
| `CTI_PYTHON_PATH` | Python 解释器路径 |
| `CTI_MONITOR_DEBUG` | 为 `true` 时返回 raw UIA JSON |
| `CTI_TRAE_MSG_SUFFIX` | 发送给 Trae 时追加的后缀 |

### 3.2 Python 环境变量注入

`loadConfig()` 会把部分配置写入 `process.env`，这样 Node 调 Python 子进程时能继承：

```ts
const pythonPath = env.get('CTI_PYTHON_PATH');
if (pythonPath && !process.env.CTI_PYTHON_PATH) {
  process.env.CTI_PYTHON_PATH = pythonPath;
}

const monitorDebug = env.get('CTI_MONITOR_DEBUG');
if (monitorDebug && !process.env.CTI_MONITOR_DEBUG) {
  process.env.CTI_MONITOR_DEBUG = monitorDebug;
}
```

这个细节很重要。之前只把 `CTI_PYTHON_PATH` 注入了环境，`CTI_MONITOR_DEBUG=true` 写进 env 文件后 Python 脚本并不知道，导致调试 JSON 没有返回。

## 4. 启动流程

`src/main.ts` 做了这些事：

1. `setupLogger()`
2. `loadConfig()`
3. `configToSettings()`
4. 创建 `JsonFileStore`
5. 根据 `CTI_RUNTIME` 创建 Provider
6. `initBridgeContext()`
7. 启动本地 API Server，端口 `3100`
8. 创建 `FeishuAdapter`
9. 调用 `bridgeManager.start(feishuAdapter)`

Provider 选择逻辑：

```ts
if (config.runtime === 'window') {
  llm = new WindowLLMProvider(config.messageTimeoutFirst, config.traeMsgSuffix);
} else {
  llm = new AutoLLMProvider(...);
}
```

当前项目实际主要使用 `window`。

## 5. 飞书适配器

文件：`src/feishu/feishu-adapter.ts`

### 5.1 长连接

飞书 SDK 使用 `WSClient`：

```ts
this.wsClient = new lark.WSClient({ appId, appSecret, domain });
this.wsClient.start({ eventDispatcher: dispatcher });
```

事件注册：

```ts
new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => { ... },
  'card.action.trigger': async (data) => { ... },
});
```

### 5.2 接收消息

接收流程：

1. 取 `message_id`、`chat_id`、`sender_id`。
2. 通过 `seenMessageIds` 去重。
3. 忽略非用户消息。
4. 解析 `text` 或 `post` 消息。
5. 移除 @ 机器人 mention。
6. 检查 `CTI_FEISHU_ALLOWED_USERS`。
7. 封装成 `InboundMessage`。
8. 放入 adapter 队列，等待 `BridgeManager` 消费。

### 5.3 发送消息

当前主要通过交互卡片发送：

```ts
const processedText = preprocessFeishuMarkdown(text);
const cardJson = buildCardContent(processedText);
return await this.sendCard(address.chatId, cardJson, replyToMessageId);
```

卡片方式比普通 post 更适合展示代码块、JSON 和较复杂的 Markdown。

## 6. BridgeManager

文件：`src/core/bridge-manager.ts`

`BridgeManager` 是消息编排中心。

### 6.1 消息循环

`runMessageLoop()` 不断调用：

```ts
const msg = await adapter.consumeOne();
handleMessage(adapter, msg);
```

### 6.2 handleMessage

处理顺序：

1. 写审计日志。
2. 处理权限按钮回调。
3. 处理 `/perm`、`/model`、`/mode`、`/help` 命令。
4. 查找或创建飞书 chat 与本地 session 的绑定。
5. 对同一个 session 加锁，避免并发消息互相覆盖。
6. 调用 `engine.processMessage()`。
7. 将结果通过 `deliver()` 发回飞书。

### 6.3 会话绑定

每个飞书 chat 会绑定一个 `ChannelBinding`：

```ts
{
  channelType: 'feishu',
  chatId,
  sessionId,
  workingDirectory,
  model,
  mode
}
```

这样同一个群或私聊可以保留上下文。

## 7. ConversationEngine

文件：`src/core/conversation-engine.ts`

它负责把一条飞书消息变成一次 Trae 调用。

核心步骤：

1. `store.acquireSessionLock()` 获取会话锁。
2. `store.addMessage(sessionId, 'user', text)` 记录用户消息。
3. 读取最近 50 条历史消息。
4. 构造 `StreamChatParams`。
5. 调用 `llm.streamChat(params)`。
6. 消费 SSE 流。
7. 把 assistant 回复写入消息历史。

### 7.1 SSE 事件

Provider 输出的流使用 SSE 文本格式：

```text
event: text
data: "hello"

event: result
data: {"text":"hello","tokenUsage":null}

event: done
data: ""
```

`consumeStream()` 会处理：

| 事件 | 作用 |
| --- | --- |
| `text` | 累加回复文本 |
| `result` | 保存最终文本、tokenUsage、sdkSessionId |
| `tool_use` | 更新工具状态 |
| `tool_result` | 标记工具完成 |
| `permission_request` | 转发权限请求 |
| `error` | 标记错误 |

## 8. WindowLLMProvider

文件：`src/providers/window-provider.ts`

窗口模式分两步：

1. 调用 `scripts/trae_window.py` 发送消息。
2. 调用 `scripts/trae_monitor.py` 读取回复。

核心代码：

```ts
const sendResult = await execPython(TRAE_WINDOW_SCRIPT, [fullMessage], abortController);
const monitorResult = await execPython(TRAE_MONITOR_SCRIPT, [String(monitorTimeoutSeconds), fullMessage], abortController);
```

### 8.1 超时

配置里的 `CTI_MESSAGE_TIMEOUT_FIRST` 是毫秒。Python 监测脚本参数是秒，所以 provider 会转换：

```ts
const monitorTimeoutSeconds = Math.ceil(monitorTimeout / 1000);
```

为了避免长回复过早截断，窗口模式当前最短等待 60 秒：

```ts
const monitorTimeoutMs = Math.max(this.timeout, 60000);
```

### 8.2 Python 路径

优先使用：

```ts
process.env.CTI_PYTHON_PATH
```

否则 Windows 上使用 `python`。

## 9. 发送消息到 Trae

文件：`scripts/trae_window.py`

流程：

1. 用 UIA 连接 Trae 窗口：

```py
Application(backend="uia").connect(title_re=r".*Trae CN.*")
```

2. 聚焦窗口。
3. 把消息写入剪贴板。
4. 找到底部输入框：

```py
edits = trae_win.descendants(control_type="Edit")
for e in reversed(edits):
    rect = e.rectangle()
    if rect.bottom > 700 and rect.right > 1300:
        chat_box = e
        break
```

5. 点击输入框。
6. `Ctrl+A`、`Ctrl+V`、`Enter`。
7. 返回 JSON。

## 10. 读取 Trae 回复

文件：`scripts/trae_monitor.py`

这是本项目最容易出问题、也最有学习价值的部分。

### 10.1 为什么难

Trae Builder 回复不是普通文本框，而是富文本 UI。Windows UIA 可能把一句自然语言拆成多个控件，例如：

```text
Text: 我看到你正在查看
Text: Traecn_to_im
Text: 项目中的
Hyperlink: main.ts
Text: 文件，第 69 行是
Text: await bridgeManager.start(feishuAdapter);
```

还可能出现：

- 灰底项目名 chip。
- 蓝色文件名链接。
- 代码片段。
- 列表项。
- 折叠的“思考过程”。
- `任务完成` 状态。
- 输入框中的 `@ Builder`。

这些元素的坐标不一定等于自然阅读顺序。之前尝试用 `top/left` 排序会出现错序，尝试按高度修正又会截断跨行文本。

### 10.2 当前策略

当前 `trae_monitor.py` 使用两层策略：

1. 普通模式：尝试读取最新 Builder 回复块并拼成文本。
2. 调试模式：直接返回 raw UIA JSON，避免丢信息。

调试模式开启：

```env
CTI_MONITOR_DEBUG=true
```

### 10.3 可见控件采集

`get_visible_text_items(win)`：

1. 找到 Trae 输入框。
2. 以输入框位置推断聊天区域范围。
3. 遍历窗口 descendants。
4. 只收集这些类型：

```py
{"Text", "Edit", "Document", "Hyperlink", "ListItem"}
```

5. 每个控件保存：

```json
{
  "seq": 0,
  "top": 324,
  "bottom": 347,
  "left": 1392,
  "right": 1668,
  "type": "Text",
  "text": "你好！有什么我可以帮你的吗？"
}
```

### 10.4 Builder 块定位

`get_latest_builder_items(items)`：

1. 找最后一个 `任务完成`。
2. 从它往上找最近的整行 `Builder`。
3. 取两者之间的控件。
4. 过滤噪声，例如 `思考过程`、输入框提示等。

这个方向比“最后一个 Builder”稳定，因为输入框区域可能也有 `@ Builder`。

### 10.5 raw UIA JSON 返回

`build_raw_response()` 返回：

```json
{
  "mode": "raw_uia_block",
  "items": [],
  "lines": [],
  "candidate": []
}
```

飞书会收到 fenced JSON：

````markdown
```json
{
  "mode": "raw_uia_block",
  "items": [...]
}
```
````

这是一种务实的降级方式：当自动还原文本不稳定时，不再让桥接服务猜测顺序，而是把真实 UIA 信息交给用户查看。

## 11. dump_ui.py 调试

文件：`scripts/dump_ui.py`

运行：

```powershell
D:/tmp/MiniConda/python.exe scripts/dump_ui.py
```

输出格式：

```text
0324,1392,0347,1668 Text: 你好！有什么我可以帮你的吗？
0368,1548,0391,1677 Text: Traecn_to_im
0368,1768,0391,1852 Hyperlink: main.ts
```

字段含义：

```text
top,left,bottom,right control_type: text
```

这是定位 UIA 错序、缺失、隐藏元素的主要工具。

## 12. raw JSON 与普通文本的取舍

### 普通文本优点

- 飞书里更容易读。
- 对简单回复体验好。

### 普通文本缺点

- Trae 富文本控件顺序可能错。
- 思考过程、链接、代码片段、列表项都可能影响解析。
- 不同 Trae 版本、模型和 UI 缩放比例下行为可能变化。

### raw UIA JSON 优点

- 信息不丢。
- 可复现。
- 用户可以自己识别有效字段。
- 方便继续优化解析算法。

### raw UIA JSON 缺点

- 飞书消息更长。
- 可读性不如自然语言。

当前建议：调试阶段保持 `CTI_MONITOR_DEBUG=true`。确认某个 Trae 版本和缩放设置下解析足够稳定后，再关闭 debug。

## 13. 本地 HTTP API

文件：`src/api-server.ts`

默认端口：

```text
3100
```

端点：

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/health` | GET | 健康检查 |
| `/api/config` | GET | 配置状态 |
| `/api/status` | GET | 桥接状态 |
| `/api/send-to-trae` | POST | 发送消息到 Trae |
| `/api/ai-response` | POST | 外部写入 AI 回复 |
| `/api/response/:id` | GET | 查询回复 |

这个 API 主要为 extension/auto 路线预留，也方便本地调试。

## 14. 存储系统

文件：`src/store.ts`

数据目录：

```text
.traecn-to-feishu/data/
```

常见文件：

| 文件 | 说明 |
| --- | --- |
| `sessions.json` | 会话元数据 |
| `bindings.json` | 飞书 chat 与 session 绑定 |
| `offsets.json` | 消息偏移 |
| `audit.json` | 审计日志 |
| `messages/<sessionId>.json` | 会话消息 |

写入方式使用临时文件 + rename，降低写坏 JSON 的概率。

## 15. 日志

日志文件：

```text
.traecn-to-feishu/logs/bridge.log
```

查看：

```powershell
Get-Content .traecn-to-feishu/logs/bridge.log -Tail 80
```

日志会遮蔽常见敏感字段，例如 App Secret、Bearer Token。

## 16. 安全边界

这个项目会自动向 Trae 发送用户消息。使用时要注意：

- 不要把机器人加入不可信群。
- 可以用 `CTI_FEISHU_ALLOWED_USERS` 限制用户。
- 不要把 `config.env` 上传到 GitHub。
- Trae 可能执行代码编辑或命令，取决于当前模型和模式。
- raw UIA JSON 可能包含当前 IDE 窗口里可见的路径、代码、聊天文本。

## 17. 与参考项目的关系

本地参考项目 `feishu-toTrae-bot/` 主要实现了：

- 飞书接收消息。
- 使用 Python 脚本把消息发送到 Trae 窗口。

它没有完整实现“读取 Trae Builder 回复并回传飞书”。本项目在参考发送思路的基础上，增加了：

- 飞书长连接事件适配。
- Node/TypeScript 模块化桥接。
- Trae 回复监测。
- raw UIA JSON 调试。
- 会话、绑定、审计等 JSON 存储。

## 18. 常见问题

### 18.1 为什么飞书只收到一小段回复

通常是 Trae UIA 富文本拆分导致。开启：

```env
CTI_MONITOR_DEBUG=true
```

然后重启服务，让飞书直接收到 raw UIA JSON。

### 18.2 为什么写了 CTI_MONITOR_DEBUG 但没生效

需要确认：

1. 写在 `.traecn-to-feishu/config.env`。
2. 重启 Node 服务。
3. 当前代码包含 `src/config.ts` 中对 `CTI_MONITOR_DEBUG` 的注入逻辑。

### 18.3 为什么 Python 运行失败

检查：

```powershell
D:/tmp/MiniConda/python.exe --version
D:/tmp/MiniConda/python.exe -c "import pywinauto, pyperclip; print('ok')"
```

然后确认：

```env
CTI_PYTHON_PATH=D:/tmp/MiniConda/python.exe
```

### 18.4 为什么找不到 Trae 窗口

脚本按窗口标题匹配：

```py
r".*Trae CN.*"
r".*Trae.*"
```

确保 Trae CN 已打开，且不是最小化状态。

## 19. 后续可改进方向

- 为 Trae UIA 回复解析增加可配置策略。
- 把 raw UIA JSON 写入本地文件，飞书只发摘要和文件路径。
- 引入 OCR 作为窗口读取兜底。
- 如果 Trae 提供稳定 API，优先使用 API，减少窗口自动化。
- 为 `trae_monitor.py` 增加基于 dump fixture 的单元测试。
- 增加独立诊断命令，自动检查 Python、pywinauto、Trae 窗口和飞书连接。
