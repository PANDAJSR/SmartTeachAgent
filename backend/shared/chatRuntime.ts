import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeOptions } from "../claudeOptions";
import { buildMcpServers, readAppConfig } from "./appConfig";
import {
  appendTextSegment,
  appendToolOutput,
  appendTrace,
  buildPromptWithHistory,
  buildRenderedContent,
  extractToolOutput,
  finalizeToolStatuses,
  normalizeHistoryTurns,
  pushTrace,
  sanitizeClaudeOptions,
  toPreview,
  upsertToolSegment,
} from "./chatHelpers";
import { envFilePath } from "./paths";
import type {
  ChatMeta,
  ChatProgressSnapshot,
  ChatResult,
  ContentSegment,
  ToolStatus,
  TraceEntry,
  ChatHistoryTurn,
} from "./chatTypes";

export type {
  ChatMeta,
  ChatProgressSnapshot,
  ChatResult,
  ContentSegment,
  ToolStatus,
  TraceEntry,
  ChatHistoryTurn,
} from "./chatTypes";

type Logger = {
  logInfo: (message: string, extra?: unknown) => void;
  logError: (message: string, error?: unknown) => void;
};

type RunClaudeChatPayload = {
  message?: string;
  history?: ChatHistoryTurn[];
  onProgress?: (snapshot: ChatProgressSnapshot) => void;
  abortController?: AbortController;
  debugTag?: string;
  appendThinkingDelta?: boolean;
};

export async function runClaudeChat(logger: Logger, payload: RunClaudeChatPayload): Promise<ChatResult> {
  const clean = String(payload.message || "").trim();
  if (!clean) {
    throw new Error("message 不能为空");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(`缺少 ANTHROPIC_API_KEY，请先在 ${envFilePath} 中配置后重试`);
  }

  const debugTag = payload.debugTag || "chat";
  const trace: TraceEntry[] = [];
  const segments: ContentSegment[] = [];
  let streamedReply = "";
  let finalResult = "";
  let resultMeta: ChatMeta | null = null;

  const emitProgress = (): void => {
    if (!payload.onProgress) {
      return;
    }
    payload.onProgress({
      reply: streamedReply,
      trace: trace.map((item) => ({ ...item })),
      rendered: buildRenderedContent(segments, streamedReply),
      segments: segments.map((item) => ({ ...item })),
    });
  };

  const prompt = buildPromptWithHistory(clean, payload.history);
  const historyCount = normalizeHistoryTurns(payload.history).length;
  const options = buildClaudeOptions();
  options.includePartialMessages = true;
  options.agentProgressSummaries = true;
  options.abortController = payload.abortController;

  const appConfig = await readAppConfig();
  const mcpServers = buildMcpServers(appConfig);
  if (Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
  }

  logger.logInfo(`[${debugTag}] Claude options`, sanitizeClaudeOptions(options));
  logger.logInfo(`[${debugTag}] 请求上下文历史条数=${historyCount}`);
  emitProgress();

  try {
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
              const toolUseId = "id" in block && typeof block.id === "string" ? block.id : undefined;
              pushTrace(trace, "tool", text);
              upsertToolSegment(segments, { text, toolName: block.name, toolUseId, status: "pending" });
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
        upsertToolSegment(segments, {
          text: sdkMessage.summary,
          toolUseId: summaryIds.length === 1 ? summaryIds[0] : undefined,
          status: "completed",
        });
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
          if (sdkMessage.summary) {
            pushTrace(trace, "thinking", sdkMessage.summary);
          }
          emitProgress();
        }
        if (sdkMessage.subtype === "task_notification") {
          const statusMap: Record<"completed" | "failed" | "stopped", ToolStatus> = {
            completed: "completed",
            failed: "failed",
            stopped: "stopped",
          };
          const text = `任务${sdkMessage.status}：${sdkMessage.summary}`;
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
          if (payload.appendThinkingDelta) {
            appendTrace(trace, "thinking", event.delta.thinking);
          } else {
            pushTrace(trace, "thinking", event.delta.thinking);
          }
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
        logger.logInfo(
          `[${debugTag}] Claude 成功返回，turns=${resultMeta?.turns ?? 0} durationMs=${resultMeta?.durationMs ?? 0} costUsd=${resultMeta?.costUsd ?? 0}`
        );
      } else {
        const detail = sdkMessage.errors?.join("; ") || "Claude Agent 执行失败";
        logger.logError(`[${debugTag}] Claude result 失败，errors=${sdkMessage.errors?.join(" | ") || "empty"}`);
        throw new Error(detail);
      }
    }
  } catch (error) {
    if (payload.abortController?.signal.aborted) {
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
