# SmartTeachAgent

一个最小可运行的 Agent Demo：
- 前端：React + Vite + Ant Design X
- Electron 主进程：Claude Agent SDK（通过 IPC 提供能力）

## 快速开始

1. 安装依赖

```bash
pnpm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

至少配置：

```bash
ANTHROPIC_API_KEY=你的密钥
```

可选：

```bash
CLAUDE_MODEL=claude-sonnet-4-6
PORT=3001
```

3. 启动 Electron 版（IPC）

```bash
pnpm dev
```

4. 如果要启动浏览器 Demo（HTTP 前后端）

```bash
pnpm dev:demo
```

## 接口

- `GET /api/health`：后端健康检查
- `POST /api/chat`：向 Claude Agent SDK 发送消息

## 通信方式

- Electron 模式：前端通过 `window.smartTeach.chat()` 走 IPC（`ipcRenderer.invoke -> ipcMain.handle`）
- 浏览器 Demo 模式：前端回退到 `/api/chat`（Express）
