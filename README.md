# TraeCN-to-Feishu

把飞书机器人连接到 Trae CN，让你可以在飞书里向 Trae CN 当前窗口发送消息，并把 Trae 的回复转发回飞书。

本项目当前主要面向 Windows + Trae CN 桌面端，核心方案是屏幕窗口自动化：用 `pywinauto` 把飞书消息发送到 Trae，再监测 Trae 侧回复。

## 功能

- 飞书机器人接收用户消息。
- 长连接模式接入飞书事件，不需要公网回调地址。
- 将飞书消息发送到 Trae CN 输入框。
- 从 Trae CN 窗口读取 Builder 回复并发回飞书。
- 支持 raw UIA JSON 调试模式，适合 Trae 富文本回复识别不稳定时使用。
- 本地 JSON 文件保存会话、绑定、消息和审计记录。
- 提供本地 HTTP API，便于后续扩展或调试。

## 运行要求

| 依赖 | 用途 |
| --- | --- |
| Windows | 当前窗口自动化依赖 Windows UIA |
| Trae CN | 需要已打开并登录 |
| Node.js >= 20 | 运行 TypeScript/Node 桥接服务 |
| Python 3.x | 运行窗口自动化脚本 |
| pywinauto | 控制和读取 Trae 窗口 |
| pyperclip | 通过剪贴板向 Trae 输入消息 |
| 飞书自建应用 | 提供机器人和长连接事件 |

Python 依赖安装示例：

```powershell
pip install pywinauto pyperclip
```

## 安装

```powershell
git clone https://github.com/your-name/traecn-to-feishu.git
cd traecn-to-feishu
npm install
```

## 飞书应用配置

在 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用。

需要完成：

1. 开启机器人能力。
2. 添加机器人到目标会话。
3. 添加消息相关权限，例如接收消息、发送消息、回复消息、更新消息。
4. 在“事件与回调”里使用长连接模式。
5. 订阅消息事件 `im.message.receive_v1`。
6. 如果使用交互卡片，再配置 `card.action.trigger` 回调。
7. 发布应用版本并完成管理员审核。

启动日志里出现类似下面内容，说明飞书长连接已建立：

```text
[feishu-adapter] Started
[ws] ws client ready
```

## 配置

配置文件默认读取：

```text
.traecn-to-feishu/config.env
```

也可以通过环境变量 `CTI_HOME` 改变数据目录。

推荐配置示例：

```env
# window 是当前最稳定的 Trae CN 屏幕自动化模式
CTI_RUNTIME=window

# 飞书应用凭证
CTI_FEISHU_APP_ID=YOUR_API_KEY_HERE
CTI_FEISHU_APP_SECRET=YOUR_API_KEY_HERE
CTI_FEISHU_DOMAIN=feishu

# 可选：限制允许使用机器人的飞书用户 open_id，留空则不限制
CTI_FEISHU_ALLOWED_USERS=

# Trae CN 当前项目目录
CTI_DEFAULT_WORKDIR=YOUR_PROJECT_PATH_HERE

# Trae 模型名，仅用于记录/提示，不保证能切换 Trae UI 内部模型
CTI_DEFAULT_MODEL=MiniMax-M2
CTI_DEFAULT_MODE=code

# 发送给 Trae 的消息后缀，可留空
CTI_TRAE_MSG_SUFFIX=

# Python 路径。系统 python 不可靠时建议写绝对路径
CTI_PYTHON_PATH=YOUR_PYTHON_PATH_HERE

# 首次等待和重试等待，单位毫秒。窗口模式内部最短会按 60 秒等待
CTI_MESSAGE_TIMEOUT_FIRST=20000
CTI_MESSAGE_TIMEOUT_RETRY=20000

# 调试模式：直接把 Trae 最新 Builder 回复块的 UIA JSON 发回飞书
CTI_MONITOR_DEBUG=true
```

## 启动

开发模式：

```powershell
npm run dev
```

生产模式：

```powershell
npm run build
npm start
```

看到以下日志表示桥接服务已启动：

```text
TraeCN-to-IM Bridge starting...
Using WindowLLMProvider (window automation mode)
Bridge started
Bridge is running (provider: window)
API server listening on http://127.0.0.1:3100
```

## 使用

1. 打开 Trae CN，并确保右侧 Builder 聊天窗口可见。
2. 启动本项目。
3. 在飞书里给机器人发送消息。
4. 项目会把消息粘贴到 Trae 输入框并回车。
5. Trae 回复完成后，项目会把回复发回飞书。

如果 `CTI_MONITOR_DEBUG=true`，飞书收到的是 raw UIA JSON。它包含最新 Builder 回复区域内每个控件的位置和文本，适合人工查看或继续调试富文本识别。

## raw UIA JSON 模式

Trae 的回复里常见灰底项目名、蓝色文件名、代码片段、折叠的“思考过程”等富文本元素。Windows UIA 暴露这些内容时，可能会把一句话拆成多个控件，而且坐标和自然阅读顺序不总是一致。

为了稳定可用，调试模式会直接返回结构化 JSON：

```json
{
  "mode": "raw_uia_block",
  "items": [
    {
      "seq": 0,
      "top": 100,
      "bottom": 123,
      "left": 1392,
      "right": 1500,
      "type": "Text",
      "text": "我是由"
    }
  ],
  "lines": ["脚本尝试拼接后的文本行"],
  "candidate": ["脚本当前认为的候选回复"]
}
```

如果你只想收到普通文本，可以把配置改成：

```env
CTI_MONITOR_DEBUG=false
```

## 常用命令

项目支持一些飞书文本命令：

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看帮助 |
| `/mode code` | 切换到代码模式 |
| `/mode plan` | 切换到计划模式 |
| `/mode ask` | 切换到问答模式 |
| `/model <name>` | 记录/切换模型名 |
| `/perm allow <id>` | 批准权限请求 |
| `/perm deny <id>` | 拒绝权限请求 |

## 本地 API

启动后会监听：

```text
http://127.0.0.1:3100
```

常见端点：

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/health` | GET | 健康检查 |
| `/api/status` | GET | 查看桥接状态 |
| `/api/config` | GET | 查看配置状态 |
| `/api/send-to-trae` | POST | 发送消息到 Trae |
| `/api/ai-response` | POST | 接收外部 Trae 回复 |
| `/api/response/:id` | GET | 轮询回复 |

## 项目结构

```text
src/
  core/                 核心消息编排、会话、权限、投递
  feishu/               飞书适配器和飞书消息格式
  providers/            Trae 提供者：window/extension/auto
  api-server.ts         本地 HTTP API
  config.ts             配置加载
  store.ts              JSON 文件存储
  main.ts               入口
scripts/
  trae_window.py        向 Trae 输入框发送消息
  trae_monitor.py       读取 Trae Builder 回复
  dump_ui.py            打印当前 Trae UIA 控件树，调试用
```

## 故障排查

### 飞书收不到任何消息

- 确认飞书应用 App ID/App Secret 正确。
- 确认应用已发布并审核。
- 确认机器人已加入当前会话。
- 确认事件订阅使用长连接模式。
- 查看 `.traecn-to-feishu/logs/bridge.log`。

### Trae 没有收到消息

- 确认 Trae CN 正在运行。
- 确认 Builder 聊天输入框可见。
- 确认 `CTI_PYTHON_PATH` 指向可运行的 Python。
- 确认 Python 已安装 `pywinauto` 和 `pyperclip`。

### Trae 回复不完整或顺序不对

开启：

```env
CTI_MONITOR_DEBUG=true
```

然后重启服务。飞书会收到 raw UIA JSON，用户可以直接读取 `items[].text` 中的有效信息，也可以把 JSON 贴给维护者继续优化解析。

### 查看 Trae 当前窗口 UIA

```powershell
python scripts/dump_ui.py
```

这会输出所有可见控件的位置、类型和文本。

## 参考

本项目曾参考 `WRk-05/feishu-toTrae-bot` 的窗口发送思路。该参考项目主要实现“飞书到 Trae 的消息输入”，本项目在此基础上增加了 Trae 回复监测、飞书长连接适配、持久化和调试模式。

## License

MIT
