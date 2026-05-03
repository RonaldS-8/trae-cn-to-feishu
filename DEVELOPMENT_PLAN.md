# TraeCN-to-Feishu 开发计划

> 开发完成后删除此文件

## 架构总览

```
飞书 (IM平台)
    ↕ @larksuiteoapi/node-sdk WSClient (长连接)
桥接守护进程 (Node.js / TypeScript)
    ↕ HTTP/SSE (主路径: Trae CN扩展端点) [扩展阶段]
    ↕ pywinauto (降级路径: 窗口自动化) [MVP阶段]
Trae CN (内置模型API)
```

## MVP范围（先跑通核心链路）

MVP目标：飞书发消息 → 桥接层 → Trae CN窗口自动化 → 响应回飞书

### MVP-1: 核心类型定义 + DI容器 + 配置管理
- `src/core/types.ts` — 共享类型
- `src/core/context.ts` — DI容器
- `src/config.ts` — config.env加载/保存
- verify: typecheck通过

### MVP-2: 飞书适配器
- `src/feishu/feishu-adapter.ts` — WSClient接收 + REST发送
- `src/feishu/feishu-markdown.ts` — Markdown→飞书格式
- verify: 消息收发测试通过

### MVP-3: Trae CN模型提供者(窗口自动化)
- `src/providers/window-provider.ts` — pywinauto注入+监控
- `src/scripts/trae_window.py` — 窗口自动化脚本
- verify: 能注入消息并获取响应

### MVP-4: 对话引擎 + 投递层 + 桥接管理器
- `src/core/conversation-engine.ts` — SSE流处理
- `src/core/delivery-layer.ts` — 分块/重试/去重
- `src/core/bridge-manager.ts` — 编排器
- `src/core/permission-broker.ts` — 权限审批
- verify: 端到端消息流转

### MVP-5: 存储层 + 日志 + 守护进程入口
- `src/store.ts` — JSON文件持久化
- `src/logger.ts` — 日志(密钥脱敏)
- `src/main.ts` — 守护进程入口
- verify: npm run dev 启动成功

### MVP集成测试
- 飞书→桥接→Trae CN→飞书 完整链路
- 错误场景: 超时、网络断开

## 扩展阶段（MVP跑通后）

### 扩展-1: Trae CN扩展API主路径
- `extension/src/extension.ts` — VS Code扩展入口
- `extension/src/api-server.ts` — 本地HTTP/SSE服务
- `extension/src/model-client.ts` — Trae CN内置模型调用
- `extension/src/context-provider.ts` — 项目上下文

### 扩展-2: 流式输出 + 权限管理
- 消息编辑模拟流式输出(节流500ms)
- 飞书交互卡片权限按钮

### 扩展-3: 上下文感知 + 多模型调度
- 自动读取项目文件、Git历史
- 多模型ID透传路由

## 项目结构

```
traecn-to-feishu/
├── src/
│   ├── core/
│   │   ├── types.ts
│   │   ├── context.ts
│   │   ├── bridge-manager.ts
│   │   ├── conversation-engine.ts
│   │   ├── delivery-layer.ts
│   │   └── permission-broker.ts
│   ├── feishu/
│   │   ├── feishu-adapter.ts
│   │   └── feishu-markdown.ts
│   ├── providers/
│   │   ├── extension-provider.ts  [扩展阶段]
│   │   └── window-provider.ts
│   ├── store.ts
│   ├── config.ts
│   ├── logger.ts
│   ├── sse-utils.ts
│   └── main.ts
├── scripts/
│   ├── trae_window.py
│   ├── daemon.sh
│   └── doctor.sh
├── extension/                       [扩展阶段]
│   └── ...
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

## 关键技术要点

1. **零配置**: config.env管理飞书凭证，首次运行交互式引导
2. **流式输出**: 消息编辑模拟(节流500ms)
3. **上下文感知**: Trae CN扩展自动注入项目上下文 [扩展阶段]
4. **多模型调度**: 透传模型ID [扩展阶段]
5. **权限管理**: 飞书交互卡片按钮 [扩展阶段]
6. **安全**: Token脱敏日志、用户白名单、速率限制(20条/分钟/会话)
