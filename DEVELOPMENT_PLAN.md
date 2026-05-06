# TraeCN-to-Feishu 开发计划

## MVP状态: ✅ 全部完成

| 阶段 | 状态 | 文件 |
|------|------|------|
| MVP-1: 核心类型 + DI + 配置 | ✅ | types.ts, context.ts, config.ts, host.ts |
| MVP-2: 飞书适配器 | ✅ | feishu-adapter.ts, feishu-markdown.ts |
| MVP-3: 窗口自动化提供者 | ✅ | window-provider.ts, trae_window.py, trae_monitor.py |
| MVP-4: 对话引擎 + 投递 + 桥接 | ✅ | conversation-engine.ts, delivery-layer.ts, bridge-manager.ts, permission-broker.ts, validators.ts |
| MVP-5: 存储 + 日志 + 入口 | ✅ | store.ts, logger.ts, main.ts |

## 扩展状态: ✅ 全部完成

| 阶段 | 状态 | 文件 |
|------|------|------|
| 扩展-1: Extension API主路径 + API Server | ✅ | extension-provider.ts, auto-provider.ts, api-server.ts |
| 扩展-2: 流式输出优化 + 权限卡片 | ✅ | feishu-markdown.ts (buildStreamingCard, buildResolvedPermissionCard), feishu-adapter.ts |
| 扩展-3: 上下文感知 + 多模型调度 | ✅ | mode-detector.ts, bridge-manager.ts |

## 架构总览

```
飞书 (IM平台)
    ↕ @larksuiteoapi/node-sdk WSClient (长连接)
桥接守护进程 (Node.js / TypeScript)
    ↕ HTTP API (主路径: Extension Provider → Trae CN本地API)
    ↕ pywinauto (降级路径: 窗口自动化)
Trae CN (内置模型API)
```

## 项目结构

```
traecn-to-feishu/
├── src/
│   ├── core/
│   │   ├── types.ts
│   │   ├── context.ts
│   │   ├── host.ts
│   │   ├── bridge-manager.ts
│   │   ├── conversation-engine.ts
│   │   ├── delivery-layer.ts
│   │   ├── permission-broker.ts
│   │   ├── mode-detector.ts
│   │   └── security/
│   │       └── validators.ts
│   ├── feishu/
│   │   ├── feishu-adapter.ts
│   │   └── feishu-markdown.ts
│   ├── providers/
│   │   ├── auto-provider.ts
│   │   ├── extension-provider.ts
│   │   └── window-provider.ts
│   ├── api-server.ts
│   ├── config.ts
│   ├── logger.ts
│   ├── main.ts
│   ├── sse-utils.ts
│   └── store.ts
├── scripts/
│   ├── trae_window.py
│   └── trae_monitor.py
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

## 已知问题与修复计划

### 🔴 问题1: SDK v1.43.0 中 bot.info API 变更
- **位置**: `src/feishu/feishu-adapter.ts` → `resolveBotIdentity()`
- **现象**: 启动时报错 `Cannot read properties of undefined (reading 'info')`
- **原因**: `@larksuiteoapi/node-sdk` v1.43.0 中 `client.bot` 模块已被移除或重构
- **当前处理**: 已跳过 bot 身份验证，功能不受影响（仅无法过滤机器人自己的消息）
- **修复方案**: 需要查找新 SDK 中获取 bot 信息的正确 API，可能通过 `application.application.get()` 或其他路径
- **优先级**: 低
