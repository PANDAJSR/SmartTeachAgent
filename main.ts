import "dotenv/config";

import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { buildClaudeOptions } from "./backend/claudeOptions";

type ChatMeta = {
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  stopReason?: string | null;
};

type ChatResult = {
  reply: string;
  meta: ChatMeta | null;
};

async function runClaudeChat(message?: string): Promise<ChatResult> {
  const clean = (message || "").trim();
  if (!clean) {
    throw new Error("message 不能为空");
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("缺少 ANTHROPIC_API_KEY，请先在 .env 中配置后重试");
  }

  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let finalResult = "";
  let resultMeta: ChatMeta | null = null;

  const options = buildClaudeOptions();

  for await (const sdkMessage of query({ prompt: clean, options })) {
    if (sdkMessage.type !== "result") {
      continue;
    }

    if (sdkMessage.subtype === "success") {
      finalResult = sdkMessage.result;
      resultMeta = {
        costUsd: sdkMessage.total_cost_usd,
        durationMs: sdkMessage.duration_ms,
        turns: sdkMessage.num_turns,
        stopReason: sdkMessage.stop_reason,
      };
    } else {
      const detail = sdkMessage.errors?.join("; ") || "Claude Agent 执行失败";
      throw new Error(detail);
    }
  }

  if (!finalResult) {
    throw new Error("未获取到 Claude 返回内容");
  }

  return {
    reply: finalResult,
    meta: resultMeta,
  };
}

ipcMain.handle(
  "chat:send",
  async (_event, payload?: { message?: string }): Promise<ChatResult | { error: string }> => {
    try {
      return await runClaudeChat(payload?.message);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "服务异常",
      };
    }
  }
);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
