import "dotenv/config";

import { query } from "@anthropic-ai/claude-agent-sdk";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { buildClaudeOptions } from "./claudeOptions";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "claude-agent-sdk-demo" });
});

type ChatRequestBody = {
  message?: string;
};

type TraceEntry = {
  type: "tool" | "thinking";
  text: string;
};

type ContentSegment = {
  type: "text" | "tool";
  text: string;
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

function pushToolSegment(segments: ContentSegment[], text: string): void {
  const clean = text.trim();
  if (!clean) {
    return;
  }
  const prev = segments[segments.length - 1];
  if (prev && prev.type === "tool" && prev.text === clean) {
    return;
  }
  segments.push({ type: "tool", text: clean });
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
      blocks.push(`> [工具调用] ${segment.text}`);
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

app.post(
  "/api/chat",
  async (req: Request<unknown, unknown, ChatRequestBody>, res: Response) => {
    const message = (req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({ error: "message 不能为空" });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: "缺少 ANTHROPIC_API_KEY，请先在 .env 中配置后重试",
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

      const options = buildClaudeOptions();
      options.includePartialMessages = true;

      for await (const sdkMessage of query({ prompt: message, options })) {
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
                pushTrace(trace, "tool", text);
                pushToolSegment(segments, text);
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
          pushToolSegment(segments, text);
          continue;
        }

        if (sdkMessage.type === "tool_use_summary") {
          pushTrace(trace, "tool", sdkMessage.summary);
          pushToolSegment(segments, sdkMessage.summary);
          continue;
        }

        if (sdkMessage.type === "system") {
          if (sdkMessage.subtype === "task_started") {
            const text = `任务开始：${sdkMessage.description}`;
            pushTrace(trace, "tool", text);
            pushToolSegment(segments, text);
          }
          if (sdkMessage.subtype === "task_progress") {
            const text = `任务进度：${sdkMessage.description}`;
            pushTrace(trace, "tool", text);
            pushToolSegment(segments, text);
            if (sdkMessage.summary) {
              pushTrace(trace, "thinking", sdkMessage.summary);
            }
          }
          if (sdkMessage.subtype === "task_notification") {
            const text = `任务${sdkMessage.status}：${sdkMessage.summary}`;
            pushTrace(trace, "tool", text);
            pushToolSegment(segments, text);
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
          if (!segments.some((segment) => segment.type === "text" && segment.text.trim())) {
            appendTextSegment(segments, finalResult);
          }
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

      return res.json({
        reply: finalResult,
        rendered: buildRenderedContent(segments, finalResult),
        segments,
        meta: resultMeta,
        trace,
      });
    } catch (error) {
      console.error("[api/chat] error:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "服务异常",
      });
    }
  }
);

app.listen(port, () => {
  console.log(`Claude Agent Demo backend running at http://localhost:${port}`);
});
