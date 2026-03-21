import { query } from "@anthropic-ai/claude-agent-sdk";
import cors from "cors";
import express, { type Request, type Response } from "express";
import os from "os";
import path from "path";
import dotenv from "dotenv";
import { buildClaudeOptions } from "./claudeOptions";

const app = express();
const envFilePath = path.join(os.homedir(), "SmartTeachAgent", ".env");
const LOG_PREFIX = "[SmartTeachAgent][server]";

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

function sanitizeClaudeOptions(options: ReturnType<typeof buildClaudeOptions>): Record<string, unknown> {
  return {
    model: options.model || "(default)",
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? false,
    cwd: options.cwd,
    toolsType:
      options.tools && typeof options.tools === "object" && "type" in options.tools
        ? (options.tools as { type?: string }).type
        : "unknown",
    allowedToolsCount: Array.isArray(options.allowedTools) ? options.allowedTools.length : 0,
    disallowedToolsCount: Array.isArray(options.disallowedTools) ? options.disallowedTools.length : 0,
  };
}

const envLoadResult = dotenv.config({ path: envFilePath, override: true });
if (envLoadResult.error) {
  logError(`加载 env 失败，路径=${envFilePath}`, envLoadResult.error);
} else {
  logInfo(`已加载 env，路径=${envFilePath}，包含键数量=${Object.keys(envLoadResult.parsed || {}).length}`);
}
logInfo(`ANTHROPIC_API_KEY 已配置=${Boolean(process.env.ANTHROPIC_API_KEY)}`);
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "claude-agent-sdk-demo" });
});

type ChatRequestBody = {
  message?: string;
  history?: ChatHistoryTurn[];
};

type ChatHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

const MAX_HISTORY_TURNS = 24;

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

function normalizeHistoryTurns(history?: ChatHistoryTurn[]): ChatHistoryTurn[] {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter(
      (turn) =>
        turn &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim().length > 0
    )
    .map((turn) => ({ role: turn.role, content: turn.content.trim() }))
    .slice(-MAX_HISTORY_TURNS);
}

function buildPromptWithHistory(message: string, history?: ChatHistoryTurn[]): string {
  const clean = message.trim();
  const turns = normalizeHistoryTurns(history);
  if (!turns.length) {
    return clean;
  }
  const historyBlock = turns
    .map((turn, index) => `${index + 1}. ${turn.role === "assistant" ? "assistant" : "user"}: ${turn.content}`)
    .join("\n");
  return [
    "你正在继续一段对话，请结合历史上下文回答用户最新问题。",
    "",
    "【历史对话】",
    historyBlock,
    "【历史对话结束】",
    "",
    "【用户最新问题】",
    clean,
  ].join("\n");
}

app.post(
  "/api/chat",
  async (req: Request<unknown, unknown, ChatRequestBody>, res: Response) => {
    const message = (req.body?.message || "").trim();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    logInfo(`[${requestId}] 收到 /api/chat，messageLength=${message.length}`);

    if (!message) {
      logError(`[${requestId}] message 为空`);
      return res.status(400).json({ error: "message 不能为空" });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      logError(`[${requestId}] 缺少 ANTHROPIC_API_KEY`);
      return res.status(500).json({
        error: `缺少 ANTHROPIC_API_KEY，请先在 ${envFilePath} 中配置后重试`,
      });
    }

    try {
      let finalResult = "";
      let resultMeta: {
        costUsd?: number;
        durationMs?: number;
        turns?: number;
        stopReason?: string | null;
      } | null = null;
      const trace: TraceEntry[] = [];
      const segments: ContentSegment[] = [];
      let streamedReply = "";
      const prompt = buildPromptWithHistory(message, req.body?.history);
      const historyCount = normalizeHistoryTurns(req.body?.history).length;

      const options = buildClaudeOptions();
      options.includePartialMessages = true;
      logInfo(`[${requestId}] Claude options`, sanitizeClaudeOptions(options));
      logInfo(`[${requestId}] 请求上下文历史条数=${historyCount}`);

      for await (const sdkMessage of query({ prompt, options })) {
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
              }
              if (block.type === "text" && typeof block.text === "string" && !streamedReply) {
                appendTextSegment(segments, block.text);
              }
              if (block.type === "thinking" && typeof block.thinking === "string") {
                pushTrace(trace, "thinking", block.thinking);
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
          }
          continue;
        }

        if (sdkMessage.type === "system") {
          if (sdkMessage.subtype === "task_started") {
            const text = `任务开始：${sdkMessage.description}`;
            pushTrace(trace, "tool", text);
            upsertToolSegment(segments, {
              text,
              toolUseId: sdkMessage.tool_use_id,
              status: "pending",
            });
          }
          if (sdkMessage.subtype === "task_progress") {
            const text = `任务进度：${sdkMessage.description}`;
            pushTrace(trace, "tool", text);
            upsertToolSegment(segments, {
              text,
              toolUseId: sdkMessage.tool_use_id,
              status: "running",
            });
            if (sdkMessage.summary) {
              pushTrace(trace, "thinking", sdkMessage.summary);
            }
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
            pushTrace(trace, "thinking", event.delta.thinking);
          }
          continue;
        }

        if (sdkMessage.type !== "result") {
          continue;
        }

        if (sdkMessage.subtype === "success") {
          finalResult = sdkMessage.result;
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
          logInfo(
            `[${requestId}] Claude 成功返回，turns=${resultMeta?.turns ?? 0} durationMs=${resultMeta?.durationMs ?? 0} costUsd=${resultMeta?.costUsd ?? 0}`
          );
        } else {
          const detail = sdkMessage.errors?.join("; ") || "Claude Agent 执行失败";
          logError(`[${requestId}] Claude result 失败，errors=${sdkMessage.errors?.join(" | ") || "empty"}`);
          logInfo(`[${requestId}] Claude result 失败详情`, {
            subtype: sdkMessage.subtype,
            durationMs:
              "duration_ms" in sdkMessage && typeof sdkMessage.duration_ms === "number"
                ? sdkMessage.duration_ms
                : undefined,
            numTurns:
              "num_turns" in sdkMessage && typeof sdkMessage.num_turns === "number"
                ? sdkMessage.num_turns
                : undefined,
            totalCostUsd:
              "total_cost_usd" in sdkMessage && typeof sdkMessage.total_cost_usd === "number"
                ? sdkMessage.total_cost_usd
                : undefined,
            stopReason:
              "stop_reason" in sdkMessage && typeof sdkMessage.stop_reason !== "undefined"
                ? sdkMessage.stop_reason
                : undefined,
            hasResultText:
              "result" in sdkMessage && typeof sdkMessage.result === "string"
                ? sdkMessage.result.length > 0
                : false,
          });
          throw new Error(detail);
        }
      }

      if (!finalResult) {
        logError(`[${requestId}] 未获取到 Claude 返回内容`);
        throw new Error("未获取到 Claude 返回内容");
      }

      logInfo(`[${requestId}] /api/chat 成功返回`);
      return res.json({
        reply: finalResult,
        rendered: buildRenderedContent(segments, finalResult),
        segments,
        meta: resultMeta,
        trace,
      });
    } catch (error) {
      logError(`[${requestId}] /api/chat 异常`, error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "服务异常",
      });
    }
  }
);

app.listen(port, () => {
  logInfo(`Claude Agent Demo backend running at http://localhost:${port}`);
});
