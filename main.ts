import { app, BrowserWindow, ipcMain } from "electron";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";
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
const envFilePath = path.join(os.homedir(), "SmartTeachAgent", ".env");
const LOG_PREFIX = "[SmartTeachAgent][main]";

function logInfo(message: string, extra?: unknown): void {
  if (typeof extra === "undefined") {
    console.info(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.info(`${LOG_PREFIX} ${message}`, extra);
}

function logError(message: string, error?: unknown): void {
  if (!error) {
    console.error(`${LOG_PREFIX} ${message}`);
    return;
  }
  if (error instanceof Error) {
    console.error(`${LOG_PREFIX} ${message}: ${error.message}`);
    if (error.stack) {
      console.error(`${LOG_PREFIX} stack: ${error.stack}`);
    }
    return;
  }
  console.error(`${LOG_PREFIX} ${message}`, error);
}

const envLoadResult = dotenv.config({ path: envFilePath });
if (envLoadResult.error) {
  logError(`加载 env 失败，路径=${envFilePath}`, envLoadResult.error);
} else {
  logInfo(`已加载 env，路径=${envFilePath}，包含键数量=${Object.keys(envLoadResult.parsed || {}).length}`);
}
logInfo(`ANTHROPIC_API_KEY 已配置=${Boolean(process.env.ANTHROPIC_API_KEY)}`);

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
  abortController?: AbortController,
  debugTag = "chat"
): Promise<ChatResult> {
  const clean = (message || "").trim();
  if (!clean) {
    throw new Error("message 不能为空");
  }

  logInfo(`[${debugTag}] runClaudeChat start，messageLength=${clean.length}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    logError(`[${debugTag}] 缺少 ANTHROPIC_API_KEY`);
    throw new Error(`缺少 ANTHROPIC_API_KEY，请先在 ${envFilePath} 中配置后重试`);
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
      logInfo(
        `[${debugTag}] Claude 成功返回，turns=${resultMeta?.turns ?? 0} durationMs=${resultMeta?.durationMs ?? 0} costUsd=${resultMeta?.costUsd ?? 0}`
      );
    } else {
      const detail = sdkMessage.errors?.join("; ") || "Claude Agent 执行失败";
      logError(`[${debugTag}] Claude result 失败，errors=${sdkMessage.errors?.join(" | ") || "empty"}`);
      throw new Error(detail);
    }
  }
  } catch (error) {
    if (abortController?.signal.aborted) {
      logInfo(`[${debugTag}] 请求被主动中止`);
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
    logError(`[${debugTag}] runClaudeChat 异常`, error);
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
    logInfo("[chat:send] 收到请求");
    try {
      const result = await runClaudeChat(payload?.message, undefined, undefined, "chat:send");
      logInfo("[chat:send] 请求完成");
      return result;
    } catch (error) {
      logError("[chat:send] 请求失败", error);
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
      logError("[chat:send:stream] 缺少 requestId");
      return { error: "缺少 requestId" };
    }
    logInfo(`[chat:send:stream] 收到请求 requestId=${requestId}`);
    const channel = `chat:stream:${requestId}`;
    const sendSnapshot = (snapshot: ChatProgressSnapshot): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: "snapshot", ...snapshot });
      }
    };

    const abortController = new AbortController();
    activeAbortControllers.set(requestId, abortController);
    logInfo(`[chat:send:stream] 已注册中断控制器 requestId=${requestId}`);

    try {
      const result = await runClaudeChat(
        payload?.message,
        sendSnapshot,
        abortController,
        `chat:send:stream:${requestId}`
      );
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: result.stopped ? "stopped" : "done" });
      }
      logInfo(`[chat:send:stream] 请求完成 requestId=${requestId} stopped=${Boolean(result.stopped)}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务异常";
      logError(`[chat:send:stream] 请求失败 requestId=${requestId}`, error);
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, { type: "error", error: message });
      }
      return { error: message };
    } finally {
      activeAbortControllers.delete(requestId);
      logInfo(`[chat:send:stream] 已清理中断控制器 requestId=${requestId}`);
    }
  }
);

ipcMain.handle("chat:stop", async (_event, payload?: { requestId?: string }) => {
  const requestId = (payload?.requestId || "").trim();
  if (!requestId) {
    logError("[chat:stop] 缺少 requestId");
    return { ok: false, error: "缺少 requestId" };
  }
  const controller = activeAbortControllers.get(requestId);
  if (!controller) {
    logError(`[chat:stop] 未找到 requestId=${requestId}`);
    return { ok: false, error: "未找到可中断的请求" };
  }
  controller.abort();
  logInfo(`[chat:stop] 已中断 requestId=${requestId}`);
  return { ok: true };
});

ipcMain.handle("env-file:get-path", async () => envFilePath);

ipcMain.handle("env-file:read", async () => {
  logInfo(`[env-file:read] 读取 ${envFilePath}`);
  try {
    const content = await fs.readFile(envFilePath, "utf-8");
    logInfo(`[env-file:read] 成功，长度=${content.length}`);
    return { path: envFilePath, content };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      logInfo("[env-file:read] 文件不存在，返回空内容");
      return { path: envFilePath, content: "" };
    }
    logError("[env-file:read] 失败", error);
    throw error;
  }
});

ipcMain.handle("env-file:write", async (_event, payload?: { content?: string }) => {
  const content = typeof payload?.content === "string" ? payload.content : "";
  logInfo(`[env-file:write] 写入 ${envFilePath}，长度=${content.length}`);
  await fs.mkdir(path.dirname(envFilePath), { recursive: true });
  await fs.writeFile(envFilePath, content, "utf-8");
  const reloadResult = dotenv.config({ path: envFilePath, override: true });
  if (reloadResult.error) {
    logError("[env-file:write] 写入后重载 env 失败", reloadResult.error);
  } else {
    logInfo(
      `[env-file:write] 写入后重载 env 成功，包含键数量=${Object.keys(reloadResult.parsed || {}).length}`
    );
  }
  logInfo(`[env-file:write] ANTHROPIC_API_KEY 已配置=${Boolean(process.env.ANTHROPIC_API_KEY)}`);
  return { ok: true, path: envFilePath };
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
    logInfo(`加载开发地址 ${devServerUrl}`);
    void win.loadURL(devServerUrl);
  } else {
    logInfo("加载本地构建页面 dist/index.html");
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

void app.whenReady().then(() => {
  logInfo("Electron app ready");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  logInfo("window-all-closed");
  if (process.platform !== "darwin") {
    logInfo("非 macOS，退出应用");
    app.quit();
  }
});
