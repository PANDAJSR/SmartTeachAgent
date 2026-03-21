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

type ToolStatus = "pending" | "running" | "completed" | "failed" | "stopped";

type TextSegment = {
  type: "text";
  text: string;
};

type ToolSegment = {
  type: "tool";
  text: string;
  toolName?: string;
  toolUseId?: string;
  status?: ToolStatus;
  output?: string;
};

type ContentSegment = TextSegment | ToolSegment;

type ChatProgressSnapshot = {
  reply: string;
  trace: TraceEntry[];
  rendered: string;
  segments: ContentSegment[];
};

type ChatResult = {
  reply: string;
  meta: ChatMeta | null;
  trace: TraceEntry[];
  rendered: string;
  segments: ContentSegment[];
  stopped?: boolean;
};

const activeAbortControllers = new Map<string, AbortController>();

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

function findLatestToolSegmentIndex(
  segments: ContentSegment[],
  toolUseId?: string,
  toolName?: string
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.type !== "tool") {
      continue;
    }
    if (toolUseId && segment.toolUseId === toolUseId) {
      return index;
    }
    if (!toolUseId && toolName && segment.toolName === toolName) {
      return index;
    }
  }
  return -1;
}

function findFallbackToolSegmentIndex(segments: ContentSegment[]): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.type !== "tool") {
      continue;
    }
    return index;
  }
  return -1;
}

function upsertToolSegment(
  segments: ContentSegment[],
  payload: {
    text: string;
    toolUseId?: string;
    toolName?: string;
    status?: ToolStatus;
  }
): void {
  const clean = payload.text.trim();
  if (!clean) {
    return;
  }
  const idx = findLatestToolSegmentIndex(segments, payload.toolUseId, payload.toolName);
  if (idx >= 0) {
    const prev = segments[idx];
    if (prev.type !== "tool") {
      return;
    }
    segments[idx] = {
      ...prev,
      text: clean,
      toolName: payload.toolName || prev.toolName,
      toolUseId: payload.toolUseId || prev.toolUseId,
      status: payload.status || prev.status,
    };
    return;
  }
  const prev = segments[segments.length - 1];
  if (
    prev &&
    prev.type === "tool" &&
    prev.text === clean &&
    prev.toolName === payload.toolName &&
    prev.status === payload.status
  ) {
    return;
  }
  segments.push({
    type: "tool",
    text: clean,
    toolName: payload.toolName,
    toolUseId: payload.toolUseId,
    status: payload.status,
  });
}

function appendTextSegment(segments: ContentSegment[], delta: string): void {
  if (!delta) {
    return;
  }
  const prev = segments[segments.length - 1];
  if (prev && prev.type === "text") {
    prev.text += delta;
    return;
  }
  segments.push({ type: "text", text: delta });
}

function buildRenderedContent(segments: ContentSegment[], fallbackReply: string): string {
  const blocks: string[] = [];
  for (const segment of segments) {
    if (segment.type === "tool") {
      const toolBlock = segment.output
        ? `${segment.text}\n\n工具输出：\n${segment.output}`
        : segment.text;
      blocks.push(`> [工具调用] ${toolBlock}`);
      continue;
    }
    if (!segment.text) {
      continue;
    }
    blocks.push(segment.text);
  }
  const rendered = blocks.join("\n\n").trim();
  if (rendered) {
    return rendered;
  }
  return fallbackReply.trim();
}

function extractToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractToolOutput(item))
      .map((item) => item.trim())
      .filter(Boolean);
    return parts.join("\n");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return obj.text.trim();
    }
    if (typeof obj.stdout === "string" || typeof obj.stderr === "string") {
      return [obj.stdout, obj.stderr].filter((item): item is string => typeof item === "string").join("\n").trim();
    }
    if ("content" in obj) {
      return extractToolOutput(obj.content);
    }
  }
  return toPreview(value);
}

function appendToolOutput(
  segments: ContentSegment[],
  payload: {
    output: string;
    toolUseId?: string;
    toolName?: string;
    status?: ToolStatus;
  }
): void {
  const clean = payload.output.trim();
  if (!clean) {
    return;
  }
  let idx = findLatestToolSegmentIndex(segments, payload.toolUseId, payload.toolName);
  if (idx < 0) {
    idx = findFallbackToolSegmentIndex(segments);
  }
  if (idx >= 0) {
    const prev = segments[idx];
    if (prev.type !== "tool") {
      return;
    }
    segments[idx] = {
      ...prev,
      output: prev.output ? `${prev.output}\n${clean}` : clean,
      status: payload.status || prev.status,
    };
    return;
  }
  segments.push({
    type: "tool",
    text: payload.toolName ? `工具 ${payload.toolName}` : "工具执行",
    toolName: payload.toolName,
    toolUseId: payload.toolUseId,
    status: payload.status,
    output: clean,
  });
}

function finalizeToolStatuses(segments: ContentSegment[]): void {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.type !== "tool") {
      continue;
    }
    if (!segment.status || segment.status === "pending" || segment.status === "running") {
      segments[index] = {
        ...segment,
        status: "completed",
      };
    }
  }
}

async function runClaudeChat(
  message?: string,
  onProgress?: (snapshot: ChatProgressSnapshot) => void,
  abortController?: AbortController
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
  const segments: ContentSegment[] = [];
  let streamedReply = "";

  const emitProgress = (): void => {
    if (!onProgress) {
      return;
    }
    const rendered = buildRenderedContent(segments, streamedReply);
    onProgress({
      reply: streamedReply,
      trace: trace.map((item) => ({ ...item })),
      rendered,
      segments: segments.map((item) => ({ ...item })),
    });
  };

  const options = buildClaudeOptions();
  options.includePartialMessages = true;
  options.agentProgressSummaries = true;
  options.abortController = abortController;
  emitProgress();

  try {
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
            const text = `准备调用工具 ${block.name}${inputPreview ? `，参数：${inputPreview}` : ""}`;
            const toolUseId =
              "id" in block && typeof block.id === "string" ? block.id : undefined;
            pushTrace(trace, "tool", text);
            upsertToolSegment(segments, {
              text,
              toolName: block.name,
              toolUseId,
              status: "pending",
            });
            emitProgress();
            continue;
          }
          if (block.type === "text" && typeof block.text === "string" && !streamedReply) {
            appendTextSegment(segments, block.text);
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
      const text = `工具 ${sdkMessage.tool_name} 执行中（${Math.round(sdkMessage.elapsed_time_seconds)}s）`;
      pushTrace(trace, "tool", text);
      upsertToolSegment(segments, {
        text,
        toolName: sdkMessage.tool_name,
        toolUseId: sdkMessage.tool_use_id,
        status: "running",
      });
      emitProgress();
      continue;
    }

    if (sdkMessage.type === "tool_use_summary") {
      pushTrace(trace, "tool", sdkMessage.summary);
      const summaryIds = sdkMessage.preceding_tool_use_ids || [];
      if (summaryIds.length === 1) {
        upsertToolSegment(segments, {
          text: sdkMessage.summary,
          toolUseId: summaryIds[0],
          status: "completed",
        });
      } else {
        upsertToolSegment(segments, {
          text: sdkMessage.summary,
          status: "completed",
        });
      }
      emitProgress();
      continue;
    }

    if (sdkMessage.type === "user") {
      const outputText = extractToolOutput(sdkMessage.tool_use_result);
      if (outputText) {
        appendToolOutput(segments, {
          output: outputText,
          toolUseId: sdkMessage.parent_tool_use_id || undefined,
          status: "completed",
        });
        emitProgress();
      }
      continue;
    }

    if (sdkMessage.type === "system") {
      if (sdkMessage.subtype === "task_started") {
        const text = `任务开始：${sdkMessage.description}`;
        pushTrace(trace, "tool", text);
        upsertToolSegment(segments, { text, toolUseId: sdkMessage.tool_use_id, status: "pending" });
        emitProgress();
      }
      if (sdkMessage.subtype === "task_progress") {
        const text = `任务进度：${sdkMessage.description}`;
        pushTrace(trace, "tool", text);
        upsertToolSegment(segments, { text, toolUseId: sdkMessage.tool_use_id, status: "running" });
        emitProgress();
      }
      if (sdkMessage.subtype === "task_notification") {
        const text = `任务${sdkMessage.status}：${sdkMessage.summary}`;
        const statusMap: Record<"completed" | "failed" | "stopped", ToolStatus> = {
          completed: "completed",
          failed: "failed",
          stopped: "stopped",
        };
        pushTrace(trace, "tool", text);
        upsertToolSegment(segments, {
          text,
          toolUseId: sdkMessage.tool_use_id,
          status: statusMap[sdkMessage.status],
        });
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
        appendTextSegment(segments, event.delta.text);
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
      finalizeToolStatuses(segments);
      if (!segments.some((segment) => segment.type === "text" && segment.text.trim())) {
        appendTextSegment(segments, finalResult);
      }
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
  } catch (error) {
    if (abortController?.signal.aborted) {
      finalizeToolStatuses(segments);
      return {
        reply: streamedReply,
        meta: resultMeta,
        trace,
        rendered: buildRenderedContent(segments, streamedReply),
        segments,
        stopped: true,
      };
    }
    throw error;
  }

  if (!finalResult && !streamedReply) {
    throw new Error("未获取到 Claude 返回内容");
  }

  return {
    reply: finalResult || streamedReply,
    meta: resultMeta,
    trace,
    rendered: buildRenderedContent(segments, finalResult || streamedReply),
    segments,
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

    const abortController = new AbortController();
    activeAbortControllers.set(requestId, abortController);

    try {
      const result = await runClaudeChat(payload?.message, sendSnapshot, abortController);
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: result.stopped ? "stopped" : "done" });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务异常";
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: "error", error: message });
      }
      return { error: message };
    } finally {
      activeAbortControllers.delete(requestId);
    }
  }
);

ipcMain.handle("chat:stop", async (_event, payload?: { requestId?: string }) => {
  const requestId = (payload?.requestId || "").trim();
  if (!requestId) {
    return { ok: false, error: "缺少 requestId" };
  }
  const controller = activeAbortControllers.get(requestId);
  if (!controller) {
    return { ok: false, error: "未找到可中断的请求" };
  }
  controller.abort();
  return { ok: true };
});

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
