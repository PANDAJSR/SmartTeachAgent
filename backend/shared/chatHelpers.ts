import { buildClaudeOptions } from "../claudeOptions";
import type { ChatHistoryTurn, ContentSegment, ToolStatus, TraceEntry } from "./chatTypes";

const MAX_HISTORY_TURNS = 24;

export function toPreview(value: unknown): string {
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

export function pushTrace(trace: TraceEntry[], type: TraceEntry["type"], text: string): void {
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

export function appendTrace(trace: TraceEntry[], type: TraceEntry["type"], delta: string): void {
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

function findLatestToolSegmentIndex(segments: ContentSegment[], toolUseId?: string, toolName?: string): number {
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

export function upsertToolSegment(
  segments: ContentSegment[],
  payload: { text: string; toolUseId?: string; toolName?: string; status?: ToolStatus }
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
  segments.push({
    type: "tool",
    text: clean,
    toolName: payload.toolName,
    toolUseId: payload.toolUseId,
    status: payload.status,
  });
}

export function appendTextSegment(segments: ContentSegment[], delta: string): void {
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

export function extractToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractToolOutput(item))
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n");
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

export function appendToolOutput(
  segments: ContentSegment[],
  payload: { output: string; toolUseId?: string; toolName?: string; status?: ToolStatus }
): void {
  const clean = payload.output.trim();
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

export function finalizeToolStatuses(segments: ContentSegment[]): void {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.type !== "tool") {
      continue;
    }
    if (!segment.status || segment.status === "pending" || segment.status === "running") {
      segments[index] = { ...segment, status: "completed" };
    }
  }
}

export function buildRenderedContent(segments: ContentSegment[], fallbackReply: string): string {
  const blocks: string[] = [];
  for (const segment of segments) {
    if (segment.type === "tool") {
      const toolBlock = segment.output ? `${segment.text}\n\n工具输出：\n${segment.output}` : segment.text;
      blocks.push(`> [工具调用] ${toolBlock}`);
      continue;
    }
    if (segment.text) {
      blocks.push(segment.text);
    }
  }
  return blocks.join("\n\n").trim() || fallbackReply.trim();
}

export function normalizeHistoryTurns(history?: ChatHistoryTurn[]): ChatHistoryTurn[] {
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

export function buildPromptWithHistory(message: string, history?: ChatHistoryTurn[]): string {
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

export function sanitizeClaudeOptions(options: ReturnType<typeof buildClaudeOptions>): Record<string, unknown> {
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
    mcpServersCount:
      options.mcpServers && typeof options.mcpServers === "object" ? Object.keys(options.mcpServers).length : 0,
  };
}
