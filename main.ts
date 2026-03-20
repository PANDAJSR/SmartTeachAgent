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

type TraceEntry = {
  type: "tool" | "thinking";
  text: string;
};

type ChatProgressSnapshot = {
  reply: string;
  trace: TraceEntry[];
};

type ChatResult = {
  reply: string;
  meta: ChatMeta | null;
  trace: TraceEntry[];
};

function toPreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (!text) {
      return "";
    }
    return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  } catch {
    return String(value);
  }
}

function pushTrace(trace: TraceEntry[], type: TraceEntry["type"], text: string): void {
  const clean = text.trim();
  if (!clean) {
    return;
  }
  const prev = trace[trace.length - 1];
  if (prev && prev.type === type && prev.text === clean) {
    return;
  }
  trace.push({ type, text: clean });
}

function appendTrace(trace: TraceEntry[], type: TraceEntry["type"], delta: string): void {
  if (!delta) {
    return;
  }
  const prev = trace[trace.length - 1];
  if (prev && prev.type === type) {
    prev.text += delta;
    return;
  }
  trace.push({ type, text: delta });
}

async function runClaudeChat(
  message?: string,
  onProgress?: (snapshot: ChatProgressSnapshot) => void
): Promise<ChatResult> {
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
  const trace: TraceEntry[] = [];
  let streamedReply = "";

  const emitProgress = (): void => {
    if (!onProgress) {
      return;
    }
    onProgress({
      reply: streamedReply,
      trace: trace.map((item) => ({ ...item })),
    });
  };

  const options = buildClaudeOptions();
  options.includePartialMessages = true;

  for await (const sdkMessage of query({ prompt: clean, options })) {
    if (sdkMessage.type === "assistant") {
      const blocks = sdkMessage.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (!block || typeof block !== "object" || !("type" in block)) {
            continue;
          }
          if (block.type === "tool_use") {
            const inputPreview = toPreview(block.input);
            pushTrace(
              trace,
              "tool",
              `准备调用工具 ${block.name}${inputPreview ? `，参数：${inputPreview}` : ""}`
            );
            emitProgress();
          }
          if (block.type === "thinking" && typeof block.thinking === "string") {
            pushTrace(trace, "thinking", block.thinking);
            emitProgress();
          }
        }
      }
      continue;
    }

    if (sdkMessage.type === "tool_progress") {
      pushTrace(
        trace,
        "tool",
        `工具 ${sdkMessage.tool_name} 执行中（${Math.round(sdkMessage.elapsed_time_seconds)}s）`
      );
      emitProgress();
      continue;
    }

    if (sdkMessage.type === "tool_use_summary") {
      pushTrace(trace, "tool", sdkMessage.summary);
      emitProgress();
      continue;
    }

    if (sdkMessage.type === "system") {
      if (sdkMessage.subtype === "task_started") {
        pushTrace(trace, "tool", `任务开始：${sdkMessage.description}`);
        emitProgress();
      }
      if (sdkMessage.subtype === "task_progress") {
        pushTrace(trace, "tool", `任务进度：${sdkMessage.description}`);
        if (sdkMessage.summary) {
          pushTrace(trace, "thinking", sdkMessage.summary);
        }
        emitProgress();
      }
      if (sdkMessage.subtype === "task_notification") {
        pushTrace(trace, "tool", `任务${sdkMessage.status}：${sdkMessage.summary}`);
        emitProgress();
      }
      continue;
    }

    if (sdkMessage.type === "stream_event") {
      const event = sdkMessage.event;
      if (
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "content_block_delta" &&
        "delta" in event &&
        event.delta &&
        typeof event.delta === "object" &&
        "type" in event.delta &&
        event.delta.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        streamedReply += event.delta.text;
        emitProgress();
      }

      if (
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "content_block_delta" &&
        "delta" in event &&
        event.delta &&
        typeof event.delta === "object" &&
        "type" in event.delta &&
        event.delta.type === "thinking_delta" &&
        typeof event.delta.thinking === "string"
      ) {
        appendTrace(trace, "thinking", event.delta.thinking);
        emitProgress();
      }
      continue;
    }

    if (sdkMessage.type !== "result") {
      continue;
    }

    if (sdkMessage.subtype === "success") {
      finalResult = sdkMessage.result;
      streamedReply = finalResult;
      resultMeta = {
        costUsd: sdkMessage.total_cost_usd,
        durationMs: sdkMessage.duration_ms,
        turns: sdkMessage.num_turns,
        stopReason: sdkMessage.stop_reason,
      };
      emitProgress();
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
    trace,
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

ipcMain.handle(
  "chat:send:stream",
  async (
    event,
    payload?: { message?: string; requestId?: string }
  ): Promise<ChatResult | { error: string }> => {
    const requestId = (payload?.requestId || "").trim();
    if (!requestId) {
      return { error: "缺少 requestId" };
    }
    const channel = `chat:stream:${requestId}`;
    const sendSnapshot = (snapshot: ChatProgressSnapshot): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: "snapshot", ...snapshot });
      }
    };

    try {
      const result = await runClaudeChat(payload?.message, sendSnapshot);
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: "done" });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务异常";
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: "error", error: message });
      }
      return { error: message };
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
