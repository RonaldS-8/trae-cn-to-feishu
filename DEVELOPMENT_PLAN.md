# TraeCN-to-Feishu 开发计划

本文记录当前实现状态、已知问题和后续计划。面向开发维护者，不作为最终用户指南。

## 当前状态

项目已完成一个可用的 Windows 窗口自动化版本：

- 飞书机器人可以接收消息。
- Node.js 桥接服务可以通过长连接接入飞书事件。
- 消息可以通过 `pywinauto` 发送到 Trae CN Builder 输入框。
- Trae 回复可以在调试模式下以 raw UIA JSON 形式回传飞书。
- 会话、绑定、消息、审计日志使用本地 JSON 文件保存。

## 阶段完成情况

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| MVP-1 核心类型、DI、配置 | 已完成 | `types.ts`、`host.ts`、`context.ts`、`config.ts` |
| MVP-2 飞书适配器 | 已完成 | 长连接、消息解析、消息发送 |
| MVP-3 窗口自动化 | 已完成 | `trae_window.py`、`trae_monitor.py`、`dump_ui.py` |
| MVP-4 对话编排 | 已完成 | `bridge-manager.ts`、`conversation-engine.ts` |
| MVP-5 本地存储和日志 | 已完成 | `store.ts`、`logger.ts` |
| 扩展 API Server | 已完成 | `api-server.ts`，端口 3100 |
| raw UIA JSON 调试模式 | 已完成 | `CTI_MONITOR_DEBUG=true` |

## 关键设计决策

### 1. 默认配置目录使用项目内目录

当前默认：

```text
.traecn-to-feishu/config.env
```

原因：

- 用户在 Trae 项目里运行更直观。
- 方便把配置、日志、数据与当前项目绑定。
- 便于调试，不需要去用户主目录找文件。

风险：

- 不能把 `.traecn-to-feishu/config.env` 上传到 GitHub。
- `.gitignore` 必须忽略本地数据目录。

### 2. 当前主路径使用 window 模式

`CTI_RUNTIME=window` 是当前实际可用路径。

优点：

- 不依赖 Trae 官方 API 或插件能力。
- 与当前 Trae CN 桌面端适配。

缺点：

- 要求 Windows。
- 要求 Trae 窗口可见。
- UIA 富文本读取不稳定。

### 3. raw UIA JSON 是可用性兜底

Trae 的富文本回复会拆成很多 UIA 控件。自动拼接自然语言不总是稳定。当前调试模式不再强行识别，而是直接返回最新 Builder 回复块的 JSON。

目标是先保证：

- 信息不丢。
- 用户能人工识别有效内容。
- 后续开发者能基于真实 JSON 继续优化。

## 已知问题

### 1. Trae 富文本自然语言还原不稳定

表现：

- 项目名、文件名、代码片段位置错乱。
- 只返回第一句。
- 遇到“思考过程”时误判回复区域。

当前处理：

- `CTI_MONITOR_DEBUG=true` 时返回 raw UIA JSON。
- 普通文本解析保留，但不作为强保证。

后续计划：

- 收集多个 `dump_ui.py` 输出样本。
- 为 `trae_monitor.py` 写 fixture 测试。
- 对不同 Trae 回复形态分别建立解析规则。

### 2. 参考项目没有回复读取实现

本地参考库 `feishu-toTrae-bot/` 提供了向 Trae 发送消息的思路，但没有实现稳定读取 Trae 回复。因此读取逻辑需要本项目继续自研。

### 3. Feishu SDK bot identity API 暂未恢复

`@larksuiteoapi/node-sdk` v1.43.0 中原先的 bot 信息接口发生变化。当前 `resolveBotIdentity()` 跳过 bot 身份解析。

影响：

- 核心收发不受影响。
- 机器人自消息过滤能力较弱。

计划：

- 查找新版 SDK 获取 bot open_id 的正确方式。
- 恢复 `botIds` 过滤。

### 4. window 模式依赖屏幕状态

如果 Trae 最小化、输入框不可见、窗口标题变化，脚本可能失败。

计划：

- 增加 doctor 脚本。
- 自动检测 Trae 窗口、输入框、Python 依赖。
- 提供更明确错误信息。

## 后续路线

### 短期

1. 保持 raw UIA JSON 模式稳定可用。
2. 完善 README 中的安装和调试步骤。
3. 给 `dump_ui.py` 增加输出到文件功能。
4. 在日志中记录 Python 脚本最后一行 JSON，便于排查。

### 中期

1. 建立 Trae 回复 UIA fixture 集合。
2. 为富文本拼接写测试。
3. 分离普通文本模式和 raw JSON 模式。
4. 增加配置：

```env
CTI_MONITOR_MODE=raw|text|auto
```

5. 支持 raw JSON 太长时写入本地文件，只向飞书发送摘要。

### 长期

1. 探索 Trae CN 是否存在稳定本地 API。
2. 支持更多 IM 平台。
3. 支持后台服务化启动。
4. 增加 Web 管理页面。
5. 增加权限审批真实执行链路。

## 当前验证命令

```powershell
npm run typecheck
npm run build
```

Python 侧检查：

```powershell
D:/tmp/MiniConda/python.exe --version
D:/tmp/MiniConda/python.exe -c "import pywinauto, pyperclip; print('ok')"
D:/tmp/MiniConda/python.exe scripts/dump_ui.py
```

## 发布前检查清单

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `.traecn-to-feishu/config.env` 未被提交。
- 飞书 App ID/App Secret 未写入 README 或日志样例。
- README 中的安装步骤与当前代码一致。
- TECHNICAL_DOC 中说明 raw UIA JSON 的限制和用途。

## 目录说明

```text
src/
  core/          核心编排和类型
  feishu/        飞书适配
  providers/     Trae provider
scripts/
  trae_window.py 发送消息到 Trae
  trae_monitor.py 读取 Trae 回复
  dump_ui.py     调试 UIA 控件树
.traecn-to-feishu/
  config.env     本地配置，不能提交
  data/          本地持久化
  logs/          日志
```

## 维护备注

- 尽量不要在窗口自动化脚本里假设固定屏幕分辨率。
- 对 Trae UIA 做任何解析规则前，先保存对应 `dump_ui.py` 输出。
- 对用户可见文档保持 UTF-8，避免再次出现乱码。
- 参考库 `feishu-toTrae-bot/` 仅作参考，不应作为本项目源码的一部分提交。
